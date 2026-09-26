/**
 * Tests for the translation layer's request validation.
 *
 * The bridge claims to be an Anthropic Messages endpoint, so a caller has no way to see
 * that ChatGPT is on the other side. Every Anthropic feature Codex cannot reproduce must
 * therefore come back as a clear refusal with an Anthropic-shaped status and type -- never
 * as a silently approximated answer. These tests pin the refusals, their status/type, and
 * the specific complaint, plus the narrow cases that are genuinely supported.
 *
 * Nothing here touches the network, the real Codex CLI, or any real data directory: every
 * bridge is a fake, and the refusal cases assert that no bridge is constructed at all.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { Adapter } from './adapter.mjs';

const CWD = path.join(os.tmpdir(), 'bridge-adapter-validation-test');
const MODELS = [
  { model: 'gpt-5-codex', displayName: 'GPT-5 Codex', isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'medium' }] },
  { model: 'gpt-5-mini', displayName: 'GPT-5 Mini' },
];

after(async () => { await fs.rm(CWD, { recursive: true, force: true }); });

/**
 * Stand-in for CodexBridge. Records every call, and replays a scripted notification
 * stream after `turn/start` -- asynchronously, so the adapter's normal in-flight path is
 * exercised rather than its event backlog.
 */
class FakeBridge extends EventEmitter {
  constructor(options, script) {
    super();
    this.options = options;
    this.script = script;
    this.calls = [];
    this.threadId = 'thread_fake';
    this.activeTurns = new Map();
    this.closed = false;
  }
  async account() { this.calls.push(['account']); return { account: { type: 'chatgpt' } }; }
  async models() { this.calls.push(['models']); return MODELS; }
  async startThread(params) { this.calls.push(['startThread', params]); return { thread: { id: this.threadId } }; }
  async request(method, params) {
    this.calls.push([method, params]);
    if (method === 'turn/start') setTimeout(() => this.script(this), 0);
    return {};
  }
  respondApproval() {}
  async interrupt() {}
  async close() { this.closed = true; }
}

/** The shortest complete turn: one streamed message, then a clean completion. */
function replyOnce(bridge, text = 'ok') {
  const threadId = bridge.threadId;
  const itemId = 'item_reply';
  bridge.emit('notification', { method: 'item/agentMessage/delta', params: { threadId, itemId, delta: text } });
  bridge.emit('notification', { method: 'item/completed', params: { threadId, item: { type: 'agentMessage', id: itemId, text } } });
  bridge.emit('notification', { method: 'turn/completed', params: { threadId, turn: { status: 'completed' } } });
}

/**
 * `model: null` rather than the constructor default, so a SCIENCE_CHATGPT_MODEL in the
 * environment cannot change which model the catalog default test resolves to.
 */
async function withAdapter(run, { script = replyOnce, ...options } = {}) {
  const bridges = [];
  const adapter = new Adapter({
    cwd: CWD,
    model: null,
    bridgeFactory: bridgeOptions => {
      const bridge = new FakeBridge(bridgeOptions, script);
      bridges.push(bridge);
      return bridge;
    },
    ...options,
  });
  try {
    return await run(adapter, bridges);
  } finally {
    await adapter.close();
  }
}

/** Expected-error shape for assert.rejects: pins status and type, not just "it threw". */
const refuses = (message, status = 400, type = 'invalid_request_error') => ({ name: 'AdapterError', status, type, message });

/** The bridge that was built to run the turn (the catalog bridge gets no tool handler). */
function turnBridge(bridges) {
  const bridge = bridges.find(item => item.options.toolHandler);
  assert.ok(bridge, 'expected the adapter to construct a generation bridge');
  return bridge;
}

/** Parameters of the one call to `method`; fails if the adapter made it twice or never. */
function paramsOf(bridge, method) {
  const matches = bridge.calls.filter(([name]) => name === method);
  assert.equal(matches.length, 1, `expected exactly one ${method} call, saw ${bridge.calls.map(([name]) => name).join(', ')}`);
  return matches[0][1];
}

/**
 * Declares a refusal case. `body` may be a factory so that the deliberately huge bodies are
 * only allocated while their own test runs. Also asserts the refusal happened before any
 * bridge existed: a request the adapter cannot honour must not spawn Codex first.
 */
