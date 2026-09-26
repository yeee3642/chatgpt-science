/**
 * Tests for caller-tool round-trips through the translation layer.
 *
 * The adapter never executes a caller tool: it renames each one to external_tool_<n> for
 * Codex, turns a Codex tool call into an Anthropic tool_use block, and holds the Codex turn
 * open until the caller supplies the matching tool_result on a later request. That makes the
 * conversation stateful across two HTTP requests, so the risky behaviour is the bookkeeping:
 * which conversation a tool_result belongs to, whether a result may be reused, and when the
 * live Codex thread must be abandoned and the history replayed instead.
 *
 * Everything runs against an injected fake bridge. No process is spawned, no network is
 * touched, and the only filesystem use is a throwaway temp directory the adapter mkdirs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { Adapter } from './adapter.mjs';

let sequence = 0;
const nextName = prefix => `${prefix}_${++sequence}`;

/**
 * Stand-in for codex-bridge.mjs. It records what the adapter asked for, and lets a per-test
 * `script` drive the turn by emitting the notifications the real App Server would emit.
 */
class FakeBridge extends EventEmitter {
  constructor(options, { models, script, accountType }) {
    super();
    this.options = options;
    this.catalog = models;
    this.script = script;
    this.accountType = accountType;
    this.threadId = null;
    this.activeTurns = new Map();
    this.startThreads = [];
    this.calls = [];
    this.toolCalls = [];
    this.interrupted = [];
    this.closed = 0;
  }

  async account() { return { account: { type: this.accountType } }; }
  async models() { return this.catalog; }

  async startThread(params) {
    this.startThreads.push(params);
    this.threadId = nextName('thread');
    return { thread: { id: this.threadId } };
  }

  async request(method, params) {
    this.calls.push({ method, params });
    if (method === 'turn/start') {
      this.activeTurns.set(params.threadId, nextName('turn'));
      // Notifications arrive after the request settles, as they do over the real transport;
      // emitting inside request() would exercise the backlog path instead.
      setTimeout(() => { void this.script?.(this, params); }, 0);
    }
    return {};
  }

  respondApproval() {}
  async interrupt(threadId) { this.interrupted.push(threadId); return { interrupted: true }; }
  async close() { this.closed += 1; }

  /* ---- helpers the per-test scripts use to play a Codex turn ---- */

  note(method, params) { this.emit('notification', { method, params: { threadId: this.threadId, ...params } }); }

  say(text, itemId = nextName('item')) {
    this.note('item/agentMessage/delta', { itemId, delta: text });
    this.note('item/completed', { item: { type: 'agentMessage', id: itemId, text } });
  }

  finishTurn(status = 'completed') { this.note('turn/completed', { turn: { status } }); }

  /**
   * Invoke the injected toolHandler the way codex-bridge does: the returned promise stays
   * pending until a later request resolves it, and its outcome is always handled so an
   * abandoned conversation cannot surface as an unhandled rejection.
   */
  callTool(name, args) {
    const record = { name, args, value: null, error: null };
    this.toolCalls.push(record);
    record.settled = Promise.resolve()
      .then(() => this.options.toolHandler(name, args))
      .then(value => { record.value = value; return record; }, error => { record.error = error; return record; });
    return record.settled;
  }
}

const CATALOG = [
  { model: 'gpt-5-codex', displayName: 'GPT-5 Codex', isDefault: true },
  { model: 'gpt-5-mini', displayName: 'GPT-5 Mini' },
];

async function withAdapter(run, { script, models = CATALOG, accountType = 'chatgpt', ...overrides } = {}) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'adapter-tools-'));
  const bridges = [];
  const adapter = new Adapter({
    cwd,
    model: null, // ignore SCIENCE_CHATGPT_MODEL so the default model pick stays deterministic
    toolBatchMs: 1, // the real 25ms batch window only slows the suite down
    requestTimeoutMs: 2000, // a hung turn should fail fast rather than sit for three minutes
    bridgeFactory: options => {
      const bridge = new FakeBridge(options, { models, script, accountType });
      bridges.push(bridge);
      return bridge;
    },
    ...overrides,
  });
  // The catalog bridge is created without a toolHandler; generation bridges always have one.
  const gen = () => bridges.filter(bridge => bridge.options.toolHandler);
  const threads = () => gen().reduce((total, bridge) => total + bridge.startThreads.length, 0);
  try {
    return await run({ adapter, bridges, gen, threads, cwd });
  } finally {
    await adapter.close();
    await fs.rm(cwd, { recursive: true, force: true });
  }
}

