/**
 * Tests for plain text generation and streaming in the translation layer.
 *
 * The adapter is the only thing standing between an Anthropic-shaped client and a
 * Codex thread, so the shape of an ordinary text answer is load-bearing: the client
 * reads content blocks, stop_reason and usage, and a streaming client reads the SSE
 * event order. These tests drive a fake bridge; nothing here spawns Codex, touches
 * the network, or reads a real installation directory.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { Adapter, AdapterError } from './adapter.mjs';

const MODEL = 'gpt-5-codex-fake';
const CATALOG = [{ model: MODEL, displayName: 'Fake Codex', isDefault: true }];
const THREAD = 'thread_fake_1';

/**
 * Stand-in for CodexBridge. Records the calls the adapter makes and replays a
 * scripted notification stream instead of speaking to the real CLI.
 */
class FakeBridge extends EventEmitter {
  constructor(options, script, hooks) {
    super();
    this.options = options;
    this.script = script;
    this.hooks = hooks;
    this.activeTurns = new Map();
    this.requests = [];
    this.startThreadCalls = [];
    this.interrupted = [];
    this.threadId = THREAD;
    this.closed = false;
  }
  async account() { return { account: { type: 'chatgpt' } }; }
  async models() { return CATALOG; }
  async startThread(params) {
    this.startThreadCalls.push(params);
    // The real transport can deliver notifications before the caller has a request
    // in flight; this hook exercises the adapter's backlog-and-replay path.
    for (const note of this.hooks.duringStartThread ?? []) this.send(note);
    return { thread: { id: this.threadId } };
  }
  async request(method, params) {
    this.requests.push({ method, params });
    if (method === 'turn/start') {
      this.activeTurns.set(params.threadId, 'turn_1');
      void this.play();
    }
    return { turn: { id: 'turn_1', status: 'inProgress' } };
  }
  async interrupt(threadId) { this.interrupted.push(threadId); return { interrupted: false }; }
  async close() { this.closed = true; }
  respondApproval() {}
  send(note) {
    this.emit('notification', { ...note, params: { threadId: this.threadId, ...note.params } });
  }
  /** One notification per event-loop turn, the way real stdout lines arrive. */
  async play() {
    for (const note of this.script) {
      await new Promise(resolve => setImmediate(resolve));
      if (this.closed) return;
      this.send(note);
    }
  }
}

async function withAdapter(script, run, { hooks = {}, options = {} } = {}) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'adapter-text-'));
  const bridges = [];
  const adapter = new Adapter({
    cwd,
    // Pinned so model selection cannot depend on SCIENCE_CHATGPT_MODEL in the environment.
    model: MODEL,
    bridgeFactory: bridgeOptions => {
      const bridge = new FakeBridge(bridgeOptions, script, hooks);
      bridges.push(bridge);
      return bridge;
    },
    ...options,
  });
  try {
    return await run(adapter, bridges);
  } finally {
    await adapter.close();
    await fs.rm(cwd, { recursive: true, force: true });
  }
}

/** The generation bridge, as opposed to the one the adapter opens to read the model catalog. */
const generation = bridges => bridges.find(bridge => typeof bridge.options.toolHandler === 'function');

const delta = (text, itemId = 'item_1') => ({ method: 'item/agentMessage/delta', params: { itemId, delta: text } });
const completed = (text, id = 'item_1') => ({ method: 'item/completed', params: { item: { type: 'agentMessage', id, text } } });
const turnDone = (status = 'completed') => ({ method: 'turn/completed', params: { turn: { id: 'turn_1', status } } });
const foreign = note => ({ ...note, params: { ...note.params, threadId: 'thread_someone_else' } });

const body = (extra = {}) => ({ model: 'claude-opus-5', max_tokens: 256, messages: [{ role: 'user', content: 'ping' }], ...extra });

/** Collects streaming events, dropping the keep-alive ping the transport layer adds. */
function collector() {
  const events = [];
  return { events, onEvent: event => { if (event.type !== 'ping') events.push(event); } };
}
const types = events => events.map(event => event.type);
const textOf = result => result.content.filter(block => block.type === 'text').map(block => block.text).join('');