function rejects(name, body, expected, options) {
  test(name, async () => {
    await withAdapter(async (adapter, bridges) => {
      await assert.rejects(() => adapter.messages(typeof body === 'function' ? body() : body), expected);
      assert.equal(bridges.length, 0, 'validation must refuse before constructing a bridge');
    }, options);
  });
}

const USER = content => ({ role: 'user', content });
const ask = (extra = {}) => ({ max_tokens: 16, messages: [USER('hi')], ...extra });
const base64Image = (media_type, data) => ({ type: 'image', source: { type: 'base64', media_type, data } });
const urlImage = url => ({ type: 'image', source: { type: 'url', url } });
const webTool = (extra = {}) => ask({ tools: [{ type: 'web_search_20250305', name: 'web_search', ...extra }] });

// A suite of refusals could pass while the adapter refuses everything, so first prove the
// happy path works with this fake. If this test breaks, every refusal below is suspect.
test('a minimal valid request is answered as an Anthropic message', async () => {
  await withAdapter(async (adapter, bridges) => {
    const result = await adapter.messages(ask());
    assert.deepEqual(result.content, [{ type: 'text', text: 'ok' }]);
    assert.equal(result.stop_reason, 'end_turn');
    assert.equal(result.role, 'assistant');
    assert.equal(result.model, 'gpt-5-codex', 'an absent model must resolve to the catalog default');
    assert.ok(result.usage.input_tokens > 0 && result.usage.output_tokens > 0);
    assert.deepEqual(paramsOf(turnBridge(bridges), 'turn/start').input, [{ type: 'text', text: 'hi' }]);
  });
});

// --- body shape -------------------------------------------------------------------------

// A string or array body would otherwise reach property reads that quietly produce an
// empty conversation; the adapter must say the body is wrong instead.
rejects('a string body is refused', 'hi there', refuses(/request body must be an object/));
rejects('an array body is refused', [{ role: 'user', content: 'hi' }], refuses(/request body must be an object/));
rejects('a null body is refused', null, refuses(/request body must be an object/));

rejects('a body with no messages is refused', { max_tokens: 16 }, refuses(/messages must contain 1.20,000 entries/));
rejects('an empty messages array is refused', { max_tokens: 16, messages: [] }, refuses(/messages must contain 1.20,000 entries/));
// A non-array messages is caught one layer earlier, by the document expander.
rejects('a non-array messages is refused', { max_tokens: 16, messages: 'hi' }, refuses(/messages must be an array/));
rejects('more than 20,000 messages is refused', () => ({ max_tokens: 16, messages: Array.from({ length: 20001 }, () => USER('x')) }), refuses(/messages must contain 1.20,000 entries/));

// Catches a rewrite that drops the size guard and lets a huge body reach JSON.stringify,
// estimateInput and the Codex socket. Cheap to build: one string just past the threshold.
test('a body past the 32 MiB limit is refused with the size-limit error', async () => {
  await withAdapter(async (adapter, bridges) => {
    const body = { max_tokens: 16, messages: [USER('x'.repeat(32 * 1024 * 1024 + 64))] };
    await assert.rejects(() => adapter.messages(body), refuses(/Request exceeds the 32 MiB adapter limit/));
    assert.equal(bridges.length, 0);
  });
});

// --- max_tokens -------------------------------------------------------------------------

// Anthropic requires max_tokens; the adapter also uses it as its own output byte budget, so
// it cannot be defaulted. A cache-warming request with no max_tokens must be refused, not
// answered with an arbitrary limit.
for (const [label, value] of [
  ['absent', undefined],
  ['zero', 0],
  ['negative', -1],
  ['fractional', 1.5],
  ['a numeric string', '16'],
  ['above 1,000,000', 1000001],
  ['null', null],
  ['Infinity', Number.POSITIVE_INFINITY],
]) {
  rejects(`max_tokens ${label} is refused`, { max_tokens: value, messages: [USER('hi')] }, refuses(/max_tokens must be a positive integer; cache-only requests are unsupported/));
}

// --- model ------------------------------------------------------------------------------