const weather = {
  name: 'get_weather',
  description: 'Look up the weather',
  input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
};
// No description and no schema type, so the adapter's defaults are observable.
const stock = { name: 'lookup_stock', input_schema: { properties: { ticker: { type: 'string' } } } };

const ask = (overrides = {}) => ({
  model: 'claude-opus-5',
  max_tokens: 1024,
  messages: [{ role: 'user', content: 'What is the weather in Taipei?' }],
  tools: [weather],
  ...overrides,
});

const followUp = (body, response, content) => ({
  ...body,
  messages: [...body.messages, { role: 'assistant', content: response.content }, { role: 'user', content }],
});
const okResult = (id, text = 'Sunny, 30C') => ({ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text }] });
const toolUseOf = response => response.content.find(block => block.type === 'tool_use');

/** True once the adapter has given up on the live thread and replayed the conversation. */
const isReplay = params => /after the latest external tool results/.test(params.input?.[0]?.text ?? '');

/** Calls external_tool_0 once, then answers with text when the caller's result comes back. */
const callThenAnswer = (args = '{"city":"Taipei"}', answer = 'It is sunny in Taipei.') => async (bridge, params) => {
  if (isReplay(params)) { bridge.say(answer); bridge.finishTurn(); return; }
  const call = await bridge.callTool('external_tool_0', args);
  if (call.error) return; // conversation abandoned; a real turn would have been interrupted
  bridge.say(answer);
  bridge.finishTurn();
};

/** Two sequential calls: the second is only made after the first result arrives. */
const callTwice = async (bridge, params) => {
  if (isReplay(params)) { bridge.say('Replayed answer.'); bridge.finishTurn(); return; }
  const first = await bridge.callTool('external_tool_0', '{"city":"Taipei"}');
  if (first.error) return;
  const second = await bridge.callTool('external_tool_0', '{"city":"Tainan"}');
  if (second.error) return;
  bridge.say('Both cities are sunny.');
  bridge.finishTurn();
};

/** Two calls issued in the same tick, which the adapter may batch into one response. */
const callBoth = async (bridge, params) => {
  if (isReplay(params)) { bridge.say('Replayed answer.'); bridge.finishTurn(); return; }
  const [first, second] = await Promise.all([
    bridge.callTool('external_tool_0', '{"city":"Taipei"}'),
    bridge.callTool('external_tool_1', '{"ticker":"2330"}'),
  ]);
  if (first.error || second.error) return;
  bridge.say('Done.');
  bridge.finishTurn();
};

const textOnly = (answer = 'It is sunny in Taipei.') => async bridge => { bridge.say(answer); bridge.finishTurn(); };

test('caller tools reach the bridge under generated names with defaults filled in', async () => {
  // Catches a regression that leaked the caller's own tool names to Codex, or that passed a
  // schema through unchanged (Codex requires an object schema) or with no description.
  await withAdapter(async ({ adapter, gen }) => {
    await adapter.messages(ask({ tools: [weather, stock] }));
    const definitions = gen()[0].options.toolDefinitions;
    assert.deepEqual(definitions.map(tool => tool.name), ['external_tool_0', 'external_tool_1']);
    assert.deepEqual(definitions.map(tool => tool.originalName), ['get_weather', 'lookup_stock']);
    assert.equal(definitions[0].description, 'Look up the weather');
    assert.equal(definitions[1].description, 'Request the calling application to run lookup_stock.');
    assert.equal(definitions[1].inputSchema.type, 'object', 'a schema with no type must still be declared as an object');
    assert.deepEqual(definitions[1].inputSchema.properties, { ticker: { type: 'string' } });
    assert.ok(definitions.every(tool => tool.readOnly === true), 'caller tools are never executed here, so none may be writable');
  }, { script: textOnly() });
});