/** Rejection assertions must pin the status and type, so no test passes on a bare throw. */
const rejectsWith = (run, { status, type, message }) => assert.rejects(run, error => {
  assert.ok(error instanceof AdapterError, `expected an AdapterError, got ${error}`);
  assert.equal(error.status, status);
  assert.equal(error.type, type);
  assert.match(error.message, message);
  return true;
});

test('a non-streaming request returns a well-formed Anthropic message', async () => {
  await withAdapter([delta('Hello, '), delta('world.'), completed('Hello, world.'), turnDone()], async adapter => {
    const result = await adapter.messages(body());
    assert.equal(result.type, 'message');
    assert.equal(result.role, 'assistant');
    assert.match(result.id, /^msg_[0-9a-f]{32}$/);
    assert.deepEqual(result.content, [{ type: 'text', text: 'Hello, world.' }]);
    assert.equal(result.model, MODEL, 'the client must see the ChatGPT model that actually answered');
    assert.equal(result.stop_reason, 'end_turn');
    assert.equal(result.stop_sequence, null);
    assert.ok(Number.isInteger(result.usage.input_tokens) && result.usage.input_tokens > 0);
    // Output tokens are visible UTF-8 bytes divided by four: 13 bytes here.
    assert.equal(result.usage.output_tokens, 4);
    assert.equal(result.usage.input_tokens > 0, true);
    assert.equal(result._bridge.token_usage_estimated, true, 'usage must be labelled an estimate, not Anthropic billing');
    assert.equal(result._bridge.provider, 'chatgpt-managed-codex');
  });
});

// Catches a regression that keyed text by arrival rather than accumulating it, which
// would surface only the last delta or reorder a long answer.
test('multiple deltas for one item concatenate in arrival order', async () => {
  await withAdapter([delta('one '), delta('two '), delta('three'), turnDone()], async adapter => {
    const result = await adapter.messages(body());
    assert.deepEqual(result.content, [{ type: 'text', text: 'one two three' }]);
  });
});

// The completion repeats the whole message. If both the deltas and the completion
// appended, every answer would arrive doubled.
test('item/completed does not re-append text the deltas already delivered', async () => {
  await withAdapter([delta('Half '), delta('and half'), completed('Half and half'), turnDone()], async adapter => {
    const result = await adapter.messages(body());
    assert.equal(result.content.length, 1, 'reconciliation must not open a second text block');
    assert.equal(textOf(result), 'Half and half');
  });
});

// The opposite direction: a completion that is longer than what streamed must
// contribute the missing tail exactly once.
test('item/completed contributes only the tail the deltas had not delivered', async () => {
  await withAdapter([delta('Par'), completed('Partial tail'), turnDone()], async adapter => {
    const { events, onEvent } = collector();
    const result = await adapter.messages(body(), { onEvent });
    assert.equal(textOf(result), 'Partial tail');
    assert.deepEqual(
      events.filter(event => event.type === 'content_block_delta').map(event => event.delta.text),
      ['Par', 'tial tail'],
      'the tail must be streamed as its own delta rather than restating the message',
    );
  });
});

test('a streaming request emits the Anthropic SSE sequence in order with consistent indices', async () => {
  await withAdapter([delta('a'), delta('b'), completed('ab'), turnDone()], async adapter => {
    const { events, onEvent } = collector();
    const result = await adapter.messages(body({ stream: true }), { onEvent });
    assert.deepEqual(types(events), [
      'message_start', 'content_block_start', 'content_block_delta', 'content_block_delta',
      'content_block_stop', 'message_delta', 'message_stop',
    ]);
    const start = events[0].message;
    assert.equal(start.type, 'message');
    assert.equal(start.role, 'assistant');
    assert.deepEqual(start.content, [], 'message_start must open with no content');
    assert.equal(start.stop_reason, null);
    assert.equal(start.id, result.id, 'the streamed message id must match the assembled message');
    assert.equal(events[1].index, 0);
    assert.deepEqual(events[1].content_block, { type: 'text', text: '' });
    for (const event of events.filter(event => event.type === 'content_block_delta')) {
      assert.equal(event.index, 0);
      assert.equal(event.delta.type, 'text_delta');
      assert.equal(typeof event.delta.text, 'string');
    }
    assert.equal(events[4].index, 0, 'content_block_stop must close the block it opened');
    assert.deepEqual(events[5].delta, { stop_reason: 'end_turn', stop_sequence: null });
    assert.equal(events[5].usage.output_tokens, result.usage.output_tokens);
  });
});

