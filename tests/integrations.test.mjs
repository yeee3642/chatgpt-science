import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { createHash } from 'node:crypto';
import {
  searchLiterature, testConnection, callMcpTool, IntegrationManager,
  storageList, storageDownload, storageUpload, createSkill, discoverSkills,
} from '../server/integrations.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'science-integrations-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

const crossref = { message: { items: [{ DOI: '10.1000/example', title: ['An <i>important</i> result'], author: [{ given: 'Ada', family: 'Lovelace' }], published: { 'date-parts': [[2024]] }, abstract: '<jats:p>Evidence &amp; analysis.</jats:p>' }] } };
const atom = '<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>http://arxiv.org/abs/2601.12345</id><title>Second result</title><author><name>Grace Hopper</name></author><published>2026-01-12</published><summary>A clear &lt;summary&gt;.</summary></entry></feed>';

test('literature normalizes both sources and retries a transient GET only once', async () => {
  let crossrefCalls = 0, arxivCalls = 0;
  const results = await searchLiterature('single cell', { fetchImpl: async (url, options) => {
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal);
    if (String(url).includes('crossref')) {
      crossrefCalls++;
      if (crossrefCalls === 1) return new Response('busy', { status: 503 });
      return Response.json(crossref);
    }
    arxivCalls++;
    return new Response(atom);
  } });
  assert.equal(crossrefCalls, 2);
  assert.equal(arxivCalls, 1);
  assert.equal(results.length, 2);
  assert.deepEqual(results[0].authors, ['Ada Lovelace']);
  assert.equal(results[0].title, 'An important result');
  assert.equal(results[0].abstract, 'Evidence & analysis.');
  assert.equal(results[1].year, 2026);
  assert.equal(results[1].url, 'https://arxiv.org/abs/2601.12345');
});

test('literature rejects malformed input and reports partial or total provider failure', async () => {
  let calls = 0;
  const options = { fetchImpl: async () => { calls++; return new Response('no', { status: 400 }); } };
  await assert.rejects(searchLiterature('x', options), /at least two/);
  await assert.rejects(searchLiterature('x'.repeat(501), options), /500/);
  assert.equal(calls, 0);
  await assert.rejects(searchLiterature('valid query', options), /Literature search unavailable/);
  assert.equal(calls, 2, 'permanent failures must not retry');
  const warnings = [];
  const results = await searchLiterature('valid query', { onWarning: text => warnings.push(text), fetchImpl: async url => String(url).includes('crossref') ? Response.json(crossref) : new Response('no', { status: 403 }) });
  assert.equal(results.length, 1);
  assert.equal(warnings.length, 1);
});