test('the thread instructions carry the generated-name to original-name mapping', async () => {
  // Without this mapping in the instructions the model cannot tell the caller which of its
  // own tools external_tool_1 stands for.
  await withAdapter(async ({ adapter, gen, cwd }) => {
    await adapter.messages(ask({ tools: [weather, stock], system: 'You are a weather desk.' }));
    const started = gen()[0].startThreads[0];
    assert.match(started.instructions, /^You are a weather desk\./);
    assert.match(started.instructions, /External tool name mapping:\nexternal_tool_0 = get_weather\nexternal_tool_1 = lookup_stock/);
    assert.match(started.baseInstructions, /external_tool_\* represent requests to the calling application/);
    assert.equal(started.readOnly, true);
    assert.equal(started.ephemeral, true);
    assert.equal(started.model, 'gpt-5-codex');
    assert.equal(started.cwd, path.resolve(cwd), 'the thread must run in the injected sandbox directory');
  }, { script: textOnly() });
});

test('a tool call becomes a tool_use block under the caller original tool name', async () => {
  // Catches the model-facing name leaking to the caller, string arguments being forwarded
  // unparsed, and tool JSON not being counted against the output budget.
  await withAdapter(async ({ adapter, gen }) => {
    const result = await adapter.messages(ask());
    assert.equal(result.stop_reason, 'tool_use');
    assert.equal(result.content.length, 1);
    const block = result.content[0];
    assert.equal(block.type, 'tool_use');
    assert.equal(block.name, 'get_weather', 'the model sees external_tool_0; the caller must see its own name');
    assert.match(block.id, /^toolu_[0-9a-f]{32}$/);
    assert.deepEqual(block.input, { city: 'Taipei' }, 'string arguments must arrive as a parsed object');
    assert.equal(result.usage.output_tokens, Math.ceil(Buffer.byteLength(JSON.stringify({ city: 'Taipei' })) / 4));
    assert.equal(gen()[0].toolCalls[0].name, 'external_tool_0');
  }, { script: callThenAnswer() });
});

test('the tool_use block is streamed as start, input_json_delta and stop', async () => {
  // A caller that assembles input from input_json_delta sees nothing if the adapter puts the
  // arguments in content_block_start instead, or omits the delta.
  await withAdapter(async ({ adapter }) => {
    const events = [];
    const result = await adapter.messages(ask(), { onEvent: event => events.push(event) });
    assert.deepEqual(events.map(event => event.type), [
      'message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop',
    ]);
    const [, start, delta, , end] = events;
    assert.equal(start.content_block.type, 'tool_use');
    assert.equal(start.content_block.name, 'get_weather');
    assert.equal(start.content_block.id, result.content[0].id, 'the streamed id must be the id the caller answers with');
    assert.deepEqual(start.content_block.input, {}, 'input arrives as a json delta, so the opening block is empty');
    assert.equal(delta.delta.type, 'input_json_delta');
    assert.deepEqual(JSON.parse(delta.delta.partial_json), { city: 'Taipei' });
    assert.equal(end.delta.stop_reason, 'tool_use');
  }, { script: callThenAnswer() });
});

test('a matching tool_result continues the same conversation instead of starting a new thread', async () => {
  // The whole point of the context bookkeeping: the Codex turn is still open, so the second
  // request must not open a thread or re-inject the history.
  await withAdapter(async ({ adapter, gen, threads }) => {
    const first = await adapter.messages(ask());
    const second = await adapter.messages(followUp(ask(), first, [okResult(toolUseOf(first).id)]));
    assert.equal(second.stop_reason, 'end_turn');
    assert.equal(threads(), 1, 'the continuation must reuse the live Codex thread');
    assert.equal(gen().length, 1, 'no second bridge may be spawned for a continuation');
    assert.deepEqual(gen()[0].calls.map(call => call.method), ['turn/start'],
      'a continuation resolves the pending tool call; it must not inject history or start a turn');
  }, { script: callThenAnswer() });
});

