const BRIDGE = 'C:/Users/yeee3642/cs-gpt/work/bridge';
const RECON = 'C:/Users/yeee3642/cs-gpt/recon';
const EVIDENCE = 'C:/Users/yeee3642/cs-gpt/review/evidence';

const SUITE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    suiteVerdict: { type: 'string', enum: ['sound', 'weak', 'broken'] },
    vacuousTests: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: { test: { type: 'string' }, why: { type: 'string' } },
        required: ['test', 'why'],
      },
    },
    wrongAssertions: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: { test: { type: 'string' }, why: { type: 'string' }, actualBehaviour: { type: 'string' } },
        required: ['test', 'why', 'actualBehaviour'],
      },
    },
    bentToPass: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: { test: { type: 'string' }, why: { type: 'string' } },
        required: ['test', 'why'],
      },
    },
    defectAdjudications: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          todoTest: { type: 'string' },
          isRealDefect: { type: 'boolean' },
          severity: { type: 'string', enum: ['high', 'medium', 'low', 'none'] },
          reasoning: { type: 'string' },
          suggestedFix: { type: 'string' },
        },
        required: ['todoTest', 'isRealDefect', 'severity', 'reasoning', 'suggestedFix'],
      },
    },
    missedCoverage: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  },
  required: ['suiteVerdict', 'vacuousTests', 'wrongAssertions', 'bentToPass', 'defectAdjudications', 'missedCoverage', 'notes'],
};

const suitePrompt = (file, dimension, counts, todoNote) => `You are reviewing a test suite written by a different AI model. Be skeptical; your value here is catching what it got wrong or faked.

WORKING DIRECTORY: ${BRIDGE}
TEST FILE UNDER REVIEW: ${file}
CODE UNDER TEST: adapter.mjs  — an Anthropic Messages API to Codex/ChatGPT translation layer
DIMENSION CLAIMED: ${dimension}

I already ran the suite. Result: ${counts}. Do NOT run it yourself — the sandbox is read-only and
several tests create temp directories, so a run would fail for reasons unrelated to quality.
Review statically by reading ${file} and adapter.mjs (and documents.mjs / codex-bridge.mjs where relevant).

Judge four things:

1. VACUOUS TESTS — would the test still pass if adapter.mjs were broken in the way the test name
   implies? Typical smells: asserting only that a promise rejected without checking which error;
   asserting a value the test itself constructed and the adapter never transformed; asserting the
   fake bridge's own return value; a fake so permissive the adapter's real logic never runs.

2. WRONG ASSERTIONS — does a test assert behaviour adapter.mjs does not actually have? A test can be
   green because the author shaped the fake to match a mistaken belief. Check claims against the
   source, and report what the code actually does.

3. BENT TO PASS — signs a test was weakened until it went green: an over-loose regex, a swallowing
   try/catch, an assertion that was removed, a fake stubbing out the very path the test names.

4. ADJUDICATE THE todo TESTS. ${todoNote}
   The author was instructed to mark suspected adapter defects with { todo: true } rather than
   weaken the test or edit the adapter. For each such test, decide independently whether it is a
   REAL defect in adapter.mjs. Read the relevant adapter code yourself. An author claiming a defect
   is not evidence of one — some may be the author misreading the code. Give severity and, if real,
   a concrete fix. Set isRealDefect=false where the adapter is actually correct.

Also list notable gaps in the dimension the suite left uncovered.

Do not modify any file. Return only the structured JSON.`;

