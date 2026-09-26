import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { CodexBridge, wrapToolContent } from '../server/codex-bridge.mjs';

function fakeProcess(handler = () => {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.received = [];
  child.replied = new Set();
  child.send = message => { if (message.id !== undefined && !message.method) child.replied.add(message.id); child.stdout.write(`${JSON.stringify(message)}\n`); };
  child.kill = () => { child.exitCode = 0; child.emit('exit', 0, null); };
  child.stdin = new Writable({
    write(chunk, _encoding, callback) {
      for (const line of chunk.toString().trim().split('\n')) {
        if (!line) continue;
        const message = JSON.parse(line);
        child.received.push(message);
        if (message.method === 'initialize') queueMicrotask(() => child.send({ id: message.id, result: { userAgent: 'test' } }));
        else handler(message, child);
      }
      callback();
    },
    final(callback) { child.kill(); callback(); },
  });
  return child;
}

function makeBridge(handler, options = {}) {
  const { autoAccount = true, autoConfig = true, ...bridgeOptions } = options;
  const child = fakeProcess((message, transport) => {
    handler?.(message, transport);
    if (transport.replied.has(message.id)) return;
    if (autoAccount && message.method === 'account/read') transport.send({ id: message.id, result: { account: { type: 'chatgpt' }, requiresOpenaiAuth: true } });
    if (autoConfig && message.method === 'config/read') transport.send({ id: message.id, result: { config: {} } });
    if (message.method === 'thread/resume') transport.send({ id: message.id, result: { thread: { id: message.params.threadId } } });
  });
  const bridge = new CodexBridge({ cwd: process.cwd(), transportFactory: async () => child, requestTimeoutMs: 1000, ...bridgeOptions });
  return { bridge, child };
}

test('initializes once, serializes requests, and matches out-of-order responses', async t => {
  const requests = [];
  const { bridge, child } = makeBridge(message => { if (message.id) requests.push(message); }, { autoAccount: false });
  t.after(() => bridge.close());
  await Promise.all([bridge.start(), bridge.start()]);
  assert.equal(child.received.filter(message => message.method === 'initialize').length, 1);
  assert.equal(child.received[0].params.capabilities.experimentalApi, true);
  assert.equal(child.received[1].method, 'initialized');
  assert.ok(child.received.every(message => !('jsonrpc' in message)));
  const account = bridge.account();
  const login = bridge.login();
  await new Promise(resolve => setImmediate(resolve));
  const accountRequest = requests.find(message => message.method === 'account/read');
  const loginRequest = requests.find(message => message.method === 'account/login/start');
  assert.deepEqual(loginRequest.params, { type: 'chatgpt', useHostedLoginSuccessPage: true, appBrand: 'chatgpt' });
  child.send({ id: loginRequest.id, result: { type: 'chatgpt', loginId: 'login-test', authUrl: 'https://auth.openai.com/test' } });
  child.send({ id: accountRequest.id, result: { account: { type: 'chatgpt' } } });
  assert.equal((await account).account.type, 'chatgpt');
  assert.equal((await login).loginId, 'login-test');
});

test('handles fragmented Unicode notifications and final authoritative items', async t => {
  const { bridge, child } = makeBridge();
  t.after(() => bridge.close());
  await bridge.start();
  const event = once(bridge, 'notification');
  const buffer = Buffer.from(JSON.stringify({ method: 'item/agentMessage/delta', params: { delta: '實驗完成' } }) + '\n');
  const split = buffer.indexOf(Buffer.from('實')) + 1;
  child.stdout.write(buffer.subarray(0, split));
  child.stdout.write(buffer.subarray(split));
  assert.equal((await event)[0].params.delta, '實驗完成');
});

test('uses installed schema fields and invokes only registered science tools', async t => {
  const calls = [];
  const definition = { name: 'science_status', description: 'Read science status.', inputSchema: { type: 'object', properties: {} } };
  const { bridge, child } = makeBridge((message, transport) => {
    if (message.method === 'thread/start') transport.send({ id: message.id, result: { thread: { id: 'thread-test' } } });
  }, { toolDefinitions: [definition], toolHandler: async (name, args, context) => { calls.push({ name, args, context }); return { count: 2 }; } });
  t.after(() => bridge.close());
  await bridge.startThread({ instructions: 'Keep experiments reproducible.' });
  const request = child.received.find(message => message.method === 'thread/start');
  assert.equal(request.params.sandbox, 'read-only');
  assert.equal(request.params.approvalPolicy, 'never');
  assert.equal(request.params.config['features.shell_tool'], false);
  assert.equal(request.params.dynamicTools[0].type, 'function');
  child.send({ id: 'tool-a', method: 'item/tool/call', params: { tool: 'science_status', arguments: {}, threadId: 'thread-test', turnId: 'turn-test', callId: 'call-a' } });
  child.send({ id: 'tool-b', method: 'item/tool/call', params: { tool: 'unknown', arguments: {}, threadId: 'thread-test', turnId: 'turn-test', callId: 'call-b' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].context, { threadId: 'thread-test', turnId: 'turn-test' });
  const response = child.received.find(message => message.id === 'tool-a');
  assert.deepEqual(response.result, { contentItems: [{ type: 'inputText', text: '{"count":2}' }], success: true });
  assert.equal(child.received.find(message => message.id === 'tool-b').result.success, false);
});

test('holds user-input requests until answered and expires resolved requests', async t => {
  const { bridge, child } = makeBridge();
  t.after(() => bridge.close());
  await bridge.start();
  const approval = once(bridge, 'approval');
  child.send({ id: 77, method: 'item/tool/requestUserInput', params: { questions: [{ id: 'method', question: 'Which method?' }], threadId: 'thread-1', turnId: 'turn-1' } });
  assert.equal((await approval)[0].id, 77);
  assert.equal(child.received.some(message => message.id === 77), false);
  bridge.respondApproval('77', { answers: { method: { answers: ['A'] } } });
  assert.deepEqual(child.received.at(-1), { id: 77, result: { answers: { method: { answers: ['A'] } } } });
  assert.throws(() => bridge.respondApproval(77, 'accept'), /no longer pending/);
  child.send({ id: 78, method: 'item/tool/requestUserInput', params: { threadId: 'thread-1', turnId: 'turn-1', questions: [] } });
  child.send({ method: 'serverRequest/resolved', params: { threadId: 'thread-1', requestId: 78 } });
  assert.throws(() => bridge.respondApproval(78, 'accept'), /no longer pending/);
});

test('tracks active turns for cancellation and clears completed turns', async t => {
  const { bridge, child } = makeBridge((message, transport) => {
    if (message.method === 'turn/start') transport.send({ id: message.id, result: { turn: { id: 'turn-1', status: 'inProgress' } } });
    if (message.method === 'turn/interrupt') transport.send({ id: message.id, result: {} });
  });
  t.after(() => bridge.close());
  await bridge.resumeThread('thread-1');
  await bridge.send('thread-1', 'Explain this experiment');
  await bridge.interrupt('thread-1');
  assert.deepEqual(child.received.find(message => message.method === 'turn/interrupt').params, { threadId: 'thread-1', turnId: 'turn-1' });
  child.send({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'interrupted' } } });
  assert.deepEqual(await bridge.interrupt('thread-1'), { interrupted: false });
});