test('real MCP HTTP transport initializes, lists and calls only advertised tools, redacting credentials', async t => {
  let toolCalls = 0;
  const server = http.createServer(async (request, response) => {
    if (request.method === 'GET') { response.writeHead(405); response.end(); return; }
    if (request.method === 'DELETE') { response.writeHead(200); response.end(); return; }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const message = JSON.parse(Buffer.concat(chunks).toString());
    if (message.id === undefined) { response.writeHead(202); response.end(); return; }
    let result;
    if (message.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'test', version: '1' } };
    else if (message.method === 'tools/list') result = { tools: [{ name: 'echo', description: 'Echo a value', inputSchema: { type: 'object' } }] };
    else if (message.method === 'tools/call') { toolCalls++; result = { content: [{ type: 'text', text: 'Test secret: fixture-sensitive-token' }] }; }
    else { response.writeHead(400); response.end(); return; }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const connection = { type: 'mcp', config: { url: `http://127.0.0.1:${server.address().port}/mcp`, tokenEnv: 'MCP_TEST_TOKEN' } };
  const options = { environment: { MCP_TEST_TOKEN: 'fixture-sensitive-token' }, timeoutMs: 3000 };
  const diagnostic = await testConnection(connection, options);
  assert.equal(diagnostic.ok, true, diagnostic.message);
  assert.equal(diagnostic.tools[0].name, 'echo');
  assert.equal(toolCalls, 0, 'connection tests never call tools');
  await assert.rejects(callMcpTool(connection, { name: 'not-advertised' }, options), /not advertised/);
  assert.equal(toolCalls, 0);
  const result = await callMcpTool(connection, { name: 'echo', arguments: { text: 'hello' } }, options);
  assert.equal(toolCalls, 1);
  assert.ok(!JSON.stringify(result).includes('fixture-sensitive-token'));
});

test('MCP client closes on failure and never retries a side-effecting tool', async () => {
  let closed = 0, calls = 0;
  await assert.rejects(callMcpTool({ type: 'mcp', config: { url: 'https://example.com/mcp' } }, { name: 'write', arguments: {} }, {
    mcpFactory: async () => ({ listTools: async () => ({ tools: [{ name: 'write' }] }), callTool: async () => { calls++; throw new Error('uncertain outcome'); }, close: async () => { closed++; } }),
  }), /uncertain outcome/);
  assert.equal(calls, 1);
  assert.equal(closed, 1);
});

test('read-only MCP policy uses the active client advertisement before calling', async () => {
  let calls = 0, closes = 0;
  const connection = { type: 'mcp', config: { url: 'https://example.com/mcp' } };
  for (const annotations of [undefined, { readOnlyHint: false }, { readOnlyHint: true }]) {
    const options = { mcpFactory: async () => ({
      listTools: async () => ({ tools: [{ name: 'inspect', annotations }] }),
      callTool: async () => { calls++; return { content: [] }; },
      close: async () => { closes++; },
    }) };
    const result = callMcpTool(connection, { name: 'inspect', requireReadOnly: true }, options);
    if (annotations?.readOnlyHint) await result;
    else await assert.rejects(result, /requires a tool advertised as read-only/);
  }
  assert.equal(calls, 1);
  assert.equal(closes, 3);
});

test('local MCP command starts only on explicit test and uses the real stdio transport', async () => {
  const serverSource = `const readline = require('node:readline');
readline.createInterface({input:process.stdin}).on('line', line => {
  const m = JSON.parse(line); if(m.id === undefined) return;
  const result = m.method === 'initialize'
    ? {protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'local-fixture',version:'1'}}
    : {tools:[{name:'local_read',inputSchema:{type:'object'}}]};
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');
});`;
  const connection = { id: 'local', type: 'mcp', config: { command: process.execPath, args: ['-e', serverSource] } };
  const manager = new IntegrationManager({ connections: [connection] });
  assert.equal(manager.connections.size, 0, 'constructor does not connect or spawn');
  const result = await manager.testConnection('local');
  assert.equal(result.ok, true, result.message);
  assert.equal(result.tools[0].name, 'local_read');
});

test('MCP OAuth uses SDK discovery, dynamic registration, state, PKCE and memory-only tokens', async t => {
  let base, expectedChallenge, registrations = 0, exchanges = 0, calls = 0;
  const token = 'oauth-access-fixture-sensitive', refresh = 'oauth-refresh-fixture-sensitive';
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, base);
    const json = value => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };
    if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
      json({ resource: `${base}/mcp`, authorization_servers: [base], scopes_supported: ['science.read'] }); return;
    }
    if (url.pathname.startsWith('/.well-known/oauth-authorization-server')) {
      json({ issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register`, response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'] }); return;
    }
    if (url.pathname === '/authorize') { response.writeHead(500); response.end('Tests must never open the authorization page'); return; }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    if (url.pathname === '/register') {
      registrations++;
      const metadata = JSON.parse(body);
      assert.equal(metadata.token_endpoint_auth_method, 'none');
      json({ ...metadata, client_id: 'fixture-client', client_id_issued_at: 1 }); return;
    }
    if (url.pathname === '/token') {
      exchanges++;
      const values = new URLSearchParams(body);
      assert.equal(values.get('grant_type'), 'authorization_code');
      assert.equal(values.get('code'), 'fixture-code');
      assert.equal(values.get('client_id'), 'fixture-client');
      assert.equal(createHash('sha256').update(values.get('code_verifier')).digest('base64url'), expectedChallenge);
      json({ access_token: token, token_type: 'Bearer', refresh_token: refresh, expires_in: 3600, scope: 'science.read' }); return;
    }
    if (url.pathname === '/mcp') {
      if (request.headers.authorization !== `Bearer ${token}`) {
        response.writeHead(401, { 'WWW-Authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"` }); response.end(); return;
      }
      if (request.method === 'GET') { response.writeHead(405); response.end(); return; }
      if (request.method === 'DELETE') { response.writeHead(200); response.end(); return; }
      const message = JSON.parse(body);
      if (message.id === undefined) { response.writeHead(202); response.end(); return; }
      let result;
      if (message.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'oauth-fixture', version: '1' } };
      else if (message.method === 'tools/list') result = { tools: [{ name: 'read_data', inputSchema: { type: 'object' } }] };
      else if (message.method === 'tools/call') { calls++; result = { content: [{ type: 'text', text: `${token} ${refresh}` }] }; }
      json({ jsonrpc: '2.0', id: message.id, result }); return;
    }
    response.writeHead(404); response.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const connection = { id: 'oauth', type: 'mcp', config: { url: `${base}/mcp`, authMode: 'oauth', scope: 'science.read' } };
  const manager = new IntegrationManager({ connections: [connection] });
  assert.equal((await manager.testConnection('oauth')).status, 'authorization_required');
  const start = await manager.beginMcpOAuth('oauth', { redirectUrl: 'http://127.0.0.1:4455/oauth/callback' });
  assert.deepEqual(Object.keys(start), ['authUrl']);
  const authorize = new URL(start.authUrl);
  assert.equal(authorize.pathname, '/authorize');
  assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
  assert.match(authorize.searchParams.get('state'), /^[a-f0-9]{64}$/);
  expectedChallenge = authorize.searchParams.get('code_challenge');
  assert.equal(registrations, 1);
  assert.equal(manager.getMcpOAuthStatus('oauth').status, 'pending');
  await assert.rejects(manager.completeMcpOAuth({ code: 'fixture-code', state: '0'.repeat(64) }), /Invalid or expired/);
  assert.equal(exchanges, 0, 'state mismatch is rejected before token endpoint access');
  const state = authorize.searchParams.get('state');
  assert.deepEqual(await manager.completeMcpOAuth({ code: 'fixture-code', state }), { ok: true, connectionId: 'oauth' });
  assert.equal(exchanges, 1);
  assert.equal(manager.getMcpOAuthStatus('oauth').status, 'authorized');
  assert.equal(manager.getMcpOAuthStatus('oauth').tokenStorage, 'memory');
  assert.equal((await manager.testConnection('oauth')).ok, true);
  assert.equal(calls, 0, 'authentication and test never execute an MCP tool');
  const result = await manager.callMcpTool('oauth', { name: 'read_data', arguments: {} });
  assert.equal(calls, 1);
  assert.ok(!JSON.stringify(result).includes(token));
  assert.ok(!JSON.stringify(result).includes(refresh));
  assert.ok(!JSON.stringify(manager).includes(token));
  assert.ok(!JSON.stringify(connection).includes(token));
  await assert.rejects(manager.completeMcpOAuth({ code: 'fixture-code', state }), /Invalid or expired/);
  assert.equal(exchanges, 1);
  const restarted = new IntegrationManager({ connections: [connection] });
  assert.equal(restarted.getMcpOAuthStatus('oauth').status, 'disconnected');
  assert.equal((await restarted.testConnection('oauth')).status, 'authorization_required');
});

