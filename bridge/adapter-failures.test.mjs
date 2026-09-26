/**
 * Tests for the translation layer's failure, cancellation and isolation behaviour.
 *
 * The adapter is inference-only: it borrows a managed ChatGPT account to produce text and
 * tool requests, and must never let that account's native abilities (shell, MCP, image
 * generation, native web search) run on the caller's behalf. Everything here drives a fake
 * bridge, so no Codex process is spawned, no network call is made and no real data
 * directory is touched. Each test gets a throwaway cwd and closes its adapter.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { Adapter, AdapterError } from './adapter.mjs';

const MODEL = 'gpt-5-fake-codex';
let bridgeSeq = 0;

/**
 * Stand-in for CodexBridge. It records everything the adapter asks of it and emits the
 * notifications a scripted turn would produce. Scripts are keyed by JSON-RPC method and
 * run on a timer so they land after the adapter's `await request(...)` resolves, which is
 * the ordering a real bridge produces.
 */
class FakeBridge extends EventEmitter {
  constructor(options, script) {
    super();
    this.options = options;
    this.script = script;
    this.threadId = `thread_${++bridgeSeq}`;
    this.turnId = `turn_${bridgeSeq}`;
    this.requests = [];
    this.startedThreads = [];
    this.approvals = [];
    this.interrupts = [];
    this.closes = 0;
    this.activeTurns = new Map();
  }

  // The catalog bridge and the generation bridge are distinct connections, and the adapter
  // checks the account on each. Scripting them separately is what lets a test reach the
  // generation-time check: a single shared account is refused at the catalog first.
  async account() {
    if (this.options.toolHandler && this.script.generationAccount) return this.script.generationAccount;
    return this.script.account ?? { account: { type: 'chatgpt' } };
  }
  async models() { return this.script.models ?? [{ model: MODEL, displayName: 'Fake Codex', isDefault: true }]; }

  async startThread(params) {
    this.startedThreads.push(params);
    this.activeTurns.set(this.threadId, this.turnId);
    return { thread: { id: this.threadId } };
  }

  async request(method, params) {
    this.requests.push({ method, params });
    const handler = this.script[method];
    if (handler) setTimeout(() => { void handler(this, params); }, 0);
    return {};
  }

  respondApproval(id, decision) { this.approvals.push({ id, decision }); }
  async interrupt(threadId) { this.interrupts.push(threadId); }
  async close() { this.closes += 1; }

  /** Emit a bridge notification, defaulting to this bridge's own thread. */
  notify(method, params = {}) {
    this.emit('notification', { method, params: { threadId: this.threadId, ...params } });
  }

  /** The shape of a plain successful answer: streamed text, then a completed turn. */
  answer(text, itemId = 'item_1') {
    this.notify('item/agentMessage/delta', { itemId, delta: text });
    this.notify('item/completed', { item: { type: 'agentMessage', id: itemId, text } });
    this.notify('turn/completed', { turn: { status: 'completed' } });
  }

  methods() { return this.requests.map(entry => entry.method); }
}

/**
 * Builds an adapter wired to fake bridges. `script` is mutable so a test can change how
 * the next turn behaves. `model` is pinned so the suite does not depend on
 * SCIENCE_CHATGPT_MODEL being unset in the environment.
 */
async function harness(script = {}, options = {}) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'adapter-failures-'));
  const bridges = [];
  const adapter = new Adapter({
    cwd,
    model: MODEL,
    toolBatchMs: 1,
    bridgeFactory: bridgeOptions => {
      const bridge = new FakeBridge(bridgeOptions, script);
      bridges.push(bridge);
      return bridge;
    },
    ...options,
  });
  return {
    adapter,
    script,
    bridges,
    // Generation bridges only; the catalog and web-helper bridges get no toolHandler.
    generation: () => bridges.filter(bridge => bridge.options.toolHandler),
    async dispose() {
      await adapter.close();
      await fs.rm(cwd, { recursive: true, force: true });
    },
  };
}

/** Rejection matcher that refuses to pass just because "something threw". */
function adapterError({ status, type, message }) {
  return error => {
    assert.ok(error instanceof AdapterError, `expected an AdapterError, got ${error?.name}: ${error?.message}`);
    assert.equal(error.status, status, `unexpected status for ${error.message}`);
    if (type) assert.equal(error.type, type);
    if (message) assert.match(error.message, message);
    return true;
  };
}