// A streaming client and a buffering client must not see different answers.
test('the streamed deltas concatenate to the same text a non-streamed request returns', async () => {
  const script = [delta('The '), delta('quick '), delta('brown fox'), completed('The quick brown fox'), turnDone()];
  const streamed = await withAdapter(script, async adapter => {
    const { events, onEvent } = collector();
    await adapter.messages(body({ stream: true }), { onEvent });
    return events.filter(event => event.type === 'content_block_delta').map(event => event.delta.text).join('');
  });
  const buffered = await withAdapter(script, async adapter => textOf(await adapter.messages(body())));
  assert.equal(streamed, buffered);
  assert.equal(buffered, 'The quick brown fox');
});

test('a string system prompt reaches the bridge as thread instructions', async () => {
  await withAdapter([delta('ok'), turnDone()], async (adapter, bridges) => {
    await adapter.messages(body({ system: 'Answer only in haiku.' }));
    const [params] = generation(bridges).startThreadCalls;
    assert.ok(params.instructions.startsWith('Answer only in haiku.'), `instructions were ${JSON.stringify(params.instructions)}`);
    assert.equal(params.cwd, adapter.cwd);
    assert.equal(params.model, MODEL);
    assert.equal(params.readOnly, true, 'an inference-only thread must not be able to write');
    assert.equal(params.ephemeral, true, 'the conversation must not be persisted into a Codex thread store');
    assert.match(params.baseInstructions, /inference-only protocol adapter/);
  });
});

// The Messages API allows system as an array of text blocks; dropping the tail of
// that array would silently discard part of the caller's instructions.
test('an array system prompt is joined and reaches the bridge intact', async () => {
  await withAdapter([delta('ok'), turnDone()], async (adapter, bridges) => {
    await adapter.messages(body({ system: [{ type: 'text', text: 'First rule.' }, { type: 'text', text: 'Second rule.' }] }));
    const [params] = generation(bridges).startThreadCalls;
    assert.ok(params.instructions.includes('First rule.\n\nSecond rule.'), `instructions were ${JSON.stringify(params.instructions)}`);
  });
});

test('a non-text system block is refused rather than dropped', async () => {
  await withAdapter([turnDone()], async adapter => {
    await rejectsWith(() => adapter.messages(body({ system: [{ type: 'text', text: 'ok' }, { type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } }] })), {
      status: 400, type: 'invalid_request_error', message: /system supports text blocks only/,
    });
  });
});

// A turn that produces no text at all must still resolve. If it hung, the gateway
// would hold the client's connection open until the multi-minute timeout.
test('a turn that produces no text terminates cleanly', async () => {
  await withAdapter([turnDone()], async adapter => {
    const { events, onEvent } = collector();
    const result = await adapter.messages(body(), { onEvent });
    assert.equal(result.stop_reason, 'end_turn');
    assert.equal(result.content.length, 0);
    assert.equal(result.usage.output_tokens, 0);
    assert.deepEqual(types(events), ['message_start', 'message_delta', 'message_stop'],
      'no content block may be opened when there is no content');
  });
});

// Codex multiplexes threads over one connection. Text from another thread appearing
// in this response would be a cross-conversation leak, and a foreign turn/completed
// would truncate this answer.
test('notifications for another threadId are ignored', async () => {
  const script = [foreign(delta('LEAKED')), foreign(turnDone()), delta('mine'), completed('mine'), turnDone()];
  await withAdapter(script, async adapter => {
    const result = await adapter.messages(body());
    assert.deepEqual(result.content, [{ type: 'text', text: 'mine' }]);
    assert.equal(result.stop_reason, 'end_turn');
    assert.ok(!JSON.stringify(result).includes('LEAKED'), 'another thread\'s text must not reach this response');
  });
});