test('OAuth binds state to one unchanged connection and rejects non-loopback callbacks', async () => {
  let exchanges = 0;
  const connection = { id: 'oauth', type: 'mcp', config: { url: 'https://example.com/mcp' } };
  const manager = new IntegrationManager({ connections: [connection], oauthAuth: async (provider, options) => {
    if (options.authorizationCode) { exchanges++; throw new Error('must not exchange'); }
    provider.saveCodeVerifier('fixture-verifier');
    provider.redirectToAuthorization(new URL(`https://example.com/authorize?state=${provider.state()}&code_challenge_method=S256&code_challenge=fixture`));
    return 'REDIRECT';
  } });
  await assert.rejects(manager.beginMcpOAuth('oauth', { redirectUrl: 'https://example.net/oauth/callback' }), /loopback/);
  const start = await manager.beginMcpOAuth('oauth', { redirectUrl: 'http://127.0.0.1:4455/oauth/callback' });
  connection.config.url = 'https://different.example.com/mcp';
  await assert.rejects(manager.completeMcpOAuth({ code: 'not-exchanged', state: new URL(start.authUrl).searchParams.get('state') }), /settings changed/);
  assert.equal(exchanges, 0);
  assert.equal(manager.getMcpOAuthStatus('oauth').status, 'disconnected');
});