const body = (overrides = {}) => ({
  model: 'claude-opus-5',
  max_tokens: 64,
  messages: [{ role: 'user', content: 'hello' }],
  ...overrides,
});

const TOOL = {
  name: 'lookup',
  description: 'Ask the caller to look something up.',
  input_schema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
};
const toolBody = (messages, overrides = {}) => ({ model: 'claude-opus-5', max_tokens: 64, tools: [TOOL], messages, ...overrides });

/**
 * Script fragment for a turn that immediately asks the caller to run the one exposed tool.
 * `state.settled` resolves to `{ value }` or `{ error }` so tests can assert on what the
 * bridge-side tool promise eventually did, including being rejected on teardown.
 */
function toolRequestingTurn(args = JSON.stringify({ q: 'x' })) {
  const state = { settled: null };
  return {
    state,
    handler(bridge) {
      state.settled = bridge.options.toolHandler('external_tool_0', args)
        .then(value => ({ value }), error => ({ error }));
    },
  };
}

/** Drives one request to a tool_use stop and returns the emitted tool_use block. */
async function untilToolUse(h) {
  const first = await h.adapter.messages(toolBody([{ role: 'user', content: 'hi' }]));
  assert.equal(first.stop_reason, 'tool_use', 'setup expected the model to request the external tool');
  const toolUse = first.content.find(block => block.type === 'tool_use');
  assert.ok(toolUse, 'setup expected a tool_use block');
  return toolUse;
}

/** Continuation body carrying the result for `toolUse`, plus optional extra user text. */
function continuation(toolUse, extra = []) {
  return toolBody([
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: [toolUse] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: 'looked up' }, ...extra] },
  ]);
}

const countTimers = () => process.getActiveResourcesInfo().filter(resource => resource === 'Timeout').length;

// 1. The guard that keeps an API-key Codex login from being driven as if it were the
// managed ChatGPT sign-in this bridge is licensed to borrow. Would catch a regression
// that only warned, or that checked the type after starting a thread.
test('an API-key Codex account is refused with 401 before any thread starts', async t => {
  const h = await harness({ account: { account: { type: 'apiKey' } } });
  t.after(() => h.dispose());

  await assert.rejects(
    () => h.adapter.messages(body()),
    adapterError({ status: 401, type: 'authentication_error', message: /managed ChatGPT account/ }),
  );
  assert.equal(h.generation().length, 0, 'generation must not begin for a non-ChatGPT account');
  assert.deepEqual(h.bridges[0].startedThreads, [], 'the catalog probe must not open a thread');
});

// The catalog check at adapter.mjs:295 and the generation check at adapter.mjs:468 are
// separate guards. Scripting one account for both means the catalog refuses first and the
// generation guard is never reached — so it could be deleted with every test still passing.
// Here the catalog accepts a ChatGPT account and only the generation connection is not one.
test('a non-ChatGPT generation account is refused even when the catalog account is valid', async t => {
  // The turn is scripted to succeed so that if the guard were removed the request would
  // complete quickly and this test would fail fast, rather than hanging until the deadline.
  const h = await harness({
    account: { account: { type: 'chatgpt' } },
    generationAccount: { account: { type: 'apiKey' } },
    'turn/start'(bridge) { bridge.answer('should never be reached'); },
  });
  t.after(() => h.dispose());

  // The catalog must genuinely succeed, or this test collapses back into the catalog check.
  assert.ok((await h.adapter.models()).data.length > 0, 'catalog must be reachable for this to test the generation guard');

  await assert.rejects(
    () => h.adapter.messages(body()),
    // The generation guard's wording differs from the catalog's, so matching it proves which
    // of the two guards fired.
    adapterError({ status: 401, type: 'authentication_error', message: /required for generation/i }),
  );
  assert.deepEqual(h.generation().flatMap(bridge => bridge.startedThreads), [],
    'no thread may start once the generation account is rejected');
});

// Inference-only depends on the thread being opened read-only: the real CodexBridge otherwise
// defaults to a writable workspace. Nothing asserted this, so removing readOnly:true from
// adapter.mjs:472 left the whole suite green.
test('the generation thread is opened read-only and ephemeral', async t => {
  const h = await harness({ 'turn/start'(bridge) { bridge.answer('done'); } });
  t.after(() => h.dispose());
  await h.adapter.messages(body());

  const [started] = h.generation().flatMap(bridge => bridge.startedThreads);
  assert.ok(started, 'a generation thread must have started');
  assert.equal(started.readOnly, true, 'a writable thread would let the borrowed account touch the filesystem');
  assert.equal(started.ephemeral, true, 'the thread must not persist beyond this request');
  assert.match(started.baseInstructions, /inference-only|Do not use native shell/i,
    'the isolation instructions must be sent with the thread');
});