test('rejects timed out requests and cleans pending state', async t => {
  const { bridge } = makeBridge(undefined, { requestTimeoutMs: 30, autoAccount: false });
  t.after(() => bridge.close());
  await assert.rejects(bridge.account(), /timed out: account\/read/);
  assert.equal(bridge.pending.size, 0);
});

test('does not resurrect a turn completed in the same stdout chunk as its response', async t => {
  const { bridge } = makeBridge((message, transport) => {
    if (message.method !== 'turn/start') return;
    transport.stdout.write([
      { id: message.id, result: { turn: { id: 'fast-turn', status: 'inProgress' } } },
      { method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'fast-turn', status: 'completed' } } },
    ].map(value => JSON.stringify(value)).join('\n') + '\n');
  });
  t.after(() => bridge.close());
  await bridge.resumeThread('thread-1');
  await bridge.send('thread-1', 'A short request');
  assert.deepEqual(await bridge.interrupt('thread-1'), { interrupted: false });
});

test('closing while a transport is starting terminates only the owned child', async () => {
  let finishTransport;
  const child = fakeProcess();
  const bridge = new CodexBridge({ transportFactory: () => new Promise(resolve => { finishTransport = resolve; }) });
  const starting = bridge.start();
  await bridge.close();
  finishTransport(child);
  await assert.rejects(starting, /closed during startup/);
  assert.equal(child.exitCode, 0);
  assert.equal(bridge.process, null);
  assert.equal(bridge.state, 'stopped');
  assert.equal(child.received.length, 0);
});