test('the continuation hands the result to Codex and returns the model next text', async () => {
  await withAdapter(async ({ adapter, gen }) => {
    const first = await adapter.messages(ask());
    const second = await adapter.messages(followUp(ask(), first, [okResult(toolUseOf(first).id)]));
    assert.deepEqual(second.content, [{ type: 'text', text: 'It is sunny in Taipei.' }]);
    assert.equal(second.stop_reason, 'end_turn');
    assert.notEqual(second.id, first.id, 'each turn is its own message');
    const handed = gen()[0].toolCalls[0].value;
    assert.equal(handed.success, true);
    assert.deepEqual(handed.__codexContentItems, [{ type: 'inputText', text: 'Sunny, 30C' }]);
  }, { script: callThenAnswer() });
});

test('extra user text alongside a tool_result steers the live turn', async () => {
  // Late user input cannot be dropped, and it cannot be sent as a fresh turn either: the
  // previous turn is still open, so it has to go through turn/steer with the live turn id.
  await withAdapter(async ({ adapter, gen }) => {
    const first = await adapter.messages(ask());
    const second = await adapter.messages(followUp(ask(), first, [
      okResult(toolUseOf(first).id),
      { type: 'text', text: 'Also include humidity.' },
    ]));
    const bridge = gen()[0];
    const steer = bridge.calls.find(call => call.method === 'turn/steer');
    assert.ok(steer, 'trailing user text must be steered into the open turn');
    assert.equal(steer.params.threadId, bridge.threadId);
    assert.equal(steer.params.expectedTurnId, bridge.activeTurns.get(bridge.threadId));
    assert.ok(steer.params.expectedTurnId, 'steering without the live turn id would race a stale turn');
    assert.deepEqual(steer.params.input, [{ type: 'text', text: 'Also include humidity.' }]);
    assert.equal(second.stop_reason, 'end_turn');
  }, { script: callThenAnswer() });
});

test('a tool_result id the conversation never issued is rejected, not silently replayed', async () => {
  // A caller that invents or mangles an id must be told, and the live conversation must
  // survive so the correct follow-up still works.
  await withAdapter(async ({ adapter, threads }) => {
    const first = await adapter.messages(ask());
    const id = toolUseOf(first).id;
    const bogus = `toolu_${'f'.repeat(32)}`;
    await assert.rejects(
      () => adapter.messages(followUp(ask(), first, [okResult(id), okResult(bogus, 'stale')])),
      error => {
        assert.equal(error.name, 'AdapterError');
        assert.equal(error.status, 400);
        assert.equal(error.type, 'invalid_request_error');
        assert.match(error.message, /unknown, duplicated, or already consumed/);
        return true;
      });
    assert.equal(threads(), 1, 'the rejected request must not quietly open a second conversation');
    const second = await adapter.messages(followUp(ask(), first, [okResult(id)]));
    assert.equal(second.stop_reason, 'end_turn', 'the conversation must survive a rejected follow-up');
    assert.equal(threads(), 1);
  }, { script: callThenAnswer() });
});

test('a tool_result that was already consumed is rejected', async () => {
  // Replaying an answered tool_use would let a caller resolve the same call twice and
  // desynchronise the open Codex turn.
  await withAdapter(async ({ adapter, threads }) => {
    const body = ask();
    const first = await adapter.messages(body);
    const firstId = toolUseOf(first).id;
    const afterFirst = followUp(body, first, [okResult(firstId)]);
    const second = await adapter.messages(afterFirst);
    assert.equal(second.stop_reason, 'tool_use', 'the model asked for a second tool call');
    const secondId = toolUseOf(second).id;
    assert.notEqual(secondId, firstId);
    await assert.rejects(
      () => adapter.messages(followUp(afterFirst, second, [okResult(firstId), okResult(secondId)])),
      error => {
        assert.equal(error.status, 400);
        assert.match(error.message, /unknown, duplicated, or already consumed/);
        return true;
      });
    assert.equal(threads(), 1, 'the rejected replay must not start a fresh conversation');
  }, { script: callTwice });
});