// Internal reasoning is deliberately dropped: it is neither an Anthropic thinking
// block nor something this bridge is allowed to present as the answer.
test('reasoning notifications never surface as content', async () => {
  const script = [
    { method: 'item/reasoning/delta', params: { itemId: 'r1', delta: 'PRIVATE chain of thought' } },
    { method: 'item/started', params: { item: { type: 'reasoning', id: 'r1' } } },
    { method: 'item/completed', params: { item: { type: 'reasoning', id: 'r1', text: 'PRIVATE summary' } } },
    delta('Visible answer.'), completed('Visible answer.'), turnDone(),
  ];
  await withAdapter(script, async adapter => {
    const { events, onEvent } = collector();
    const result = await adapter.messages(body(), { onEvent });
    assert.deepEqual(result.content, [{ type: 'text', text: 'Visible answer.' }]);
    assert.ok(!JSON.stringify(result).includes('PRIVATE'), 'reasoning must not appear in the message');
    assert.ok(!JSON.stringify(events).includes('PRIVATE'), 'reasoning must not appear in the event stream');
  });
});

// Pins the exact request the adapter issues for a single-turn text prompt: the user
// text must be the turn input, with no replay injection and no tools exposed.
test('the user text is handed to the bridge as the turn input', async () => {
  await withAdapter([delta('ok'), turnDone()], async (adapter, bridges) => {
    await adapter.messages(body());
    const bridge = generation(bridges);
    assert.deepEqual(bridge.requests, [{ method: 'turn/start', params: { threadId: THREAD, input: [{ type: 'text', text: 'ping' }] } }]);
    assert.deepEqual(bridge.options.toolDefinitions, [], 'a text-only request must expose no tools to Codex');
  });
});

// Two agent messages in one turn become two blocks; a shared index would make a
// streaming client overwrite the first message with the second.
test('two agent message items become two separately indexed text blocks', async () => {
  const script = [delta('first', 'a'), completed('first', 'a'), delta('second', 'b'), completed('second', 'b'), turnDone()];
  await withAdapter(script, async adapter => {
    const { events, onEvent } = collector();
    const result = await adapter.messages(body(), { onEvent });
    assert.deepEqual(result.content, [{ type: 'text', text: 'first' }, { type: 'text', text: 'second' }]);
    assert.deepEqual(types(events), [
      'message_start', 'content_block_start', 'content_block_delta', 'content_block_stop',
      'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop',
    ]);
    assert.deepEqual(events.filter(event => event.type !== 'message_start' && !event.type.startsWith('message')).map(event => event.index), [0, 0, 0, 1, 1, 1]);
  });
});

// Notifications that arrive while the thread is still being created are backlogged.
// Losing the backlog would drop the opening words of fast answers.
test('text that arrived before the turn request is replayed, not lost', async () => {
  await withAdapter([delta('late'), completed('early late'), turnDone()], async adapter => {
    const result = await adapter.messages(body());
    assert.equal(textOf(result), 'early late');
  }, { hooks: { duringStartThread: [delta('early ')] } });
});

// Inference-only means no native shell. Seeing one start mid-answer must abort the
// response rather than quietly return whatever text preceded it.
test('native tool activity aborts the response', async () => {
  const script = [delta('starting'), { method: 'item/started', params: { item: { type: 'commandExecution', id: 'c1' } } }, turnDone()];
  await withAdapter(script, async adapter => {
    await rejectsWith(() => adapter.messages(body()), {
      status: 502, type: 'api_error', message: /native tool activity was blocked/,
    });
  });
});

test('an error notification fails the request with the transport message', async () => {
  const script = [delta('partial'), { method: 'error', params: { error: { message: 'upstream model overloaded' } } }];
  await withAdapter(script, async adapter => {
    await rejectsWith(() => adapter.messages(body()), {
      status: 502, type: 'api_error', message: /upstream model overloaded/,
    });
  });
});