test('the 401 also blocks the account and model endpoints', async t => {
  const h = await harness({ account: { account: { type: 'apiKey' } } });
  t.after(() => h.dispose());

  await assert.rejects(() => h.adapter.models(), adapterError({ status: 401, type: 'authentication_error' }));
  await assert.rejects(() => h.adapter.account(), adapterError({ status: 401, type: 'authentication_error' }));
});

// 2. The inference-only boundary. Codex announcing any native activity must abort the
// response rather than let shell/MCP/image/web output reach a caller that believes it is
// talking to a text model. Each type is checked so removing one from the list is caught.
for (const type of ['commandExecution', 'mcpToolCall', 'collabToolCall', 'imageGeneration', 'webSearch']) {
  test(`a native ${type} item aborts the response`, async t => {
    const h = await harness({
      'turn/start'(bridge) {
        bridge.notify('item/started', { item: { type, id: 'native_1' } });
        bridge.answer('native output the caller must never see');
      },
    });
    t.after(() => h.dispose());

    await assert.rejects(
      () => h.adapter.messages(body()),
      adapterError({ status: 502, type: 'api_error', message: /native tool activity was blocked/ }),
    );
  });
}

test('the blocked native turn is torn down, not left running', async t => {
  const h = await harness({
    'turn/start'(bridge) { bridge.notify('item/started', { item: { type: 'commandExecution', id: 'native_1' } }); },
  });
  t.after(() => h.dispose());

  await assert.rejects(() => h.adapter.messages(body()), adapterError({ status: 502 }));
  const bridge = h.generation()[0];
  assert.deepEqual(bridge.interrupts, [bridge.threadId], 'the Codex turn must be interrupted');
  assert.equal(bridge.closes, 1, 'the generation bridge must be closed');
  assert.equal(h.adapter.contexts.size, 0, 'the failed conversation must not stay registered');
});

// The other half of the same boundary: reasoning items are ignored by design, so the
// block above must not fire on them. Catches a too-broad blocklist that would make every
// reasoning turn fail.
test('reasoning items are ignored rather than treated as native activity', async t => {
  const h = await harness({
    'turn/start'(bridge) {
      bridge.notify('item/started', { item: { type: 'reasoning', id: 'reason_1' } });
      bridge.notify('item/reasoning/delta', { itemId: 'reason_1', delta: 'private chain of thought' });
      bridge.answer('visible answer');
    },
  });
  t.after(() => h.dispose());

  const result = await h.adapter.messages(body());
  assert.equal(result.stop_reason, 'end_turn');
  assert.deepEqual(result.content, [{ type: 'text', text: 'visible answer' }], 'reasoning must not leak into content');
});

// 3. Codex asking for a native permission has no safe answer in inference-only mode: the
// adapter must say no on the wire and fail the response. Catches a regression that
// declined silently and then hung waiting for a turn that will never complete.
test('a native approval request is auto-declined and fails the response', async t => {
  const h = await harness({
    'turn/start'(bridge) { bridge.emit('approval', { id: 'approval_1' }); },
  });
  t.after(() => h.dispose());

  await assert.rejects(
    () => h.adapter.messages(body()),
    adapterError({ status: 403, type: 'permission_error', message: /permission request/ }),
  );
  assert.deepEqual(h.generation()[0].approvals, [{ id: 'approval_1', decision: 'decline' }]);
});

// 4. An upstream error must arrive as a 502 that keeps the diagnostic text, not a generic
// 400 or a swallowed message.
test('an error notification surfaces as a 502 carrying the upstream message', async t => {
  const h = await harness({
    'turn/start'(bridge) { bridge.notify('error', { error: { message: 'usage limit reached for this account' } }); },
  });
  t.after(() => h.dispose());

  await assert.rejects(
    () => h.adapter.messages(body()),
    adapterError({ status: 502, type: 'api_error', message: /usage limit reached for this account/ }),
  );
});

test('an error notification without a message still fails with a 502', async t => {
  const h = await harness({ 'turn/start'(bridge) { bridge.notify('error', {}); } });
  t.after(() => h.dispose());

  await assert.rejects(
    () => h.adapter.messages(body()),
    adapterError({ status: 502, type: 'api_error', message: /Codex generation failed/ }),
  );
});