rejects('a numeric model is refused', ask({ model: 5 }), refuses(/model must be a string/));
rejects('an object model is refused', ask({ model: { id: 'gpt-5-codex' } }), refuses(/model must be a string/));

// A named non-Claude model that the account does not have must be refused rather than
// silently answered by whatever model happens to be the default.
test('an unavailable non-Claude model is refused without starting a thread', async () => {
  await withAdapter(async (adapter, bridges) => {
    await assert.rejects(() => adapter.messages(ask({ model: 'gpt-4.5-imaginary' })), refuses(/Requested model is not available to this ChatGPT account/));
    assert.equal(bridges.length, 1, 'only the catalog bridge should exist');
    assert.deepEqual(bridges[0].calls.map(([name]) => name), ['account', 'models'], 'no thread may be started for an unavailable model');
  });
});

// --- unsupported request-level features --------------------------------------------------

// These three ask for provider-side execution or routing the bridge cannot provide. Each
// must be refused; answering while ignoring them would misrepresent what ran.
for (const key of ['container', 'mcp_servers', 'inference_geo']) {
  rejects(`${key} is refused as unsupported`, ask({ [key]: key === 'mcp_servers' ? [{ type: 'url', url: 'https://example.com/mcp', name: 'x' }] : 'value' }),
    refuses(/Provider-managed containers, MCP execution, and inference-region controls are unsupported/));
}
// The guard is truthiness-based, so even an empty list is refused. Pinned deliberately:
// treating `mcp_servers: []` as "no MCP" would be a judgement call about a field the
// adapter has decided not to interpret at all.
rejects('an empty mcp_servers array is still refused', ask({ mcp_servers: [] }),
  refuses(/Provider-managed containers, MCP execution, and inference-region controls are unsupported/));

// --- system -----------------------------------------------------------------------------

// system is flattened into thread instructions, which can only carry text. Anything else
// (images, search results, a bare number) has to be refused rather than dropped.
rejects('a system image block is refused', ask({ system: [base64Image('image/png', 'AAAA')] }), refuses(/system supports text blocks only/));
rejects('a system text block whose text is not a string is refused', ask({ system: [{ type: 'text', text: 42 }] }), refuses(/system supports text blocks only/));
rejects('a numeric system is refused', ask({ system: 42 }), refuses(/system supports text blocks only/));

test('system text blocks are accepted and joined into the thread instructions', async () => {
  await withAdapter(async (adapter, bridges) => {
    await adapter.messages(ask({ system: [{ type: 'text', text: 'alpha' }, { type: 'text', text: 'beta' }] }));
    const { instructions } = paramsOf(turnBridge(bridges), 'startThread');
    assert.ok(instructions.startsWith('alpha\n\nbeta'), `system blocks must reach the thread verbatim, got ${JSON.stringify(instructions.slice(0, 40))}`);
  });
});

// --- images -----------------------------------------------------------------------------

rejects('an unsupported image media type is refused', ask({ messages: [USER([base64Image('image/bmp', 'AAAA')])] }), refuses(/Unsupported image media type/));
rejects('a base64 image payload with non-base64 characters is refused', ask({ messages: [USER([base64Image('image/png', 'not base64!!')])] }), refuses(/Image data must be bounded base64/));
rejects('a non-string base64 image payload is refused', ask({ messages: [USER([base64Image('image/png', 12345)])] }), refuses(/Image data must be bounded base64/));
// Built lazily: allocating the oversized payload at module scope would hold 12 MiB for the
// whole run. Catches removal of the bound that keeps a request from becoming unbounded.
rejects('a base64 image payload past 12 MiB is refused', () => ask({ messages: [USER([base64Image('image/png', 'A'.repeat(12 * 1024 * 1024 + 1))])] }), refuses(/Image data must be bounded base64/));

rejects('an http image URL is refused', ask({ messages: [USER([urlImage('http://example.com/a.png')])] }), refuses(/Image URLs must use HTTPS without embedded credentials/));
rejects('an image URL carrying credentials is refused', ask({ messages: [USER([urlImage('https://user:secret@example.com/a.png')])] }), refuses(/Image URLs must use HTTPS without embedded credentials/));
rejects('an image URL carrying only a username is refused', ask({ messages: [USER([urlImage('https://user@example.com/a.png')])] }), refuses(/Image URLs must use HTTPS without embedded credentials/));
rejects('a malformed image URL is refused', ask({ messages: [USER([urlImage('not a url')])] }), refuses(/Image URL is invalid/));

