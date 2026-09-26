/**
 * Tests for model resolution, the model catalog and token counting.
 *
 * The application asks for Claude model ids — for user chat and for its background work —
 * while the account behind this bridge only offers GPT models. Everything here pins how
 * that mismatch is resolved: which id reaches the Codex thread, which id the caller is
 * told it got, how often the catalog is fetched, and what count_tokens will or will not
 * refuse. Nothing spawns Codex or touches the network; every bridge is a fake.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { Adapter, AdapterError } from './adapter.mjs';

// The Adapter's model default is read from SCIENCE_CHATGPT_MODEL at construction time,
// so a value in the developer's environment would silently change what "no model" means.
const priorEnvModel = process.env.SCIENCE_CHATGPT_MODEL;
delete process.env.SCIENCE_CHATGPT_MODEL;

// The adapter mkdir()s its cwd; keep that well away from any real installation.
const CWD = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-models-test-'));
after(async () => {
  if (priorEnvModel !== undefined) process.env.SCIENCE_CHATGPT_MODEL = priorEnvModel;
  await fs.rm(CWD, { recursive: true, force: true });
});

/**
 * Shaped like a Codex `model/list` page: the adapter reads `model`/`id`, `displayName`,
 * `isDefault` and `supportedReasoningEfforts[].reasoningEffort` and nothing else.
 */
const CATALOG = [
  {
    id: 'gpt-5.1-codex', model: 'gpt-5.1-codex', displayName: 'GPT-5.1-Codex', isDefault: true,
    supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }, { reasoningEffort: 'high' }],
  },
  {
    id: 'gpt-5.1-codex-mini', model: 'gpt-5.1-codex-mini', displayName: 'GPT-5.1-Codex mini', isDefault: false,
    supportedReasoningEfforts: [{ reasoningEffort: 'medium' }],
  },
];
const DEFAULT_MODEL = 'gpt-5.1-codex';