/*
 * SUSPECTED DEFECT (left failing on purpose; adapter.mjs must not be changed to suit it).
 *
 * adapter.mjs:493-496 validates each supplied tool_result against context.tools, but the
 * `resolved` flag it checks is only set later, in the loop at adapter.mjs:518-521. Two
 * tool_result blocks with the same tool_use_id therefore both pass validation; the first
 * resolves the pending call and the second is dropped on the floor, because resolving an
 * already-settled promise is a no-op. The caller gets a normal answer and is never told that
 * one of the two results it supplied was discarded, even though the adapter's own error
 * message claims duplicates are refused.
 */
test('rejects a duplicated tool_result for the same tool_use_id', { todo: true }, async () => {
  await withAdapter(async ({ adapter, gen }) => {
    const first = await adapter.messages(ask());
    const id = toolUseOf(first).id;
    await assert.rejects(
      () => adapter.messages(followUp(ask(), first, [okResult(id, 'Sunny, 30C'), okResult(id, 'Actually, raining')])),
      error => {
        assert.equal(error.status, 400);
        assert.match(error.message, /unknown, duplicated, or already consumed/);
        return true;
      });
    assert.equal(gen()[0].toolCalls[0].value, null, 'no duplicated result may reach Codex');
  }, { script: callThenAnswer() });
});

test('parallel tool calls are delivered as one multi-block tool_use response', async () => {
  // Two calls made in the same tick must be batched into a single response; delivering one
  // and holding the other would stall the caller's parallel execution.
  await withAdapter(async ({ adapter }) => {
    const result = await adapter.messages(ask({ tools: [weather, stock] }));
    assert.equal(result.stop_reason, 'tool_use');
    assert.deepEqual(result.content.map(block => block.type), ['tool_use', 'tool_use']);
    assert.deepEqual(result.content.map(block => block.name), ['get_weather', 'lookup_stock']);
    assert.deepEqual(result.content[1].input, { ticker: '2330' });
    assert.notEqual(result.content[0].id, result.content[1].id, 'each call needs its own id');
  }, { script: callBoth });
});

test('omitting a result for an outstanding tool_use is rejected', async () => {
  // Resolving only one of two open calls would leave the Codex turn waiting forever while
  // the caller believed the conversation had moved on.
  await withAdapter(async ({ adapter, threads }) => {
    const body = ask({ tools: [weather, stock] });
    const first = await adapter.messages(body);
    const [a, b] = first.content;
    await assert.rejects(
      () => adapter.messages(followUp(body, first, [okResult(a.id)])),
      error => {
        assert.equal(error.status, 400);
        assert.equal(error.type, 'invalid_request_error');
        assert.match(error.message, /results for every outstanding tool_use/);
        return true;
      });
    assert.equal(threads(), 1);
    const second = await adapter.messages(followUp(body, first, [okResult(a.id), okResult(b.id, '2330 is up')]));
    assert.equal(second.stop_reason, 'end_turn', 'supplying both results completes the turn');
  }, { script: callBoth });
});

test('changing the tool set abandons the conversation and replays the history', async () => {
  // The live thread was started with one tool set; continuing it would hide the new tool from
  // the model. The adapter must tear it down and rebuild the conversation from the transcript.
  await withAdapter(async ({ adapter, gen, threads }) => {
    const first = await adapter.messages(ask());
    const id = toolUseOf(first).id;
    const widened = ask({ tools: [weather, stock] });
    const second = await adapter.messages(followUp(widened, first, [okResult(id)]));
    assert.equal(second.stop_reason, 'end_turn');
    assert.equal(threads(), 2, 'a changed tool set requires a new thread');
    assert.equal(gen().length, 2);
    const [abandoned, replayed] = gen();
    assert.deepEqual(abandoned.interrupted, [abandoned.threadId], 'the abandoned turn must be interrupted');
    assert.equal(abandoned.closed, 1, 'the abandoned bridge must be closed');
    assert.ok(abandoned.toolCalls[0].error, 'the pending tool call must be cancelled, not left hanging');
    assert.deepEqual(replayed.calls.map(call => call.method), ['thread/inject_items', 'turn/start']);
    const items = replayed.calls[0].params.items;
    const call = items.find(item => item.type === 'function_call');
    assert.equal(call.call_id, id, 'the replayed call must keep the id the caller answered');
    assert.equal(call.name, 'external_tool_0');
    assert.deepEqual(JSON.parse(call.arguments), { city: 'Taipei' });
    const output = items.find(item => item.type === 'function_call_output');
    assert.equal(output.call_id, id);
    assert.deepEqual(output.output, [{ type: 'input_text', text: 'Sunny, 30C' }]);
    assert.match(replayed.calls[1].params.input[0].text, /after the latest external tool results/);
  }, { script: callThenAnswer() });
});