// 5. A turn that ends in any state other than "completed" must not be dressed up as a
// finished answer. The streamed prefix is deliberately included: the caller must not be
// handed a truncated response as if the model had stopped on purpose.
test('a non-completed turn fails instead of returning the partial answer', async t => {
  const events = [];
  const h = await harness({
    'turn/start'(bridge) {
      bridge.notify('item/agentMessage/delta', { itemId: 'item_1', delta: 'half an ans' });
      bridge.notify('turn/completed', { turn: { status: 'failed' } });
    },
  });
  t.after(() => h.dispose());

  await assert.rejects(
    () => h.adapter.messages(body(), { onEvent: event => events.push(event) }),
    adapterError({ status: 502, type: 'api_error', message: /Codex turn failed/ }),
  );
  const types = events.map(event => event.type);
  assert.ok(types.includes('content_block_delta'), 'the partial text was streamed');
  assert.ok(!types.includes('message_delta'), 'a failed turn must not emit a stop reason');
  assert.ok(!types.includes('message_stop'), 'a failed turn must not close the message');
});

test('a non-completed turn keeps the upstream turn error message', async t => {
  const h = await harness({
    'turn/start'(bridge) {
      bridge.notify('turn/completed', { turn: { status: 'aborted', error: { message: 'model stopped early' } } });
    },
  });
  t.after(() => h.dispose());

  await assert.rejects(
    () => h.adapter.messages(body()),
    adapterError({ status: 502, type: 'api_error', message: /model stopped early/ }),
  );
});

// A revision of already-streamed text cannot be represented over the Anthropic wire
// format, so it must fail loudly rather than silently disagreeing with what was streamed.
test('Codex rewriting already-streamed text fails rather than contradicting the stream', async t => {
  const h = await harness({
    'turn/start'(bridge) {
      bridge.notify('item/agentMessage/delta', { itemId: 'item_1', delta: 'Hello' });
      bridge.notify('item/completed', { item: { type: 'agentMessage', id: 'item_1', text: 'Goodbye' } });
    },
  });
  t.after(() => h.dispose());

  await assert.rejects(
    () => h.adapter.messages(body()),
    adapterError({ status: 502, type: 'api_error', message: /revised already-streamed text/ }),
  );
});

// 6. A transport-level bridge error must fail whatever response is in flight instead of
// leaving the caller waiting on a dead pipe.
test("a bridge 'error' event fails the in-flight response", async t => {
  const h = await harness({
    'turn/start'(bridge) { bridge.emit('error', new Error('codex app-server pipe closed')); },
  });
  t.after(() => h.dispose());

  await assert.rejects(
    () => h.adapter.messages(body()),
    adapterError({ status: 502, type: 'api_error', message: /transport failed/ }),
  );
});

// 7a. Cancellation must reach the caller as a cancellation, with the conversation torn
// down; otherwise an abandoned request keeps a Codex turn alive.
test('aborting mid-flight rejects as a cancellation and disposes the conversation', async t => {
  const controller = new AbortController();
  const h = await harness({ 'turn/start': () => controller.abort() });
  t.after(() => h.dispose());

  await assert.rejects(
    () => h.adapter.messages(body(), { signal: controller.signal }),
    adapterError({ status: 499, type: 'request_cancelled', message: /cancelled/i }),
  );
  const bridge = h.generation()[0];
  assert.deepEqual(bridge.interrupts, [bridge.threadId], 'cancelling must interrupt the Codex turn');
  assert.equal(h.adapter.contexts.size, 0);
});

// 7b. An already-aborted signal must be refused before anything is spawned or started.
// This is what keeps a cancelled client from still costing a ChatGPT turn.
test('a signal aborted before the call never reaches the bridge', async t => {
  const controller = new AbortController();
  controller.abort();
  const h = await harness({ 'turn/start'(bridge) { bridge.answer('should never run'); } });
  t.after(() => h.dispose());

  await assert.rejects(
    () => h.adapter.messages(body(), { signal: controller.signal }),
    adapterError({ status: 499, type: 'request_cancelled' }),
  );
  assert.equal(h.bridges.length, 0, 'no bridge may be constructed for an already-cancelled request');
});

// 8. The request deadline. Injected small so the suite never waits out the real one.
test('reaching requestTimeoutMs fails with a 504 timeout', async t => {
  const h = await harness({ 'turn/start'() { /* Codex never answers */ } }, { requestTimeoutMs: 40 });
  t.after(() => h.dispose());

  await assert.rejects(
    () => h.adapter.messages(body()),
    adapterError({ status: 504, type: 'api_error', message: /timed out/ }),
  );
  const bridge = h.generation()[0];
  assert.deepEqual(bridge.interrupts, [bridge.threadId], 'a timed-out turn must be interrupted');
});