/** The ids the application actually sends, including a dated one. */
const CLAUDE_IDS = ['claude-opus-5', 'claude-opus-5-5', 'claude-sonnet-5', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'];

/**
 * An Adapter wired to fake bridges plus a log of everything the adapter asked them for.
 * A fresh bridge is handed out per bridgeFactory call, exactly as the real code expects,
 * while the counters stay shared so catalog fetches can be counted across all of them.
 */
function harness({ catalog = CATALOG, accountType = 'chatgpt', text = 'ok', ...options } = {}) {
  const log = { factory: [], models: 0, accounts: 0, startThread: [], requests: [], closed: 0 };
  let threads = 0;
  const bridgeFactory = factoryOptions => {
    log.factory.push(factoryOptions);
    const bridge = new EventEmitter();
    const threadId = `thread_${threads++}`;
    bridge.activeTurns = new Map();
    bridge.account = async () => { log.accounts += 1; return { account: { type: accountType } }; };
    // A fresh array per call, as the real bridge builds while paging model/list; the
    // adapter must be holding its own snapshot, not the caller's live array.
    bridge.models = async () => { log.models += 1; return catalog.map(entry => ({ ...entry })); };
    bridge.startThread = async started => { log.startThread.push(started); return { thread: { id: threadId } }; };
    bridge.request = async (method, params) => {
      log.requests.push({ method, params });
      // Answer the turn on a later tick. Emitting inside request() would exercise the
      // backlog path instead of the ordinary one, which other suites cover.
      if (method === 'turn/start') {
        setTimeout(() => {
          const notify = (notification, params2) => bridge.emit('notification', { method: notification, params: { threadId, ...params2 } });
          notify('item/agentMessage/delta', { itemId: 'item_1', delta: text });
          notify('item/completed', { item: { type: 'agentMessage', id: 'item_1', text } });
          notify('turn/completed', { turn: { status: 'completed' } });
        }, 0);
      }
      return {};
    };
    bridge.respondApproval = () => {};
    bridge.interrupt = async () => {};
    bridge.close = async () => { log.closed += 1; };
    return bridge;
  };
  return { adapter: new Adapter({ bridgeFactory, cwd: CWD, ...options }), log };
}

async function withAdapter(options, run) {
  const { adapter, log } = harness(options);
  try {
    return await run(adapter, log);
  } finally {
    // Always close: a live context keeps an expiry timer and a bridge around.
    await adapter.close();
  }
}

/** The catalog bridge is the one created without a tool handler or a helper purpose. */
const catalogBridges = log => log.factory.filter(options => !options.toolHandler && options.purpose === undefined);

const ask = (extra = {}) => ({ max_tokens: 64, messages: [{ role: 'user', content: 'hi' }], ...extra });

/** Assert a rejection by its AdapterError fields, never merely that something threw. */
function rejects(promise, { status, type = 'invalid_request_error', message }) {
  return assert.rejects(promise, error => {
    assert.ok(error instanceof AdapterError, `expected an AdapterError, got ${error}`);
    assert.equal(error.status, status);
    assert.equal(error.type, type);
    assert.match(error.message, message);
    return true;
  });
}

// ---------------------------------------------------------------------------
// The catalog the caller sees
// ---------------------------------------------------------------------------

test('models() surfaces the catalog the bridge reported, in the shape the caller reads', async () => {
  await withAdapter({}, async (adapter, log) => {
    const list = await adapter.models();
    assert.equal(log.models, 1);
    assert.deepEqual(list.data.map(item => item.id), ['gpt-5.1-codex', 'gpt-5.1-codex-mini'], 'catalog order must be preserved');
    assert.deepEqual(list.data.map(item => item.type), ['model', 'model']);
    assert.deepEqual(list.data.map(item => item.display_name), ['GPT-5.1-Codex', 'GPT-5.1-Codex mini']);
    assert.equal(list.has_more, false);
    assert.equal(list.first_id, 'gpt-5.1-codex');
    assert.equal(list.last_id, 'gpt-5.1-codex-mini');
    // created_at is the refresh time, and the adapter says so rather than implying a release date.
    assert.ok(!Number.isNaN(Date.parse(list.data[0].created_at)), 'created_at must be an ISO timestamp');
    assert.equal(list._bridge.created_at_is_catalog_refresh_time, true);
    // The list is the ChatGPT account's own models; it must not invent Claude entries.
    assert.ok(!list.data.some(item => item.id.startsWith('claude-')));
  });
});

// Codex entries are not guaranteed to carry model/displayName; the gateway's /v1/models
// response is read for display_name, so a fallback regression would surface as undefined.
test('models() falls back to the raw id when the catalog omits model and displayName', async () => {
  await withAdapter({ catalog: [{ id: 'gpt-bare' }] }, async adapter => {
    const [entry] = (await adapter.models()).data;
    assert.deepEqual({ id: entry.id, display_name: entry.display_name, type: entry.type }, { id: 'gpt-bare', display_name: 'gpt-bare', type: 'model' });
  });
});

// An empty list must be an error, not an empty catalog the application would silently
// start against and then fail on every request.
test('an empty catalog is a 503 instead of an empty model list', async () => {
  await withAdapter({ catalog: [] }, async adapter => {
    await rejects(adapter.models(), { status: 503, type: 'api_error', message: /no available models/ });
    await rejects(adapter.messages(ask({ model: 'claude-opus-5' })), { status: 503, type: 'api_error', message: /no available models/ });
  });
});

// The catalog read doubles as the sign-in gate: an API-key Codex session must not serve
// inference, and must be refused before a thread exists.
test('a non-ChatGPT Codex sign-in is a 401 before any thread starts', async () => {
  await withAdapter({ accountType: 'apiKey' }, async (adapter, log) => {
    await rejects(adapter.messages(ask({ model: 'claude-opus-5' })), { status: 401, type: 'authentication_error', message: /managed ChatGPT account/ });
    assert.deepEqual(log.startThread, [], 'no thread may be started for a rejected account');
  });
});

// The catalog bridge exists only to read the account and the model list; handing it tool
// definitions or a tool handler would give a non-inference bridge tool reach.
test('the catalog bridge is created without tools', async () => {
  await withAdapter({}, async (adapter, log) => {
    await adapter.models();
    const [options] = catalogBridges(log);
    assert.equal(options.toolDefinitions, undefined);
    assert.equal(options.toolHandler, undefined);
    assert.equal(options.cwd, path.resolve(CWD));
  });
});

// ---------------------------------------------------------------------------
// Resolving the requested model
// ---------------------------------------------------------------------------

test('every Claude model id the application sends is served by the account model', async () => {
  await withAdapter({}, async (adapter, log) => {
    for (const model of CLAUDE_IDS) {
      const result = await adapter.messages(ask({ model }));
      assert.equal(result.content[0].text, 'ok', `${model} must be answered, not rejected`);
      assert.equal(result.stop_reason, 'end_turn');
      // The reported id must be the model that actually ran, not the id that was asked for.
      assert.equal(result.model, DEFAULT_MODEL, `${model} must report the ChatGPT model that served it`);
      assert.notEqual(result.model, model);
      assert.equal(log.startThread.at(-1).model, DEFAULT_MODEL, `${model} must resolve before startThread`);
    }
    assert.equal(log.startThread.length, CLAUDE_IDS.length);
    assert.ok(!JSON.stringify(log.startThread).includes('claude-'), 'no Claude model id may reach Codex');
  });
});

// isDefault, not position, decides: the default is the second entry here on purpose.
test('a request with no model at all is served by the account default', async () => {
  const catalog = [
    { id: 'gpt-other', model: 'gpt-other', displayName: 'Other' },
    { id: 'gpt-account-default', model: 'gpt-account-default', displayName: 'Account default', isDefault: true },
  ];
  await withAdapter({ catalog }, async (adapter, log) => {
    const result = await adapter.messages(ask());
    assert.equal(result.model, 'gpt-account-default');
    assert.equal(log.startThread.at(-1).model, 'gpt-account-default');
  });
});

// Codex does not always flag a default; falling back to the first entry beats failing.
test('with no default flagged, the first catalog entry serves the request', async () => {
  await withAdapter({ catalog: [{ id: 'gpt-first' }, { id: 'gpt-second' }] }, async adapter => {
    assert.equal((await adapter.messages(ask())).model, 'gpt-first');
  });
});

test('a configured model is honoured and reaches startThread', async () => {
  await withAdapter({ model: 'gpt-5.1-codex-mini' }, async (adapter, log) => {
    const result = await adapter.messages(ask({ model: 'claude-opus-5' }));
    assert.equal(result.model, 'gpt-5.1-codex-mini', 'the configured model must win over the account default');
    assert.equal(log.startThread.at(-1).model, 'gpt-5.1-codex-mini');
  });
});

// The production path sets the model through the environment, not the constructor.
test('SCIENCE_CHATGPT_MODEL configures the model when the constructor is given none', async () => {
  process.env.SCIENCE_CHATGPT_MODEL = 'gpt-5.1-codex-mini';
  try {
    await withAdapter({}, async adapter => {
      assert.equal((await adapter.messages(ask({ model: 'claude-sonnet-5' }))).model, 'gpt-5.1-codex-mini');
    });
  } finally {
    delete process.env.SCIENCE_CHATGPT_MODEL;
  }
});

// Precedence: an id the account really offers is used as asked, configuration notwithstanding.
test('an available requested id beats the configured model', async () => {
  await withAdapter({ model: 'gpt-5.1-codex-mini' }, async adapter => {
    assert.equal((await adapter.messages(ask({ model: 'gpt-5.1-codex' }))).model, 'gpt-5.1-codex');
  });
});

test('a configured model missing from the catalog is a 400 naming the variable to fix', async () => {
  await withAdapter({ model: 'gpt-nonexistent' }, async (adapter, log) => {
    await rejects(adapter.messages(ask({ model: 'claude-opus-5' })), { status: 400, message: /SCIENCE_CHATGPT_MODEL is not available/ });
    assert.deepEqual(log.startThread, [], 'an unresolvable model must not start a thread');
  });
});

// Behaviour read off _model(): the claude- prefix is what triggers remapping. Anything
// else that the account does not offer is a 400 — so a mistyped GPT id fails loudly
// instead of being quietly served by some other model.
test('a non-Claude model the account does not offer is rejected before a thread starts', async () => {
  await withAdapter({}, async (adapter, log) => {
    await rejects(adapter.messages(ask({ model: 'gpt-4o-mini' })), { status: 400, message: /not available to this ChatGPT account/ });
    assert.deepEqual(log.startThread, []);
    assert.deepEqual(log.requests, [], 'nothing may be sent to Codex for an unresolvable model');
  });
});

// The other half of the same rule: an unknown claude-* id is remapped rather than
// rejected, which is what lets a newer application build work against an older bridge.
test('an unknown claude-* id is still served, and the remap is case-sensitive', async () => {
  await withAdapter({}, async adapter => {
    assert.equal((await adapter.messages(ask({ model: 'claude-fictional-9-20990101' }))).model, DEFAULT_MODEL);
    await rejects(adapter.messages(ask({ model: 'Claude-Opus-5' })), { status: 400, message: /not available to this ChatGPT account/ });
  });
});

test('a non-string model is refused as a request error', async () => {
  await withAdapter({}, async (adapter, log) => {
    await rejects(adapter.messages(ask({ model: { id: 'claude-opus-5' } })), { status: 400, message: /model must be a string/ });
    assert.equal(log.models, 0, 'a malformed model must be caught before the account is consulted');
  });
});

// ---------------------------------------------------------------------------
// Catalog caching
// ---------------------------------------------------------------------------

test('the catalog is fetched once across several requests', async () => {
  await withAdapter({}, async (adapter, log) => {
    for (const model of ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001']) await adapter.messages(ask({ model }));
    await adapter.models();
    assert.equal(log.models, 1, 'the model list must not be refetched per request');
    assert.equal(catalogBridges(log).length, 1, 'only one catalog bridge may ever be created');
  });
});

// Two requests racing on a cold cache must share the in-flight fetch, not each start one.
test('concurrent first requests share a single catalog fetch', async () => {
  await withAdapter({}, async (adapter, log) => {
    const results = await Promise.all([adapter.messages(ask({ model: 'claude-opus-5' })), adapter.messages(ask({ model: 'claude-sonnet-5' }))]);
    assert.deepEqual(results.map(result => result.model), [DEFAULT_MODEL, DEFAULT_MODEL]);
    assert.equal(log.models, 1);
    assert.equal(catalogBridges(log).length, 1);
  });
});

// The cache is per-Adapter state, so a second adapter (a second account/base) resolves
// against its own catalog. A module-level cache would serve the first account's models.
test('a second Adapter does not reuse the first adapter cached catalog', async () => {
  await withAdapter({ catalog: [{ id: 'gpt-account-a', isDefault: true }] }, async first => {
    assert.equal((await first.messages(ask())).model, 'gpt-account-a');
    await withAdapter({ catalog: [{ id: 'gpt-account-b', isDefault: true }] }, async (second, secondLog) => {
      assert.equal((await second.messages(ask())).model, 'gpt-account-b');
      assert.equal(secondLog.models, 1, 'the second adapter must read its own account');
    });
  });
});

// The cache has a 30s TTL. Rather than sleeping it out, age the recorded fetch time:
// this pins both that the TTL is consulted and that a refresh reuses the same bridge.
test('an expired catalog refetches on the existing catalog bridge', async () => {
  const rotating = CATALOG.map(entry => ({ ...entry }));
  await withAdapter({ catalog: rotating }, async (adapter, log) => {
    const first = await adapter.models();
    rotating.push({ id: 'gpt-late', model: 'gpt-late', displayName: 'GPT Late' });
    assert.deepEqual((await adapter.models()).data.map(item => item.id), first.data.map(item => item.id), 'a warm cache must not see a new entry');
    assert.equal(log.models, 1);
    adapter.catalogAt = 0;
    assert.ok((await adapter.models()).data.some(item => item.id === 'gpt-late'), 'an expired cache must refetch');
    assert.equal(log.models, 2);
    assert.equal(catalogBridges(log).length, 1, 'a refresh must not spawn another Codex process');
  });
});

// ---------------------------------------------------------------------------
// countTokens
// ---------------------------------------------------------------------------

test('countTokens returns a positive integer estimate and grows with more input', async () => {
  await withAdapter({}, async (adapter, log) => {
    const small = await adapter.countTokens({ model: 'claude-opus-5', messages: [{ role: 'user', content: 'hi' }] });
    assert.ok(Number.isInteger(small.input_tokens) && small.input_tokens > 0, `expected a positive integer, got ${small.input_tokens}`);
    assert.equal(small.estimated, true, 'the caller must be told this is not a billed count');
    assert.equal(small.image_count, 0);
    assert.equal(small.estimated_tokens_per_image, 1024);
    assert.equal(typeof small.estimate_method, 'string');
    assert.match(small.estimate_method, /estimate|divided by four/i);

    const large = await adapter.countTokens({ model: 'claude-opus-5', system: 'x'.repeat(400), messages: [{ role: 'user', content: 'y'.repeat(8000) }] });
    assert.ok(Number.isInteger(large.input_tokens));
    assert.ok(large.input_tokens > small.input_tokens + 1500, `more input must cost more: ${small.input_tokens} then ${large.input_tokens}`);

    // count_tokens is pure estimation; it must not start a Codex process to answer.
    assert.deepEqual(log.factory, [], 'countTokens must not create a bridge');
  });
});

// The estimator deliberately drops image payloads: counting 8000 base64 characters as
// text would report roughly 2000 phantom tokens instead of the flat per-image allowance.
test('countTokens charges images a flat allowance instead of their payload', async () => {
  await withAdapter({}, async adapter => {
    const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(8000) } };
    const withoutImage = await adapter.countTokens({ messages: [{ role: 'user', content: [{ type: 'text', text: 'look' }] }] });
    const withImage = await adapter.countTokens({ messages: [{ role: 'user', content: [{ type: 'text', text: 'look' }, image] }] });
    assert.equal(withImage.image_count, 1);
    assert.ok(Number.isInteger(withImage.input_tokens) && withImage.input_tokens > 0);
    const added = withImage.input_tokens - withoutImage.input_tokens;
    assert.ok(added >= 1024 && added < 1124, `an image must cost about the 1024 allowance, not its payload; it added ${added}`);

    const two = await adapter.countTokens({ messages: [{ role: 'user', content: [image, image] }] });
    assert.equal(two.image_count, 2);
  });
});