test('legacy SSE MCP transport performs a real local handshake with explicit headers', async t => {
  let stream, messages = 0;
  const server = http.createServer(async (request, response) => {
    assert.equal(request.headers.authorization, 'Bearer sse-fixture-secret');
    if (request.method === 'GET') {
      stream = response;
      response.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive', 'Cache-Control': 'no-cache' });
      response.write('event: endpoint\ndata: /messages\n\n'); return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const message = JSON.parse(Buffer.concat(chunks).toString());
    response.writeHead(202); response.end();
    if (message.id === undefined) return;
    messages++;
    const result = message.method === 'initialize'
      ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'sse-fixture', version: '1' } }
      : { tools: [{ name: 'legacy_read', inputSchema: { type: 'object' } }] };
    stream.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n\n`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const diagnostic = await testConnection({ type: 'mcp', config: { url: `http://127.0.0.1:${server.address().port}/sse`, transport: 'sse', tokenEnv: 'SSE_TOKEN' } }, { environment: { SSE_TOKEN: 'sse-fixture-secret' }, timeoutMs: 3000 });
  assert.equal(diagnostic.ok, true, diagnostic.message);
  assert.equal(diagnostic.tools[0].name, 'legacy_read');
  assert.equal(messages, 2);
});

test('model probe is GET only, never follows a redirect and distinguishes reachability from inference', async () => {
  const options = { environment: { MODEL_KEY: 'private-value' }, fetchImpl: async (url, init) => {
    assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'error'); assert.equal(init.headers['x-api-key'], 'private-value');
    return new Response('{}', { status: 200 });
  } };
  const result = await testConnection({ type: 'model', config: { healthUrl: 'https://example.com/health', apiKeyEnv: 'MODEL_KEY' } }, options);
  assert.equal(result.status, 'reachable');
  assert.match(result.message, /not been tested/);
  const missing = await testConnection({ type: 'model', config: { url: 'https://example.com/health', tokenEnv: 'UNSET' } }, { environment: {} });
  assert.equal(missing.ok, false);
  assert.match(missing.message, /not set/);
});

test('SSH probe uses safe argv and does not accept command-like aliases', async () => {
  let calls = 0;
  const runProcess = async (command, args, options) => {
    calls++; assert.equal(command, 'ssh'); assert.ok(args.includes('BatchMode=yes')); assert.ok(args.includes('StrictHostKeyChecking=yes'));
    assert.equal(args.at(-2), 'lab-node'); assert.equal(args.at(-1), 'sh -s');
    assert.match(options.input, /SCIENCE_SSH_OK/);
    return { code: 0, stdout: 'SCIENCE_SSH_OK\nLinux\n', stderr: '' };
  };
  assert.equal((await testConnection({ type: 'ssh', config: { host: 'lab-node' } }, { runProcess })).ok, true);
  assert.equal((await testConnection({ type: 'ssh', config: { host: '-oProxyCommand=bad' } }, { runProcess })).ok, false);
  assert.equal((await testConnection({ type: 'ssh', config: { host: 'lab; echo bad' } }, { runProcess })).ok, false);
  assert.equal(calls, 1);
});