// 9. After shutdown the adapter must refuse work instead of lazily re-spawning a bridge
// during process teardown.
test('messages after close is refused with a 503', async t => {
  const h = await harness({ 'turn/start'(bridge) { bridge.answer('hi'); } });
  t.after(() => h.dispose());

  await h.adapter.close();
  await assert.rejects(
    () => h.adapter.messages(body()),
    adapterError({ status: 503, type: 'api_error', message: /closed/i }),
  );
  assert.equal(h.bridges.length, 0, 'a closed adapter must not create new bridges');
});

// 10. The concurrency ceiling on live tool conversations, which is what stops an
// unbounded number of Codex threads being held open.
test('exceeding maxContexts is rejected as a rate limit', async t => {
  let firstStarted;
  const started = new Promise(resolve => { firstStarted = resolve; });
  const h = await harness({ 'turn/start': () => firstStarted() }, { maxContexts: 1 });
  t.after(() => h.dispose());

  const controller = new AbortController();
  const first = h.adapter.messages(body(), { signal: controller.signal });
  first.catch(() => {});
  await started;

  await assert.rejects(
    () => h.adapter.messages(body()),
    adapterError({ status: 429, type: 'rate_limit_error', message: /Too many active tool conversations/ }),
  );
  assert.equal(h.generation().length, 1, 'the refused request must not have started a second thread');

  controller.abort();
  await assert.rejects(() => first, adapterError({ status: 499 }));
});

// 11. Two responses for the same tool conversation would interleave on one Codex thread,
// so the second must be refused rather than corrupting the first.
test('a second concurrent response for one tool conversation is refused with 409', async t => {
  const turn = toolRequestingTurn();
  const h = await harness({ 'turn/start': turn.handler });
  t.after(() => h.dispose());

  const toolUse = await untilToolUse(h);
  const follow = continuation(toolUse);

  const pending = h.adapter.messages(follow);
  pending.catch(() => {});
  // The bridge-side tool promise settling proves the continuation is past the point where
  // it claims the conversation, without depending on a sleep.
  await turn.state.settled;

  await assert.rejects(
    () => h.adapter.messages(follow),
    adapterError({ status: 409, type: 'invalid_request_error', message: /already in progress/ }),
  );
  assert.equal(h.generation().length, 1, 'the refused continuation must not open another thread');

  await h.adapter.close();
  await assert.rejects(() => pending, adapterError({ status: 499 }));
});

// A tool conversation left waiting on the caller must not survive shutdown: the promise
// the bridge is holding has to be rejected, or the fake Codex side waits forever.
test('close rejects the tool request the bridge is still waiting on', async t => {
  const turn = toolRequestingTurn();
  const h = await harness({ 'turn/start': turn.handler });
  t.after(() => h.dispose());

  await untilToolUse(h);
  assert.equal(h.adapter.contexts.size, 1, 'a tool_use stop must keep the conversation alive');

  await h.adapter.close();
  const settled = await turn.state.settled;
  assert.ok(settled.error, 'the outstanding tool promise must be rejected, not left pending');
  adapterError({ status: 499, type: 'request_cancelled' })(settled.error);
  assert.equal(h.adapter.contexts.size, 0);
});