// Historical thinking blocks are replaced by a marker rather than counted or rejected.
test('countTokens omits historical reasoning without throwing', async () => {
  await withAdapter({}, async adapter => {
    const history = extra => ({
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: [...extra, { type: 'text', text: 'answer' }] },
        { role: 'user', content: 'more' },
      ],
    });
    const plain = await adapter.countTokens(history([]));
    const reasoned = await adapter.countTokens(history([{ type: 'thinking', thinking: 'z'.repeat(8000), signature: 'sig' }]));
    const redacted = await adapter.countTokens(history([{ type: 'redacted_thinking', data: 'q'.repeat(8000) }]));
    for (const result of [reasoned, redacted]) {
      assert.ok(Number.isInteger(result.input_tokens) && result.input_tokens > 0);
      const added = result.input_tokens - plain.input_tokens;
      assert.ok(added < 30, `reasoning must be replaced by a marker, not counted; it added ${added}`);
    }
  });
});

test('countTokens and messages() both refuse a body with no messages array', async () => {
  await withAdapter({}, async (adapter, log) => {
    for (const body of [null, {}, { messages: 'hi' }, { messages: { 0: {} } }]) {
      await rejects(adapter.countTokens(body), { status: 400, message: /messages must be an array|must be an object/ });
      await rejects(adapter.messages(body), { status: 400, message: /messages must (be an array|contain)|must be an object/ });
    }
    assert.equal(log.models, 0, 'a malformed body must be refused without consulting the account');
  });
});