// A completion that contradicts what already streamed cannot be represented; failing
// is correct, because a streaming client has already shown the earlier text.
test('a completion that revises already-streamed text is refused', async () => {
  const script = [delta('The answer is 4'), completed('The answer is 5'), turnDone()];
  await withAdapter(script, async adapter => {
    await rejectsWith(() => adapter.messages(body()), {
      status: 502, type: 'api_error', message: /revised already-streamed text/,
    });
  });
});

// max_tokens is enforced as a byte ceiling on visible text. The truncation must land
// on a character boundary: a split surrogate pair would corrupt the JSON response.
test('the max_tokens byte ceiling truncates without splitting a character', async () => {
  const emoji = '\u{1F600}';
  await withAdapter([delta(emoji + emoji), turnDone()], async adapter => {
    const result = await adapter.messages(body({ max_tokens: 1 }));
    assert.equal(result.stop_reason, 'max_tokens');
    assert.equal(textOf(result), emoji, 'the 4-byte budget fits exactly one whole emoji');
    assert.equal(result.usage.output_tokens, 1);
  });
});

test('a stop sequence truncates the text and is reported back', async () => {
  await withAdapter([delta('visible STOPhidden'), turnDone()], async adapter => {
    const result = await adapter.messages(body({ stop_sequences: ['STOP'] }));
    assert.equal(textOf(result), 'visible ');
    assert.equal(result.stop_reason, 'stop_sequence');
    assert.equal(result.stop_sequence, 'STOP');
    // Scoped to content: the adapter's own usage warning legitimately mentions hidden tokens.
    assert.ok(!JSON.stringify(result.content).includes('hidden'), 'text after the stop sequence must not be returned');
  });
});

// Text is held back while it could still be the start of a stop sequence. If the hold
// were never flushed, answers ending in a near-miss prefix would lose their last characters.
test('text held back as a possible stop sequence is still delivered', async () => {
  await withAdapter([delta('abcE'), delta('x'), turnDone()], async adapter => {
    const { events, onEvent } = collector();
    const result = await adapter.messages(body({ stop_sequences: ['END'] }), { onEvent });
    assert.equal(textOf(result), 'abcEx');
    assert.equal(result.stop_reason, 'end_turn');
    assert.equal(result.stop_sequence, null);
    assert.equal(events.filter(event => event.type === 'content_block_delta').map(event => event.delta.text).join(''), 'abcEx');
  });
});

// A turn that never completes must be bounded. requestTimeoutMs is injected small so
// this reaches the timeout path without waiting out the real multi-minute budget.
test('a turn that never completes times out instead of hanging', async () => {
  await withAdapter([delta('partial')], async adapter => {
    await rejectsWith(() => adapter.messages(body()), {
      status: 504, type: 'api_error', message: /Generation timed out/,
    });
  }, { options: { requestTimeoutMs: 50 } });
});

// SUSPECTED DEFECT: completeText treats a completion carrying no text as a revision of
// the streamed text and throws 502, discarding an answer that was already delivered in
// full. The adapter itself writes `params.item.text || ''`, so a missing text field is
// anticipated one line earlier and then rejected here.
test('a completion with no text keeps the text the deltas delivered', { todo: true }, async () => {
  await withAdapter([delta('Complete answer.'), completed(undefined), turnDone()], async adapter => {
    const result = await adapter.messages(body());
    assert.equal(textOf(result), 'Complete answer.');
    assert.equal(result.stop_reason, 'end_turn');
  });
});

// SUSPECTED DEFECT, same root cause: any completion that is not a prefix-extension of
// the streamed text fails the whole request, so a normalising completion (here trailing
// whitespace trimmed) turns a good answer into a 502.
test('a completion that only trims trailing whitespace does not fail the request', { todo: true }, async () => {
  await withAdapter([delta('Answer with a trailing newline.\n'), completed('Answer with a trailing newline.'), turnDone()], async adapter => {
    const result = await adapter.messages(body());
    assert.match(textOf(result), /^Answer with a trailing newline\.\n?$/);
    assert.equal(result.stop_reason, 'end_turn');
  });
});