test('read-only reviewers disable inherited integrations and cannot call mutating tools', async t => {
  const definitions = [
    { name: 'read_evidence', description: 'Read evidence.', inputSchema: { type: 'object' }, readOnly: true },
    { name: 'write_report', description: 'Write report.', inputSchema: { type: 'object' } },
  ];
  let mutations = 0;
  const { bridge, child } = makeBridge((message, transport) => {
    if (message.method === 'config/read') transport.send({ id: message.id, result: { config: { mcp_servers: { inherited: { enabled: true } }, plugins: { 'some.plugin@test': { enabled: true } } } } });
    if (message.method === 'thread/start' || message.method === 'thread/resume') transport.send({ id: message.id, result: { thread: { id: 'review-thread' } } });
  }, { toolDefinitions: definitions, toolHandler: async () => { mutations++; return {}; } });
  t.after(() => bridge.close());
  await bridge.startThread({ readOnly: true });
  await bridge.resumeThread('review-thread');
  const start = child.received.find(message => message.method === 'thread/start').params;
  const resume = child.received.find(message => message.method === 'thread/resume').params;
  assert.equal(start.sandbox, 'read-only');
  assert.equal(start.approvalPolicy, 'never');
  assert.equal(start.config['features.shell_tool'], false);
  assert.equal(start.config.mcp_servers.inherited.enabled, false);
  assert.equal(start.config.plugins['some.plugin@test'].enabled, false);
  assert.deepEqual(start.dynamicTools.map(tool => tool.name), ['read_evidence']);
  assert.equal(resume.sandbox, 'read-only');
  child.send({ id: 'mutate', method: 'item/tool/call', params: { tool: 'write_report', arguments: {}, threadId: 'review-thread', turnId: 'review-turn', callId: 'review-call' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(mutations, 0);
  assert.equal(child.received.find(message => message.id === 'mutate').result.success, false);
  assert.equal(child.received.some(message => /config\/(value\/write|batchWrite)/.test(message.method)), false);
});

test('collects model pages and attaches extra skill roots without writing config', async t => {
  const { bridge, child } = makeBridge((message, transport) => {
    if (message.method === 'skills/extraRoots/set') transport.send({ id: message.id, result: {} });
    if (message.method === 'model/list') transport.send({ id: message.id, result: message.params.cursor ? { data: [{ id: 'model-b' }], nextCursor: null } : { data: [{ id: 'model-a' }], nextCursor: 'next' } });
  }, { skillsRoot: process.cwd() });
  t.after(() => bridge.close());
  assert.deepEqual((await bridge.models()).map(model => model.id), ['model-a', 'model-b']);
  assert.deepEqual(child.received.find(message => message.method === 'skills/extraRoots/set').params, { extraRoots: [process.cwd()] });
  assert.equal(child.received.some(message => message.method.startsWith('config/')), false);
});

test('ordinary research threads remain isolated while retaining explicit science tools', async t => {
  const definitions = [{ name: 'science_execute', description: 'Run through the workbench execution gate.', inputSchema: { type: 'object' } }];
  let called = false;
  const { bridge, child } = makeBridge((message, transport) => {
    if (message.method === 'config/read') transport.send({ id: message.id, result: { config: { mcp_servers: { 'custom.name': { url: 'https://example.com/mcp', http_headers: { Authorization: 'never-copy-this-header' } } }, plugins: { unrelated: { enabled: true } } } } });
    if (message.method === 'thread/start') transport.send({ id: message.id, result: { thread: { id: 'ordinary-thread' } } });
  }, { toolDefinitions: definitions, toolHandler: async () => { called = true; return { acceptedByProjectGate: true }; } });
  t.after(() => bridge.close());
  await bridge.startThread({ readOnly: false }); await bridge.resumeThread('ordinary-thread', { instructions: 'Updated explicit project memories.' });
  for (const request of child.received.filter(message => ['thread/start', 'thread/resume'].includes(message.method))) {
    assert.equal(request.params.sandbox, 'read-only'); assert.equal(request.params.approvalPolicy, 'never'); assert.equal(request.params.modelProvider, 'openai');
    for (const feature of ['shell_tool', 'browser_use', 'computer_use', 'apps', 'plugins', 'hooks', 'memories', 'multi_agent']) assert.equal(request.params.config[`features.${feature}`], false);
    assert.equal(request.params.config.web_search, 'disabled'); assert.equal(request.params.config['project_doc_max_bytes'], 0);
    assert.deepEqual(request.params.config.mcp_servers['custom.name'], { url: 'https://example.com/mcp', enabled: false });
    assert.equal(JSON.stringify(request.params).includes('never-copy-this-header'), false);
  }
  assert.equal(child.received.find(message => message.method === 'thread/start').params.dynamicTools[0].name, 'science_execute');
  assert.equal(child.received.find(message => message.method === 'thread/resume').params.developerInstructions, 'Updated explicit project memories.');
  child.send({ id: 'controlled-call', method: 'item/tool/call', params: { threadId: 'ordinary-thread', turnId: 'turn-test', callId: 'call-test', tool: 'science_execute', arguments: {} } });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(called, true);
});

test('API-key mode cannot enumerate models or dispatch any model work', async t => {
  const { bridge, child } = makeBridge((message, transport) => {
    if (message.method === 'account/read') transport.send({ id: message.id, result: { account: { type: 'apiKey' }, requiresOpenaiAuth: true } });
  }, { autoAccount: false });
  t.after(() => bridge.close());
  for (const operation of [() => bridge.account(), () => bridge.models(), () => bridge.startThread(), () => bridge.resumeThread('id'), () => bridge.send('id', 'hello')]) {
    await assert.rejects(operation(), error => error.status === 401 && error.code === 'CHATGPT_SIGN_IN_REQUIRED');
  }
  assert.equal(child.received.some(message => ['model/list', 'thread/start', 'thread/resume', 'turn/start'].includes(message.method)), false);
  await assert.rejects(bridge.request('account/login/start', { type: 'apiKey', apiKey: 'not-a-real-key' }), /RPC is unavailable/);
  await assert.rejects(bridge.request('command/exec', { command: ['echo', 'no'] }), /RPC is unavailable/);
});

test('signed-out account state remains readable while generation requires ChatGPT', async t => {
  const { bridge } = makeBridge((message, transport) => {
    if (message.method === 'account/read') transport.send({ id: message.id, result: { account: null, requiresOpenaiAuth: true } });
  }, { autoAccount: false });
  t.after(() => bridge.close());
  assert.equal((await bridge.account()).account, null);
  await assert.rejects(bridge.startThread(), error => error.status === 401);
});

test('native execution and permission requests fail closed instead of bypassing workbench gates', async t => {
  const { bridge, child } = makeBridge(); t.after(() => bridge.close()); await bridge.start();
  let prompts = 0; bridge.on('approval', () => { prompts++; });
  child.send({ id: 'native-command', method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-1', command: 'unrelated command' } });
  child.send({ id: 'native-permission', method: 'item/permissions/requestApproval', params: { threadId: 'thread-1', permissions: { network: { enabled: true } } } });
  child.send({ id: 'native-mcp', method: 'mcpServer/elicitation/request', params: { threadId: 'thread-1', mode: 'url', url: 'https://example.com' } });
  assert.equal(prompts, 0);
  assert.equal(child.received.find(message => message.id === 'native-command').result.decision, 'decline');
  assert.deepEqual(child.received.find(message => message.id === 'native-permission').result.permissions, {});
  assert.equal(child.received.find(message => message.id === 'native-mcp').result.action, 'decline');
});

test('legitimate login notifications pass through and unsupported authorization destinations are rejected', async t => {
  const { bridge, child } = makeBridge((message, transport) => {
    if (message.method === 'account/login/start') transport.send({ id: message.id, result: { type: 'chatgpt', loginId: 'login-1', authUrl: 'https://auth.openai.com/oauth/authorize' } });
  });
  t.after(() => bridge.close()); const notifications = []; bridge.on('notification', event => notifications.push(event));
  await bridge.login();
  child.send({ method: 'account/login/completed', params: { loginId: 'login-1', success: true, error: null } });
  child.send({ method: 'account/updated', params: { authMode: 'chatgpt', planType: 'test' } });
  assert.deepEqual(notifications.map(event => event.method), ['account/login/completed', 'account/updated']);
  const second = makeBridge((message, transport) => {
    if (message.method === 'account/login/start') transport.send({ id: message.id, result: { type: 'chatgpt', loginId: 'login-2', authUrl: 'https://example.com/auth' } });
    if (message.method === 'account/login/cancel') transport.send({ id: message.id, result: {} });
  });
  t.after(() => second.bridge.close());
  await assert.rejects(second.bridge.login(), /unexpected authorization destination/);
  assert.deepEqual(second.child.received.find(message => message.method === 'account/login/cancel').params, { loginId: 'login-2' });
  assert.equal(second.bridge.pendingLogins.size, 0);
});

test('known turn IDs can be interrupted during send completion races', async t => {
  const { bridge, child } = makeBridge((message, transport) => {
    if (message.method === 'turn/interrupt') transport.send({ id: message.id, result: {} });
  });
  t.after(() => bridge.close()); await bridge.start();
  await bridge.interrupt('thread-1', 'turn-known');
  assert.deepEqual(child.received.find(message => message.method === 'turn/interrupt').params, { threadId: 'thread-1', turnId: 'turn-known' });
});

test('login cancellation is scoped to pending flows created by this bridge', async t => {
  const { bridge, child } = makeBridge((message, transport) => {
    if (message.method === 'account/login/start') transport.send({ id: message.id, result: { type: 'chatgpt', loginId: 'own-login', authUrl: 'https://auth.openai.com/oauth/authorize' } });
    if (message.method === 'account/login/cancel') transport.send({ id: message.id, result: {} });
  });
  t.after(() => bridge.close()); await bridge.login();
  await assert.rejects(bridge.cancelLogin('another-app-login'), /no longer pending/);
  await bridge.cancelLogin('own-login');
  assert.deepEqual(child.received.find(message => message.method === 'account/login/cancel').params, { loginId: 'own-login' });
  await assert.rejects(bridge.cancelLogin('own-login'), /no longer pending/);
});

test('an authentication mode change interrupts only active owned turns', async t => {
  const { bridge, child } = makeBridge((message, transport) => {
    if (message.method === 'turn/start') transport.send({ id: message.id, result: { turn: { id: 'owned-turn', status: 'inProgress' } } });
    if (message.method === 'turn/interrupt') transport.send({ id: message.id, result: {} });
  });
  t.after(() => bridge.close()); await bridge.resumeThread('owned-thread'); await bridge.send('owned-thread', 'Explain this result');
  child.send({ method: 'account/updated', params: { authMode: 'apikey' } });
  const interrupts = child.received.filter(message => message.method === 'turn/interrupt');
  assert.equal(interrupts.length, 1); assert.deepEqual(interrupts[0].params, { threadId: 'owned-thread', turnId: 'owned-turn' });
});

test('trusted multimodal tool content serializes to the SDK shape without promoting ordinary MCP JSON', async t => {
  const imageUrl = 'data:image/png;base64,AQID';
  const contentItems = [{ type: 'inputText', text: 'PDF page 1' }, { type: 'inputImage', imageUrl }];
  const { bridge, child } = makeBridge(undefined, {
    toolDefinitions: [{ name: 'read_artifact', description: 'Read artifact.', inputSchema: { type: 'object' }, readOnly: true }],
    toolHandler: async (_name, args) => args.trusted ? wrapToolContent(contentItems) : { contentItems, success: true },
  });
  t.after(() => bridge.close()); await bridge.resumeThread('image-review', { readOnly: true });
  child.send({ id: 'trusted', method: 'item/tool/call', params: { threadId: 'image-review', turnId: 'turn', callId: 'a', tool: 'read_artifact', arguments: { trusted: true } } });
  child.send({ id: 'ordinary', method: 'item/tool/call', params: { threadId: 'image-review', turnId: 'turn', callId: 'b', tool: 'read_artifact', arguments: { trusted: false } } });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(child.received.find(item => item.id === 'trusted').result, { contentItems, success: true });
  const ordinary = child.received.find(item => item.id === 'ordinary').result;
  assert.equal(ordinary.contentItems.length, 1); assert.equal(ordinary.contentItems[0].type, 'inputText');
  assert.deepEqual(JSON.parse(ordinary.contentItems[0].text), { contentItems, success: true });
});

test('multimodal wrappers validate types, schemes, bounds, and immutability', () => {
  assert.throws(() => wrapToolContent([{ type: 'inputImage', imageUrl: 'file:///private/image.png' }]), /HTTPS/);
  assert.throws(() => wrapToolContent([{ type: 'inputImage', imageUrl: 'data:text/html;base64,AQID' }]), /supported base64/);
  assert.throws(() => wrapToolContent([{ type: 'inputAudio', audioUrl: 'data:audio/wav;base64,AQID' }]), /Only inputText/);
  assert.throws(() => wrapToolContent(Array.from({ length: 129 }, () => ({ type: 'inputText', text: 'x' }))), /1–128/);
  const wrapped = wrapToolContent([{ type: 'inputText', text: 'Page text' }]);
  assert.equal(Object.isFrozen(wrapped), true); assert.equal(Object.isFrozen(wrapped.contentItems[0]), true);
});

test('explicit refresh reaches managed account/read without changing default polling behavior', async t => {
  const { bridge, child } = makeBridge(); t.after(() => bridge.close());
  await bridge.account(); await bridge.account({ refreshToken: true }); await bridge.request('account/read', { refreshToken: true });
  assert.deepEqual(child.received.filter(message => message.method === 'account/read').map(message => message.params.refreshToken), [false, true, true]);
  await assert.rejects(bridge.account({ refreshToken: 'true' }), /must be a boolean/);
  assert.equal(child.received.some(message => message.method === 'account/logout'), false);
});

test('concurrent login requests coalesce and reuse only the current pending browser flow', async t => {
  let starts = 0;
  const { bridge, child } = makeBridge((message, transport) => {
    if (message.method === 'account/login/start') {
      starts++;
      setTimeout(() => transport.send({ id: message.id, result: { type: 'chatgpt', loginId: `login-${starts}`, authUrl: `https://auth.openai.com/oauth/authorize?state=local-test-${starts}` } }), 5);
    }
  });
  t.after(() => bridge.close());
  const [first, duplicate] = await Promise.all([bridge.login(), bridge.login()]);
  assert.equal(starts, 1); assert.equal(first, duplicate); assert.equal(await bridge.login(), first);
  assert.equal(starts, 1);
  child.send({ method: 'account/login/completed', params: { loginId: first.loginId, success: true, error: null } });
  assert.equal(bridge.pendingLoginDetails.size, 0);
  const next = await bridge.login(); assert.equal(starts, 2); assert.notEqual(next.loginId, first.loginId);
});

test('malformed authorization URL cancels its owned flow without exposing the returned value', async t => {
  const { bridge, child } = makeBridge((message, transport) => {
    if (message.method === 'account/login/start') transport.send({ id: message.id, result: { type: 'chatgpt', loginId: 'malformed-flow', authUrl: 'PRIVATE_BAD_URL' } });
    if (message.method === 'account/login/cancel') transport.send({ id: message.id, result: {} });
  });
  t.after(() => bridge.close());
  await assert.rejects(bridge.login(), error => /valid browser URL/.test(error.message) && !error.message.includes('PRIVATE_BAD_URL'));
  assert.equal(child.received.find(message => message.method === 'account/login/cancel').params.loginId, 'malformed-flow');
  assert.equal(bridge.pendingLogins.size, 0);
});

test('close is terminal until explicit reconnect and never logs out the shared Codex account', async () => {
  const transports = [];
  const bridge = new CodexBridge({ transportFactory: async () => { const child = fakeProcess(); transports.push(child); return child; } });
  let notifications = 0; bridge.on('notification', () => { notifications++; });
  await bridge.start();
  await Promise.all([bridge.close(), bridge.close()]);
  assert.equal(transports[0].exitCode, 0); assert.equal(transports.length, 1);
  await assert.rejects(bridge.account(), /closing/); assert.equal(transports.length, 1);
  await bridge.reconnect();
  assert.equal(transports.length, 2); assert.equal(bridge.state, 'ready');
  transports[1].send({ method: 'account/updated', params: { authMode: 'chatgpt' } });
  assert.equal(notifications, 1, 'Existing listeners must survive explicit reconnect.');
  assert.equal(transports.flatMap(child => child.received).some(message => message.method === 'account/logout'), false);
  await bridge.close();
});