// Pins the ACTUAL behaviour, which differs from messages(): countTokens() never calls
// prepare(), so these bodies get a token count. The todo test below asserts what the
// behaviour should be; if that defect is fixed, this pin is expected to fail and go.
test('countTokens currently counts bodies that messages() refuses (pinned, see the todo below)', async () => {
  const cases = [
    { body: { messages: [] }, rejection: /messages must contain/ },
    { body: { messages: [{ role: 'system', content: 'be brief' }] }, rejection: /user and assistant message roles/ },
    { body: { messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/bmp', data: 'AAAA' } }] }] }, rejection: /Unsupported image media type/ },
    { body: { messages: [{ role: 'user', content: [{ type: 'nonsense' }] }] }, rejection: /Unsupported input block type/ },
  ];
  await withAdapter({}, async adapter => {
    for (const { body, rejection } of cases) {
      await rejects(adapter.messages({ max_tokens: 16, ...body }), { status: 400, message: rejection });
      const counted = await adapter.countTokens(body);
      assert.ok(Number.isInteger(counted.input_tokens) && counted.input_tokens > 0, 'countTokens answers where messages() refuses');
    }
  });
});

// SUSPECTED DEFECT (left failing on purpose): countTokens() validates only that
// body.messages is an array (adapter.mjs:309) and never runs prepare()
// (adapter.mjs:112-167), so a caller that pre-flights a body is told it is fine and is
// then refused by /v1/messages. The real count_tokens endpoint validates the body.
test('countTokens applies the same body validation as messages()', { todo: true }, async () => {
  await withAdapter({}, async adapter => {
    await rejects(adapter.countTokens({ messages: [] }), { status: 400, message: /messages must contain/ });
    await rejects(adapter.countTokens({ messages: [{ role: 'system', content: 'be brief' }] }), { status: 400, message: /user and assistant message roles/ });
    await rejects(adapter.countTokens({ messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/bmp', data: 'AAAA' } }] }] }), { status: 400, message: /Unsupported image media type/ });
  });
});

// SUSPECTED DEFECT (left failing on purpose): countTokens() never resolves the model, so
// unlike messages() it neither checks the ChatGPT sign-in nor refuses an id the account
// does not offer. The estimate is model-independent, so this is a consistency gap rather
// than a wrong number — but the two endpoints disagree about the same request.
test('countTokens refuses a model the account does not offer, like messages()', { todo: true }, async () => {
  await withAdapter({ accountType: 'apiKey' }, async adapter => {
    await rejects(adapter.countTokens(ask({ model: 'gpt-4o-mini' })), { status: 400, message: /not available to this ChatGPT account/ });
  });
});

// ---------------------------------------------------------------------------
// Reasoning effort against the selected model
// ---------------------------------------------------------------------------

test('an effort the selected model supports reaches turn/start', async () => {
  await withAdapter({}, async (adapter, log) => {
    const result = await adapter.messages(ask({ model: 'claude-opus-5', output_config: { effort: 'high' } }));
    assert.equal(result.stop_reason, 'end_turn');
    const turn = log.requests.find(entry => entry.method === 'turn/start');
    assert.equal(turn.params.effort, 'high', 'a supported effort must be forwarded, not dropped');
  });
});

test('an effort the selected model does not support is refused before the turn starts', async () => {
  await withAdapter({}, async (adapter, log) => {
    await rejects(
      adapter.messages(ask({ model: 'claude-opus-5', output_config: { effort: 'minimal' } })),
      { status: 400, message: /effort is not supported by the selected ChatGPT model/ },
    );
    assert.ok(!log.requests.some(entry => entry.method === 'turn/start'), 'a refused effort must not start a turn');
  });
});

// The check must read the selected entry's own list: gpt-5.1-codex-mini reports only
// "medium", so a check against the whole catalog would wrongly accept "high" here.
test('the effort check follows the model actually selected', async () => {
  await withAdapter({ model: 'gpt-5.1-codex-mini' }, async adapter => {
    const accepted = await adapter.messages(ask({ model: 'claude-haiku-4-5-20251001', output_config: { effort: 'medium' } }));
    assert.equal(accepted.model, 'gpt-5.1-codex-mini');
    await rejects(
      adapter.messages(ask({ model: 'claude-opus-5', output_config: { effort: 'high' } })),
      { status: 400, message: /effort is not supported/ },
    );
  });
});

// A catalog entry with no reasoning-effort list refuses every effort rather than silently
// dropping it — the request is answered only when no effort is asked for.
test('a model that reports no reasoning efforts refuses every effort', async () => {
  await withAdapter({ catalog: [{ id: 'gpt-plain', model: 'gpt-plain', displayName: 'GPT Plain', isDefault: true }] }, async adapter => {
    await rejects(adapter.messages(ask({ output_config: { effort: 'medium' } })), { status: 400, message: /effort is not supported/ });
    assert.equal((await adapter.messages(ask())).model, 'gpt-plain');
  });
});