// 12. A failure disposes the conversation, so its tool_use ids stop being live. Replaying
// the same tool_result must be rebuilt from the supplied history on a fresh thread rather
// than steered into the dead one. Catches a regression that kept a failed context in the
// tool index and resumed a thread Codex has already torn down.
test('after a failure the tool conversation is disposed and not resumed', async t => {
  const turn = toolRequestingTurn();
  const h = await harness({
    'turn/start': turn.handler,
    'turn/steer'(bridge) { bridge.notify('error', { error: { message: 'thread died mid-continuation' } }); },
  });
  t.after(() => h.dispose());

  const toolUse = await untilToolUse(h);
  const follow = continuation(toolUse, [{ type: 'text', text: 'also consider this' }]);

  await assert.rejects(
    () => h.adapter.messages(follow),
    adapterError({ status: 502, type: 'api_error', message: /thread died mid-continuation/ }),
  );

  const failed = h.generation()[0];
  assert.deepEqual(failed.methods(), ['turn/start', 'turn/steer'], 'the continuation steered the live thread');
  assert.equal(failed.requests[1].params.expectedTurnId, failed.turnId, 'steering must name the turn it expects');
  assert.deepEqual(failed.interrupts, [failed.threadId]);
  assert.equal(failed.closes, 1);
  assert.equal(h.adapter.contexts.size, 0, 'the failed conversation must be gone');

  // Replaying the same tool_result now: it must be treated as fresh history, not a resume.
  h.script['turn/start'] = bridge => bridge.answer('rebuilt from replayed history');
  const result = await h.adapter.messages(follow);
  assert.equal(result.stop_reason, 'end_turn');

  const rebuilt = h.generation()[1];
  assert.ok(rebuilt, 'a replayed tool_result must open a new conversation');
  assert.notEqual(rebuilt.threadId, failed.threadId);
  assert.deepEqual(rebuilt.methods(), ['thread/inject_items', 'turn/start'], 'the dead thread must not be steered');
  const injected = rebuilt.requests[0].params.items.map(item => item.type);
  assert.ok(injected.includes('function_call_output'), 'the prior tool result must be replayed as history');
});

// The caller's tool must never be advertised to Codex when tool_choice forbids it, and a
// request for it must be refused at the boundary rather than run.
test('a tool the request did not expose is refused at the bridge boundary', async t => {
  const turn = toolRequestingTurn({ q: 'x' });
  const h = await harness({
    'turn/start'(bridge) {
      turn.handler(bridge);
      bridge.answer('answering without tools');
    },
  });
  t.after(() => h.dispose());

  const result = await h.adapter.messages(toolBody(
    [{ role: 'user', content: 'hi' }],
    { tool_choice: { type: 'none' } },
  ));
  assert.equal(result.stop_reason, 'end_turn');
  assert.deepEqual(h.generation()[0].options.toolDefinitions, [], 'tool_choice none must expose nothing');

  const settled = await turn.state.settled;
  assert.ok(settled.error, 'the unexposed tool call must be rejected');
  adapterError({ status: 400, message: /not exposed by this request/ })(settled.error);
});

// A forced tool choice that the model ignores must fail rather than returning a plain
// answer the caller's contract says cannot happen.
test('an unsatisfied forced tool choice fails with a 502', async t => {
  const h = await harness({ 'turn/start'(bridge) { bridge.answer('no tool, sorry'); } });
  t.after(() => h.dispose());

  await assert.rejects(
    () => h.adapter.messages(toolBody([{ role: 'user', content: 'hi' }], { tool_choice: { type: 'any' } })),
    adapterError({ status: 502, type: 'api_error', message: /did not satisfy the requested forced tool choice/ }),
  );
});

// Conversation isolation: notifications are multiplexed per thread, so one conversation's
// failure must not be able to kill another's response.
test('a notification for a different thread cannot fail this response', async t => {
  const h = await harness({
    'turn/start'(bridge) {
      bridge.emit('notification', { method: 'error', params: { threadId: 'thread_somebody_else', error: { message: 'not ours' } } });
      bridge.emit('notification', { method: 'turn/completed', params: { threadId: 'thread_somebody_else', turn: { status: 'failed' } } });
      bridge.answer('ours');
    },
  });
  t.after(() => h.dispose());

  const result = await h.adapter.messages(body());
  assert.equal(result.stop_reason, 'end_turn');
  assert.deepEqual(result.content, [{ type: 'text', text: 'ours' }]);
});

// 13. Shutdown must be idempotent and must not leave a timer pinning the event loop; the
// bridge is embedded in a CLI that has to exit when the caller is done.
test('close is safe twice and leaves no timer holding the loop open', async t => {
  const timersBefore = countTimers();
  const turn = toolRequestingTurn();
  const h = await harness({ 'turn/start': turn.handler }, { contextTtlMs: 60_000 });
  t.after(() => h.dispose());

  await untilToolUse(h);
  await h.adapter.close();
  await h.adapter.close();

  assert.equal(h.adapter.contexts.size, 0);
  assert.equal(h.adapter.toolIndex.size, 0, 'the tool index must not retain ids from closed conversations');
  assert.ok(h.generation()[0].closes >= 1, 'the generation bridge must be closed');
  assert.ok(h.bridges[0].closes >= 1, 'the catalog bridge must be closed too');
  assert.ok(
    countTimers() <= timersBefore,
    `close must not leave timers behind (before ${timersBefore}, after ${countTimers()})`,
  );
});