test('SSH jobs persist, encode script over stdin and retrieve real completion/log markers', async t => {
  const root = await fixture(t);
  const calls = [];
  const connections = [{ id: 'lab', type: 'ssh', config: { host: 'lab-node' } }];
  const runProcess = async (command, args, options) => {
    calls.push({ command, args, input: options.input });
    if (options.input.includes('SCIENCE_JOB:')) return { code: 0, stdout: 'SCIENCE_JOB:321\n', stderr: '' };
    return { code: 0, stdout: `REMOTE:321\nEXIT:0\nLOG_stdout:${Buffer.from('computed 42\n').toString('base64')}\nLOG_stderr:\n`, stderr: '' };
  };
  const manager = new IntegrationManager({ connections: () => connections, projectRoots: () => ({ project: root }), jobsRoot: path.join(root, 'managed-jobs'), runProcess });
  const script = "printf '%s\\n' 'user code; $(not interpolated by client)'";
  const job = await manager.submitSshJob('lab', { projectId: 'project', script, timeoutSeconds: 30 });
  assert.equal(job.status, 'submitted');
  assert.equal(calls.length, 1);
  assert.ok(!calls[0].args.join(' ').includes(script));
  assert.ok(calls[0].input.includes(Buffer.from(script).toString('base64')));
  assert.equal(await fs.readFile(path.join(root, 'managed-jobs', job.id, 'task.sh'), 'utf8'), script);
  const restarted = new IntegrationManager({ connections, projectRoots: { project: root }, jobsRoot: path.join(root, 'managed-jobs'), runProcess });
  const complete = await restarted.statusSshJob(job.id);
  assert.equal(complete.status, 'completed');
  assert.equal(complete.exitCode, 0);
  assert.equal(complete.stdout, 'computed 42\n');
  assert.equal((await restarted.listJobs()).length, 1);
  const cancelled = await restarted.cancelSshJob(job.id);
  assert.equal(cancelled.status, 'completed');
  assert.equal(calls.length, 2, 'completed jobs do not send cancellation');
});

test('Slurm lifecycle validates options and cancellation checks ownership', async t => {
  const root = await fixture(t);
  const calls = [];
  const manager = new IntegrationManager({ projectRoots: { project: root }, connections: [{ id: 'slurm', type: 'ssh', config: { host: 'cluster', scheduler: 'slurm', partition: 'gpu', account: 'lab' } }], runProcess: async (_command, _args, options) => {
    calls.push(options.input);
    if (options.input.includes('SCIENCE_JOB:')) return { code: 0, stdout: 'SCIENCE_JOB:789;cluster\n', stderr: '' };
    if (options.input.includes('scancel')) return { code: 0, stdout: '', stderr: '' };
    return { code: 0, stdout: 'REMOTE:789\nSTATE:\nCANCEL:1\nLOG_stdout:\nLOG_stderr:\n', stderr: '' };
  } });
  const job = await manager.submitSshJob('slurm', { projectId: 'project', script: 'echo done' });
  assert.match(calls[0], /sbatch --parsable --job-name=science-/);
  assert.match(calls[0], /--partition=gpu --account=lab/);
  assert.equal((await manager.cancelSshJob(job.id)).status, 'cancelled');
  assert.match(calls[1], /Job ownership could not be verified/);
  manager.registerConnection({ id: 'bad', type: 'ssh', config: { host: 'cluster', scheduler: 'slurm', partition: 'gpu;bad' } });
  await assert.rejects(manager.submitSshJob('bad', { projectId: 'project', script: 'true' }), /Invalid Slurm/);
  await assert.rejects(manager.submitSshJob('slurm', { projectId: 'outside', script: 'true' }), /Unknown registered project/);
});

test('ambiguous SSH submission is persisted as unknown and never retried', async t => {
  const root = await fixture(t);
  let calls = 0;
  const manager = new IntegrationManager({ projectRoots: { p: root }, connections: [{ id: 's', type: 'ssh', config: { host: 'lab' } }], runProcess: async () => { calls++; throw new Error('lost connection'); } });
  await assert.rejects(manager.submitSshJob('s', { projectId: 'p', script: 'true' }), /could not be confirmed/);
  assert.equal(calls, 1);
  assert.equal((await manager.listJobs('p'))[0].status, 'unknown');
});