// An uploaded-file reference belongs to the caller's Anthropic account; this bridge has no
// way to read it, so the refusal must say so instead of sending a turn with no image.
rejects('an Anthropic file-id image source is refused as unusable', ask({ messages: [USER([{ type: 'image', source: { type: 'file', file_id: 'file_011CQ' } }])] }), refuses(/Anthropic file IDs cannot be used by this bridge/));
rejects('an image block with no source is refused', ask({ messages: [USER([{ type: 'image' }])] }), refuses(/Images require a base64 or HTTPS URL source/));
rejects('an assistant image block is refused', ask({ messages: [{ role: 'assistant', content: [urlImage('https://example.com/a.png')] }, USER('hi')] }), refuses(/Assistant image blocks are unsupported/));

test('a plain https image URL is accepted and forwarded verbatim', async () => {
  await withAdapter(async (adapter, bridges) => {
    const url = 'https://example.com/figure.png';
    await adapter.messages(ask({ messages: [USER([{ type: 'text', text: 'what is this' }, urlImage(url)])] }));
    assert.deepEqual(paramsOf(turnBridge(bridges), 'turn/start').input, [
      { type: 'text', text: 'what is this' },
      { type: 'image', url },
    ]);
  });
});

// Was a real defect, now fixed. The length/alphabet test admits strings that decode to
// nothing, so 'A' and '' both produced a data URL and a thread was started for an image that
// does not exist. A decode-and-re-encode check now refuses them. Split into separate cases
// because one loop stops at the first failed assertion and would not reach the empty payload.
test('a base64 image payload that cannot be decoded is refused', async () => {
  await withAdapter(async adapter => {
    await assert.rejects(() => adapter.messages(ask({ messages: [USER([base64Image('image/png', 'A')])] })), refuses(/not decodable base64/));
  });
});

test('an empty base64 image payload is refused', async () => {
  await withAdapter(async adapter => {
    await assert.rejects(() => adapter.messages(ask({ messages: [USER([base64Image('image/png', '')])] })), refuses(/not decodable base64/));
  });
});

// Non-canonical padding decodes to bytes but re-encodes differently, the same rule
// documents.mjs applies to PDF sources. Pins that the two payload guards now agree.
test('a base64 image payload with non-canonical padding is refused', async () => {
  await withAdapter(async adapter => {
    await assert.rejects(() => adapter.messages(ask({ messages: [USER([base64Image('image/png', 'iVBORw0KGgo')])] })), refuses(/not decodable base64/));
  });
});

// The guard must not reject real images.
test('a canonical base64 image payload is accepted', async () => {
  await withAdapter(async adapter => {
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64');
    assert.equal((await adapter.messages(ask({ messages: [USER([base64Image('image/png', png)])] }))).stop_reason, 'end_turn');
  });
});

// Claimed as a local SSRF and refuted on review. Neither the adapter nor the Node bridge
// dereferences an image URL: it is serialised and sent to Codex over stdio, so if anything
// fetches it, that is the hosted service, where 127.0.0.1 means that service's loopback and
// not this machine or its daemon on port 8000. The hosted-web private-host rule belongs to a
// different operation and does not imply a missing guard here. Pinned as intended behaviour;
// refusing private image URLs would be product policy, not a fix for demonstrated local SSRF.
test('an image URL is forwarded to Codex rather than dereferenced by the adapter', async () => {
  await withAdapter(async (adapter, bridges) => {
    const target = 'https://127.0.0.1:8123/secret.png';
    assert.equal((await adapter.messages(ask({ messages: [USER([urlImage(target)])] }))).stop_reason, 'end_turn');
    const sent = JSON.stringify(bridges.flatMap(bridge => bridge.calls));
    assert.ok(sent.includes(target), 'the URL is passed through as turn input');
    // Would fail if the adapter ever grew a local fetch: the bytes never enter this process.
    assert.ok(!sent.includes('PNG'), 'no image bytes were fetched into the request');
  });
});