test('changing the model abandons the conversation even when the tools match', async () => {
  // The tool set is unchanged here, so this only passes if the model is compared separately
  // from the request signature.
  await withAdapter(async ({ adapter, gen, threads }) => {
    const first = await adapter.messages(ask());
    const second = await adapter.messages(followUp(ask({ model: 'gpt-5-mini' }), first, [okResult(toolUseOf(first).id)]));
    assert.equal(second.stop_reason, 'end_turn');
    assert.equal(threads(), 2);
    assert.equal(gen()[0].startThreads[0].model, 'gpt-5-codex');
    assert.equal(gen()[1].startThreads[0].model, 'gpt-5-mini');
    assert.equal(second.model, 'gpt-5-mini', 'the response must report the model that answered');
  }, { script: callThenAnswer() });
});

test('tool_choice tool exposes only that tool and fails if the turn answers without it', async () => {
  // The adapter cannot constrain Codex the way the Messages API constrains Claude, so the
  // forced choice is enforced after the fact. Returning the bare text would silently break
  // a caller that requires a tool call.
  await withAdapter(async ({ adapter, gen }) => {
    await assert.rejects(
      () => adapter.messages(ask({ tools: [stock, weather], tool_choice: { type: 'tool', name: 'get_weather' } })),
      error => {
        assert.equal(error.status, 502);
        assert.equal(error.type, 'api_error');
        assert.match(error.message, /did not satisfy the requested forced tool choice/);
        return true;
      });
    assert.deepEqual(gen()[0].options.toolDefinitions.map(tool => tool.name), ['external_tool_1'],
      'only the forced tool may be exposed, and it keeps its index-based name');
    assert.match(gen()[0].startThreads[0].instructions, /request only the external tool external_tool_1/);
  }, { script: textOnly() });
});

test('tool_choice any fails if the turn completes without calling a tool', async () => {
  await withAdapter(async ({ adapter, gen }) => {
    await assert.rejects(
      () => adapter.messages(ask({ tool_choice: { type: 'any' } })),
      error => {
        assert.equal(error.status, 502);
        assert.match(error.message, /did not satisfy the requested forced tool choice/);
        return true;
      });
    assert.match(gen()[0].startThreads[0].instructions, /Request at least one supplied external tool before replying/);
  }, { script: textOnly() });
});

test('a satisfied tool_choice tool returns the tool_use normally', async () => {
  // Guards against the forced-choice check firing on a turn that did call the tool, which
  // would make forced tool use unusable rather than merely strict.
  await withAdapter(async ({ adapter }) => {
    const result = await adapter.messages(ask({ tool_choice: { type: 'tool', name: 'get_weather' } }));
    assert.equal(result.stop_reason, 'tool_use');
    assert.equal(toolUseOf(result).name, 'get_weather');
  }, { script: callThenAnswer() });
});