export const TASKS = [
  {
    id: 'suite-text',
    cwd: BRIDGE,
    schema: SUITE_SCHEMA,
    prompt: suitePrompt('adapter-text.test.mjs', 'plain text generation and streaming (SSE event sequence, delta concatenation, system handling)',
      '24 tests, 22 pass, 0 fail, 2 todo',
      `The two todo tests concern item/completed reconciliation: the author claims that when a completion's
   text is not a prefix-extension of the already-streamed deltas (including an empty text, or text with
   trailing whitespace trimmed), the adapter discards a fully delivered answer and throws 502. Read the
   Segment class (completeText / append / emitText) in adapter.mjs and decide whether that is genuinely a defect.`),
  },
  {
    id: 'suite-tools',
    cwd: BRIDGE,
    schema: SUITE_SCHEMA,
    prompt: suitePrompt('adapter-tools.test.mjs', 'tool round-trips: tool_use emission, tool_result continuation, forced tool_choice, conversation reuse',
      '25 tests, 24 pass, 0 fail, 1 todo',
      `The single todo claims a duplicated tool_result for the same tool_use_id is not rejected. Read the
   duplicate/consumed checks in Adapter.messages() around the lastResults handling and decide.`),
  },
  {
    id: 'suite-validation',
    cwd: BRIDGE,
    schema: SUITE_SCHEMA,
    prompt: suitePrompt('adapter-validation.test.mjs', 'request validation and explicit refusals (prepare(), imageUrl(), contentItems(), hostedDefinition())',
      '90 tests, 88 pass, 0 fail, 2 todo',
      `Two todos, and one may be a security issue — please weigh it carefully:
   (a) a base64 image payload that cannot actually be decoded is accepted, although documents.mjs
       rejects the same malformed shape for PDFs (length % 4 !== 0) — inconsistent guards;
   (b) an image URL pointing at a private or loopback host (e.g. https://127.0.0.1:8123/secret.png)
       is forwarded verbatim as turn input, while the hosted-web retrieval path deliberately refuses
       private hosts. Assess whether this is a genuine server-side request forgery exposure in this
       architecture. Relevant context: the gateway runs on loopback, and the host also runs an
       application daemon on 127.0.0.1:8000. Consider who actually dereferences the URL and whether
       the adapter is the right place to refuse it; say so plainly if you think the risk is overstated.`),
  },
  {
    id: 'suite-failures',
    cwd: BRIDGE,
    schema: SUITE_SCHEMA,
    prompt: suitePrompt('adapter-failures.test.mjs', 'failure, cancellation and the inference-only boundary (native tool activity blocked, approvals declined, abort, timeout, context limits)',
      '28 tests, 28 pass, 0 fail, 0 todo',
      `This suite reported no todo tests. Be especially alert to vacuous passes here: it covers the
   security-relevant guard that native tool activity (commandExecution, mcpToolCall, collabToolCall,
   imageGeneration, webSearch) must abort the response, and the guard that a non-chatgpt account type
   is refused. Verify those tests would actually fail if the guards were removed.`),
  },
  {
    id: 'suite-models',
    cwd: BRIDGE,
    schema: SUITE_SCHEMA,
    prompt: suitePrompt('adapter-models.test.mjs', 'model resolution, catalog caching and token counting',
      '30 tests, 28 pass, 0 fail, 2 todo',
      `Two todos, both claiming countTokens() is inconsistent with messages(): it skips prepare()
   validation and does not check the ChatGPT sign-in or model availability, so a caller that
   pre-flights a body is told it is fine and is then refused by /v1/messages. Read countTokens() and
   messages() and decide whether this is a real defect or acceptable divergence for an estimator.`),
  },
  {
    id: 'recon-claims',
    cwd: EVIDENCE,
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        claims: {
          type: 'array',
          items: {
            type: 'object', additionalProperties: false,
            properties: {
              claim: { type: 'string' },
              verdict: { type: 'string', enum: ['confirmed', 'refuted', 'partly-correct', 'unverifiable'] },
              evidence: { type: 'string' },
              correction: { type: 'string' },
            },
            required: ['claim', 'verdict', 'evidence', 'correction'],
          },
        },
        designRisk: { type: 'string' },
      },
      required: ['claims', 'designRisk'],
    },
    prompt: `You are independently checking reverse-engineering claims made by a different AI model about a
shipped desktop application. Verify each against the source; refute what does not hold.

WORKING DIRECTORY: C:/Users/yeee3642/cs-gpt/review/evidence

IMPORTANT — what you can and cannot read. The original artefact is a ~16MB, ~308,769-line
pretty-printed Bun bundle extracted from claude-science.exe 0.1.53. It has been established by
experiment that this sandbox CANNOT open that file: every attempt fails with Windows sandbox error 206.
Do not try to read it, and do not try shell commands — both fail. Files in your working directory read
fine; use your file-reading tool on those.

Your working directory holds an evidence pack extracted from the bundle:
  claim*.txt      line-numbered windows around each cited line, copied verbatim, with real line numbers
  grep-index.txt  the FULL occurrence count and line list for each load-bearing identifier, plus excerpts

Treat the pack with suspicion: it was extracted by the same party making the claims, so a window could be
cut to exclude contradicting context. grep-index.txt is your main defence — it reports total occurrence
counts, so you can tell whether a claim about "the only definition" or "the only call site" holds, or
whether a window omits another site. If the pack is genuinely insufficient to settle a claim, mark it
unverifiable and say exactly which additional lines you would need. Do not upgrade a guess to a verdict.

Context for why this matters: the plan is to run this application unmodified while redirecting only its
model inference to a local loopback gateway, without disturbing a separate copy already running on this
machine. Each claim is load-bearing.

CLAIMS:

1. Z_() (near line 15477) resolves the inference base URL from process.env.ANTHROPIC_BASE_URL, permits
   plain http ONLY for literal loopback hosts and requires https otherwise, and returns origin+pathname
   with trailing slashes stripped, so a path component in the variable survives.

2. At line 51146 the credential resolver sA(apiKey, authToken) throws unconditionally when its authToken
   argument is falsy, saying API keys are not supported. CONSEQUENTLY the ANTHROPIC_API_KEY environment
   fallback later in the SAME function (around 51159-51168) is UNREACHABLE dead code, because the guard
   guarantees authToken is truthy so the "e10 || t" branch at 51153 always wins and returns at 51157.
   This is the strongest claim and the one most worth attacking. Refute it if the code can reach 51159 by
   any path — another caller, a rebinding, a similarly named function, or a reassignment of the parameter.
   Use grep-index.txt to check whether sA is defined or called in more than one place; if the index
   shows call sites the pack does not show, say so rather than accepting the claim.

3. Near line 51735 a refreshed credential is compared against process.env.ANTHROPIC_AUTH_TOKEN and
   process.env.ANTHROPIC_API_KEY and discarded, recording "env_credential_refused" — the application
   actively refuses environment-supplied credentials.

4. At line 51156 the SDK client is constructed with BOTH the OAuth authToken AND the custom baseURL from
   Z_(). Therefore, pointed at a local gateway, the application sends its real Claude OAuth bearer token
   to that gateway.

5. The configuration schema near 36786 gives port a default of sX, and sX = 8000 at line 36747; data_dir
   defaults to a path ending .claude-science (line 36760).

6. The application requests several distinct model ids for background work, not only the user's chat
   model: default_model claude-opus-5, kernel_default_model claude-haiku-4-5-20251001,
   kernel_reasoning_model claude-sonnet-5, lineage_extraction_model claude-sonnet-4-6, and a reviewer
   model. Confirm or correct the list.

7. At line 51760 the app calls models.list({ limit: 1000 }) against the redirectable base URL and reads id
   and display_name from each entry, so a gateway can advertise its own model list.

For each claim give a verdict, and cite the line numbers and literal source text you relied on. Where a
claim is overstated rather than flatly wrong use partly-correct and give the accurate version. Then in
designRisk state the single biggest risk to the plan based on what you actually read — and if the evidence
pack prevented you from checking something important, say that instead of inventing confidence.

Do not modify any file. Return only the structured JSON.`,
  },
];