// --- tool_result content ----------------------------------------------------------------

const toolResultBody = content => ask({
  tools: [{ name: 'lookup', input_schema: { type: 'object', properties: {} } }],
  messages: [
    USER('find it'),
    { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_a', name: 'lookup', input: { q: 'x' } }] },
    USER([{ type: 'tool_result', tool_use_id: 'toolu_a', content }]),
  ],
});

// A binary document inside a tool result cannot be replayed as a Codex content item; the
// refusal names the block type so the caller knows what to convert.
rejects('an unsupported tool_result block type is refused', toolResultBody([{ type: 'document', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }]), refuses(/Unsupported tool_result block type: document/));
rejects('a tool_result block with no type is refused', toolResultBody([{ text: 'hi' }]), refuses(/Unsupported tool_result block type: missing/));
rejects('a non-array tool_result content is refused', toolResultBody(42), refuses(/tool_result content must be text or content blocks/));
rejects('a tool_result without a tool_use_id is refused', ask({ messages: [USER([{ type: 'tool_result', content: 'done' }])] }), refuses(/Invalid user tool_result block/));
rejects('a tool_result on an assistant message is refused', ask({ messages: [{ role: 'assistant', content: [{ type: 'tool_result', tool_use_id: 'toolu_a', content: 'done' }] }, USER('hi')] }), refuses(/Invalid user tool_result block/));

// An empty result is legal Anthropic input. It must become a labelled placeholder, because
// a function_call_output with an empty content array reads as "the tool returned nothing
// and that is a protocol error" to Codex.
test('an empty tool_result becomes a labelled placeholder rather than an empty payload', async () => {
  await withAdapter(async (adapter, bridges) => {
    await adapter.messages(toolResultBody([]));
    const { items } = paramsOf(turnBridge(bridges), 'thread/inject_items');
    const output = items.filter(item => item.type === 'function_call_output');
    assert.deepEqual(output, [{
      type: 'function_call_output',
      call_id: 'toolu_a',
      output: [{ type: 'input_text', text: '(empty external tool result)' }],
    }]);
  });
});

// An errored empty result must still say the tool failed; the placeholder alone would read
// as a successful empty answer.
test('an errored empty tool_result carries the error note', async () => {
  await withAdapter(async (adapter, bridges) => {
    await adapter.messages(ask({
      tools: [{ name: 'lookup', input_schema: { type: 'object' } }],
      messages: [
        USER('find it'),
        { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_a', name: 'lookup', input: {} }] },
        USER([{ type: 'tool_result', tool_use_id: 'toolu_a', is_error: true, content: [] }]),
      ],
    }));
    const { items } = paramsOf(turnBridge(bridges), 'thread/inject_items');
    assert.deepEqual(items.at(-1).output, [{ type: 'input_text', text: 'The external tool returned an error.' }]);
  });
});

// --- hosted web tool policy -------------------------------------------------------------

// Anthropic's hosted web tools carry a policy the managed Codex web tool cannot enforce.
// Each unenforceable field must be named in the refusal, because silently accepting one
// would mean the caller believes a restriction is in force when it is not.
rejects('blocked_domains is refused because it cannot be enforced', webTool({ blocked_domains: ['evil.example'] }), refuses(/blocked_domains cannot be enforced by the managed Codex web tool/));
rejects('a non-array blocked_domains is refused', webTool({ blocked_domains: 'evil.example' }), refuses(/blocked_domains must be an array/));
rejects('a wildcard allowed_domains entry is refused', webTool({ allowed_domains: ['*.example.com'] }), refuses(/allowed_domains supports bare public hostnames only; path and wildcard policies are unsupported/));
rejects('a path-bearing allowed_domains entry is refused', webTool({ allowed_domains: ['example.com/docs'] }), refuses(/allowed_domains supports bare public hostnames only/));
rejects('a scheme-bearing allowed_domains entry is refused', webTool({ allowed_domains: ['https://example.com'] }), refuses(/allowed_domains supports bare public hostnames only/));
rejects('a non-string allowed_domains entry is refused', webTool({ allowed_domains: [42] }), refuses(/allowed_domains supports bare public hostnames only/));
rejects('more than 100 allowed_domains is refused', () => webTool({ allowed_domains: Array.from({ length: 101 }, (_value, index) => `host${index}.example.com`) }), refuses(/allowed_domains supports bare public hostnames only/));

rejects('max_uses of zero is refused', webTool({ max_uses: 0 }), refuses(/Hosted web max_uses must be between 1 and 20/));
rejects('max_uses above 20 is refused', webTool({ max_uses: 21 }), refuses(/Hosted web max_uses must be between 1 and 20/));
rejects('a fractional max_uses is refused', webTool({ max_uses: 2.5 }), refuses(/Hosted web max_uses must be between 1 and 20/));
rejects('max_content_tokens above the ceiling is refused', webTool({ max_content_tokens: 100001 }), refuses(/max_content_tokens must be between 1 and 100,000/));

rejects('an unknown hosted web policy field is refused', webTool({ freshness: 'day' }), refuses(/Unsupported hosted web policy field: freshness/));
// allowed_callers naming the code-execution tool means "let sandboxed code drive the web
// tool", which has no counterpart here.
rejects('a programmatic allowed_callers value is refused', webTool({ allowed_callers: ['code_execution_20250825'] }), refuses(/Programmatic code-execution callers are unsupported; use allowed_callers \["direct"\]/));
rejects('an allowed_callers list with more than one caller is refused', webTool({ allowed_callers: ['direct', 'code_execution_20250825'] }), refuses(/Programmatic code-execution callers are unsupported/));

rejects('a user_location on the fetch tool is refused', ask({ tools: [{ type: 'web_fetch_20260209', name: 'web_fetch', user_location: { type: 'approximate', country: 'US' } }] }), refuses(/Unsupported web user_location policy/));
rejects('a non-approximate user_location is refused', webTool({ user_location: { type: 'exact', country: 'US' } }), refuses(/Unsupported web user_location policy/));
rejects('an unknown user_location field is refused', webTool({ user_location: { type: 'approximate', postal_code: '94105' } }), refuses(/Unsupported web user_location policy/));
rejects('a lowercase user_location country is refused', webTool({ user_location: { type: 'approximate', country: 'us' } }), refuses(/Web user_location.country must be a two-letter uppercase country code/));
rejects('an unknown citations field is refused', webTool({ citations: { enabled: true, style: 'inline' } }), refuses(/Unsupported citations policy/));
rejects('a non-boolean citations.enabled is refused', webTool({ citations: { enabled: 'yes' } }), refuses(/Unsupported citations policy/));

// The accepted shape has to keep working, or the refusals above would just be a ban on the
// whole feature. Bare hostnames are lowercased and the default max_uses is applied.
test('a supported hosted web policy is accepted and normalised', async () => {
  await withAdapter(async (adapter, bridges) => {
    await adapter.messages(webTool({ allowed_domains: ['Docs.Example.com'], max_uses: 3, citations: { enabled: false } }));
    const definitions = turnBridge(bridges).options.toolDefinitions;
    assert.equal(definitions.length, 1);
    assert.deepEqual(definitions[0].hosted.allowedDomains, ['docs.example.com']);
    assert.equal(definitions[0].hosted.maxUses, 3);
    assert.equal(definitions[0].hosted.citations, false);
    assert.equal(definitions[0].originalName, 'web_search');
  });
});

// --- remaining prepare() guards ----------------------------------------------------------

rejects('a system-role message is refused', ask({ messages: [{ role: 'system', content: 'be nice' }, USER('hi')] }), refuses(/Only user and assistant message roles are supported/));
rejects('a message with no role is refused', ask({ messages: [{ content: 'hi' }] }), refuses(/Only user and assistant message roles are supported/));
rejects('message content that is neither text nor blocks is refused', ask({ messages: [USER(42)] }), refuses(/Message content must be text or an array of content blocks/));
rejects('a text block whose text is not a string is refused', ask({ messages: [USER([{ type: 'text', text: { value: 'hi' } }])] }), refuses(/Text content must be a string/));
rejects('an unknown content block type is refused', ask({ messages: [USER([{ type: 'video', source: {} }])] }), refuses(/Unsupported input block type: video/));
rejects('a content block with no type is refused', ask({ messages: [USER([{ text: 'hi' }])] }), refuses(/Unsupported input block type: missing/));
// An assistant prefill would have to be continued mid-sentence, which Codex cannot do.
rejects('an assistant-prefill request is refused', ask({ messages: [USER('hi'), { role: 'assistant', content: 'The answer is' }] }), refuses(/Assistant-prefill requests are unsupported by the Codex adapter/));

rejects('an unknown tool_choice type is refused', ask({ tool_choice: { type: 'required' } }), refuses(/Unsupported tool_choice/));
rejects('a tool_choice naming an absent tool is refused', ask({ tool_choice: { type: 'tool', name: 'missing' }, tools: [{ name: 'lookup', input_schema: { type: 'object' } }] }), refuses(/tool_choice names an unavailable tool/));
rejects('tool_choice any with no tools is refused', ask({ tool_choice: { type: 'any' } }), refuses(/tool_choice any requires at least one tool/));

rejects('a provider-managed tool type is refused', ask({ tools: [{ type: 'code_execution_20250825', name: 'code_execution' }] }), refuses(/Provider-managed tool type code_execution_20250825 is unsupported/));
rejects('a duplicate tool name is refused', ask({ tools: [{ name: 'lookup', input_schema: { type: 'object' } }, { name: 'lookup', input_schema: { type: 'object' } }] }), refuses(/Tool names must be unique API tool identifiers/));
rejects('a tool name with illegal characters is refused', ask({ tools: [{ name: 'look up!', input_schema: { type: 'object' } }] }), refuses(/Tool names must be unique API tool identifiers/));
rejects('a tool with no input_schema is refused', ask({ tools: [{ name: 'lookup' }] }), refuses(/Tool lookup requires an object input_schema/));
rejects('a non-object tool input_schema type is refused', ask({ tools: [{ name: 'lookup', input_schema: { type: 'string' } }] }), refuses(/Tool lookup requires an object input_schema/));

rejects('an empty stop sequence is refused', ask({ stop_sequences: [''] }), refuses(/stop_sequences must contain bounded nonempty strings/));
rejects('too many stop sequences are refused', ask({ stop_sequences: Array.from({ length: 17 }, (_value, index) => `s${index}`) }), refuses(/stop_sequences must contain bounded nonempty strings/));
rejects('a non-JSON-Schema output format is refused', ask({ output_config: { format: { type: 'grammar', grammar: 'x' } } }), refuses(/Only JSON Schema output formatting is supported/));

// An unsupported reasoning effort is refused after the model is known, so this one does
// reach the bridge -- but it must still fail rather than run at a different effort.
test('an effort the selected model does not support is refused', async () => {
  await withAdapter(async (adapter, bridges) => {
    await assert.rejects(() => adapter.messages(ask({ output_config: { effort: 'xhigh' } })), refuses(/Requested effort is not supported by the selected ChatGPT model/));
    assert.equal(turnBridge(bridges).calls.filter(([name]) => name === 'turn/start').length, 0, 'no turn may start at a substituted effort');
  });
});

// --- refusal shape ----------------------------------------------------------------------

// The gateway maps these onto HTTP, so a refusal that lost its status or type would reach
// the caller as a 500 and look like a bridge crash rather than a bad request.
test('every validation refusal carries a 400 invalid_request_error', async () => {
  const bodies = [
    'not an object',
    { max_tokens: 16 },
    ask({ max_tokens: 0 }),
    ask({ model: 7 }),
    ask({ container: 'c' }),
    ask({ system: [base64Image('image/png', 'AAAA')] }),
    ask({ messages: [USER([urlImage('http://example.com/a.png')])] }),
    webTool({ max_uses: 99 }),
  ];
  await withAdapter(async adapter => {
    for (const body of bodies) {
      const error = await adapter.messages(body).then(() => null, error => error);
      assert.ok(error, `expected a refusal for ${JSON.stringify(body).slice(0, 60)}`);
      assert.equal(error.name, 'AdapterError');
      assert.equal(error.status, 400);
      assert.equal(error.type, 'invalid_request_error');
      assert.ok(error.message.length > 10, 'a refusal must explain itself');
    }
  });
});