test('a forced tool_choice still applies to the continuation turn', async () => {
  // Pins a sharp edge rather than a bug: the guard is per turn, so a caller that keeps
  // tool_choice any while returning the tool result is told the forced choice was not met
  // instead of getting the model's text answer. Matches Anthropic, where a forced choice
  // constrains every turn; the caller must relax tool_choice to finish the round trip, and
  // that change abandons the thread and replays the history (see the tool-set test above).
  await withAdapter(async ({ adapter, gen, threads }) => {
    const body = ask({ tool_choice: { type: 'any' } });
    const first = await adapter.messages(body);
    assert.equal(first.stop_reason, 'tool_use', 'the forced choice was satisfied on the first turn');
    await assert.rejects(
      () => adapter.messages(followUp(body, first, [okResult(toolUseOf(first).id)])),
      error => {
        assert.equal(error.status, 502);
        assert.match(error.message, /did not satisfy the requested forced tool choice/);
        return true;
      });
    // Relaxing the choice is the documented way out, and it rebuilds the conversation.
    const relaxed = await adapter.messages(followUp(ask(), first, [okResult(toolUseOf(first).id)]));
    assert.equal(relaxed.stop_reason, 'end_turn');
    assert.equal(threads(), 2, 'the failed forced turn tears the thread down, so the retry replays');
    assert.equal(gen()[0].closed, 1);
  }, { script: callThenAnswer() });
});

test('an is_error tool_result is conveyed to Codex as a failed result', async () => {
  // A failed caller tool must not look like a successful one, or the model will treat the
  // error text as data and answer from it.
  await withAdapter(async ({ adapter, gen }) => {
    const first = await adapter.messages(ask());
    const second = await adapter.messages(followUp(ask(), first, [{
      type: 'tool_result',
      tool_use_id: toolUseOf(first).id,
      is_error: true,
      content: [{ type: 'text', text: 'weather service unavailable' }],
    }]));
    const handed = gen()[0].toolCalls[0].value;
    assert.equal(handed.success, false, 'an is_error result must not be reported as a success');
    assert.deepEqual(handed.__codexContentItems, [
      { type: 'inputText', text: 'The external tool returned an error.' },
      { type: 'inputText', text: 'weather service unavailable' },
    ]);
    assert.equal(second.stop_reason, 'end_turn', 'an error result still lets the turn finish');
  }, { script: callThenAnswer() });
});

test('tool results from two different conversations cannot be mixed in one request', async () => {
  // Each open conversation owns a live Codex turn. Guessing which one a mixed batch belongs
  // to would resolve one turn's call with another turn's answer.
  await withAdapter(async ({ adapter, threads }) => {
    const one = await adapter.messages(ask());
    const two = await adapter.messages(ask({ messages: [{ role: 'user', content: 'What is the weather in Tainan?' }] }));
    const first = toolUseOf(one);
    const other = toolUseOf(two);
    assert.notEqual(first.id, other.id);
    assert.equal(threads(), 2, 'two independent requests must each get their own thread');
    const mixed = ask({
      messages: [
        { role: 'user', content: 'What is the weather?' },
        { role: 'assistant', content: [first, other] },
        { role: 'user', content: [okResult(first.id), okResult(other.id, 'Sunny, 31C')] },
      ],
    });
    await assert.rejects(
      () => adapter.messages(mixed),
      error => {
        assert.equal(error.status, 400);
        assert.equal(error.type, 'invalid_request_error');
        assert.match(error.message, /different active conversations/);
        return true;
      });
    assert.equal(threads(), 2, 'the rejected request must not open a third conversation');
  }, { script: callThenAnswer() });
});

test('a tool the request did not expose is refused without failing the turn', async () => {
  // tool_choice none must really remove the tools. If the adapter forwarded the call the
  // caller would be asked to run something it never offered.
  await withAdapter(async ({ adapter, gen }) => {
    const result = await adapter.messages(ask({ tool_choice: { type: 'none' } }));
    assert.equal(gen()[0].options.toolDefinitions.length, 0);
    const refused = gen()[0].toolCalls[0];
    assert.equal(refused.error.status, 400);
    assert.match(refused.error.message, /not exposed by this request/);
    assert.equal(result.stop_reason, 'end_turn');
    assert.deepEqual(result.content, [{ type: 'text', text: 'I cannot check the weather.' }]);
    assert.ok(!result.content.some(block => block.type === 'tool_use'));
  }, {
    script: async bridge => {
      const call = await bridge.callTool('external_tool_0', '{"city":"Taipei"}');
      bridge.say(call.error ? 'I cannot check the weather.' : 'unexpectedly allowed');
      bridge.finishTurn();
    },
  });
});