test('storage paths cannot escape the project and downloads do not overwrite files', async t => {
  const root = await fixture(t);
  const calls = [];
  const connection = { type: 's3', config: { bucket: 'test' } };
  const storageFactory = async () => ({
    test: async () => {}, list: async (prefix, limit) => ({ objects: [{ key: `${prefix}data.csv`, size: 4 }], truncated: false }),
    download: async (key, file) => { calls.push(['download', key]); await fs.writeFile(file, 'a,b\n'); },
    upload: async (key, file) => { calls.push(['upload', key, await fs.readFile(file, 'utf8')]); }, close: () => {},
  });
  await assert.rejects(storageDownload(connection, { key: 'data', destination: '../escape', projectRoot: root, storageFactory }), /inside/);
  assert.equal(calls.length, 0);
  const downloaded = await storageDownload(connection, { key: 'data', destination: 'downloads/data.csv', projectRoot: root, storageFactory });
  assert.equal(downloaded.size, 4);
  await assert.rejects(storageDownload(connection, { key: 'data', destination: 'downloads/data.csv', projectRoot: root, storageFactory }), /already exists/);
  const uploaded = await storageUpload(connection, { key: 'copy/data.csv', path: downloaded.path, projectRoot: root, storageFactory });
  assert.equal(uploaded.uploaded, true);
  assert.deepEqual(calls[1], ['upload', 'copy/data.csv', 'a,b\n']);
  assert.equal((await storageList(connection, { prefix: 'test/', storageFactory })).items[0].key, 'test/data.csv');
});

test('skills only inspect SKILL.md in explicit roots and creation refuses traversal/overwrite', async t => {
  const root = await fixture(t), skills = path.join(root, 'skills');
  await createSkill({ name: 'literature-review', description: 'Check references', instructions: 'Read and verify sources.' }, skills);
  await fs.writeFile(path.join(root, 'secret.txt'), 'not a skill');
  const found = await discoverSkills([skills]);
  assert.equal(found.length, 1);
  assert.equal(found[0].name, 'literature-review');
  assert.equal(found[0].description, 'Check references');
  assert.ok(!JSON.stringify(found).includes('Read and verify'), 'discovery does not return instructions');
  await assert.rejects(createSkill({ name: '../outside', instructions: 'x' }, skills), /Skill name/);
  await assert.rejects(createSkill({ name: 'literature-review', instructions: 'replace' }, skills), /EEXIST/);
});

test('Modal status and cancellation use the saved app identity without starting compute in tests', async t => {
  const root = await fixture(t), calls = [];
  let finishRun;
  const manager = new IntegrationManager({ projectRoots: { p: root }, connections: [{ id: 'm', type: 'modal', config: { environment: 'research' } }], runProcess: async (_command, args, options) => {
    calls.push(args);
    if (args[0] === 'run') return new Promise(resolve => { finishRun = resolve; options.onOutput('stdout', 'Running app ap-test123\n'); });
    if (args[1] === 'list') return { code: 0, stdout: JSON.stringify([{ app_id: 'ap-test123', state: 'ephemeral' }]), stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  } });
  const job = await manager.submitModalJob('m', { projectId: 'p', script: 'import modal\napp = modal.App()' });
  assert.equal(job.remoteId, 'ap-test123');
  assert.ok(calls[0].includes('--detach'));
  assert.equal((await manager.statusModalJob(job.id)).status, 'running');
  assert.equal((await manager.cancelModalJob(job.id)).status, 'cancelling');
  assert.deepEqual(calls.at(-1), ['app', 'stop', '--yes', '--env', 'research', 'ap-test123']);
  finishRun({ code: 1, stdout: 'stopped', stderr: '' });
  await new Promise(resolve => setTimeout(resolve, 25));
});