test('unparsable tool arguments are refused without inventing an input object', async () => {
  // Catches a regression that passed raw argument text through as the tool_use input, which
  // the caller would then try to execute.
  await withAdapter(async ({ adapter, gen }) => {
    const result = await adapter.messages(ask());
    const refused = gen()[0].toolCalls[0];
    assert.equal(refused.error.status, 400);
    assert.match(refused.error.message, /invalid tool arguments/);
    assert.equal(result.stop_reason, 'end_turn');
    assert.ok(!result.content.some(block => block.type === 'tool_use'), 'no tool_use may be emitted for a bad call');
  }, {
    script: async bridge => {
      const call = await bridge.callTool('external_tool_0', 'city=Taipei');
      bridge.say(call.error ? 'Sorry, I mis-called the tool.' : 'unexpectedly accepted');
      bridge.finishTurn();
    },
  });
});

test('a tool call that does not fit in max_tokens stops the response and cancels the call', async () => {
  // The caller gets no tool_use block, so it can never answer this call; leaving the
  // conversation and the pending promise alive would strand both.
  await withAdapter(async ({ adapter, gen }) => {
    const result = await adapter.messages(ask({ max_tokens: 1 }));
    assert.equal(result.stop_reason, 'max_tokens');
    assert.deepEqual(result.content, [], 'a tool_use that exceeds the budget must not be half-emitted');
    const record = await gen()[0].toolCalls[0].settled;
    assert.match(record.error.message, /Conversation finished/, 'the undeliverable call must be cancelled');
  }, { script: callThenAnswer() });
});

test('a tool_use_id from an expired conversation is replayed into a fresh thread', async () => {
  // The adapter's own expiry error tells callers to "replay the full conversation", so an id
  // no live context owns is rebuilt from the transcript rather than rejected. This pins that
  // recovery path: history is re-injected, including the call and its result.
  await withAdapter(async ({ adapter, gen, threads }) => {
    const stale = `toolu_${'a'.repeat(32)}`;
    const result = await adapter.messages(ask({
      messages: [
        { role: 'user', content: 'What is the weather in Taipei?' },
        { role: 'assistant', content: [{ type: 'tool_use', id: stale, name: 'get_weather', input: { city: 'Taipei' } }] },
        { role: 'user', content: [okResult(stale)] },
      ],
    }));
    assert.equal(result.stop_reason, 'end_turn');
    assert.equal(threads(), 1);
    assert.deepEqual(gen()[0].calls.map(call => call.method), ['thread/inject_items', 'turn/start']);
    const items = gen()[0].calls[0].params.items;
    assert.equal(items.find(item => item.type === 'function_call').call_id, stale);
    assert.equal(items.find(item => item.type === 'function_call_output').call_id, stale);
  }, { script: callThenAnswer() });
});

test('disable_parallel_tool_use holds the second call back for the next turn', async () => {
  // The held call must not be lost: it is delivered once the first result arrives, without
  // any new Codex request, because the original turn is still open.
  await withAdapter(async ({ adapter, gen }) => {
    const body = ask({ tools: [weather, stock], tool_choice: { type: 'auto', disable_parallel_tool_use: true } });
    const first = await adapter.messages(body);
    assert.equal(first.content.length, 1, 'only one call may be delivered per response');
    assert.equal(first.content[0].name, 'get_weather');
    const second = await adapter.messages(followUp(body, first, [okResult(first.content[0].id)]));
    assert.equal(second.stop_reason, 'tool_use');
    assert.equal(second.content.length, 1);
    assert.equal(second.content[0].name, 'lookup_stock', 'the held call must surface on the next turn');
    assert.deepEqual(gen()[0].calls.map(call => call.method), ['turn/start'],
      'the held call is already in flight, so no new turn may be started');
  }, { script: callBoth });
});
