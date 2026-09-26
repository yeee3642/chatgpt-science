# Interface-only inference redirect

How to run the original Claude Science application with its inference served by a ChatGPT
account, changing only the inference endpoint. This is a different goal from the standalone
application in the rest of this repository, and it does not share code with it.

Everything below about the application's behaviour was established by reading the shipped
0.1.53 build. Line numbers refer to the pretty-printed bundle extracted from
`claude-science.exe`, reproduced with:

```bash
esbuild bundle-main.js --outfile=main.pretty.js
```

where `bundle-main.js` is the largest NUL-free run inside the executable (it begins
`#!/usr/bin/env bun`). Line numbers will move between builds; the identifiers are minified and
also unstable. Re-derive them rather than trusting them after an update.

## Why not rebuild the interface

The application's own surface is large: persistent Python/R kernels, immutable artifact
versions with annotations and lineage, twenty featured connectors, twenty featured skills,
specialists, scientific viewers, SSH/Slurm and cloud compute. Reimplementing the backend behind
a copy of the compiled interface means reimplementing all of it, and a preserved control is not
a working feature. Running the original application instead makes every one of those work
because they are the originals, and reduces the work to one endpoint.

## The one thing that changes

The application resolves its inference base URL from `ANTHROPIC_BASE_URL` (`main.pretty.js`
line 15477). The resolver requires HTTPS for every host except a literal loopback address,
where plain HTTP is allowed:

```js
if (!dci(t)) throw Error(`ANTHROPIC_BASE_URL must be https (http is allowed only for literal
  loopback addresses like 127.0.0.1 or [::1]): ...`);
return (t.origin + t.pathname).replace(/\/+$/, "");
```

The path is preserved, which is what lets the gateway carry a per-launch token as a path
segment: `http://127.0.0.1:<port>/<64-hex>` becomes the base, and the SDK requests
`/<64-hex>/v1/messages` under it. Requests without the token are refused.

Only inference moves. OAuth, profile, account and usage endpoints are compiled against
`claude.ai`, `platform.claude.com` and `api.anthropic.com` (line 15492) and are not derived
from the base URL, so they continue to reach Anthropic unchanged.

## Authentication is unchanged, and a Claude sign-in is still required

This is a constraint, not an implementation gap. The credential resolver refuses API keys in
its first statement (line 51146):

```js
function sA(e10, t) {
  if (!t) throw new dh("This build requires signing in with your Claude account. API keys are not supported.");
```

`t` is the auth token. Because it must be truthy to get past that line, the `e10 || t` test
below it always succeeds, which makes the `ANTHROPIC_API_KEY` environment fallback further down
(lines 51159–51168) unreachable. Separately, a credential whose value equals `ANTHROPIC_API_KEY`
or `ANTHROPIC_AUTH_TOKEN` from the environment is actively rejected on refresh (line 51735,
and the same pattern at 148119 and 148193):

```js
if (s?.authToken && s.authToken === a || s?.apiKey && s.apiKey === c) s = null, o = "env_credential_refused";
```

The working credential comes from the stored OAuth token, carrying a seat tier. So a launched
instance needs a real Claude sign-in. Removing that would mean patching the executable, which
is outside this approach.

**Consequence for the gateway.** The SDK client is constructed with the OAuth token *and* the
custom base URL (line 51156), so the application sends its live Claude bearer token to the
loopback gateway on every request. The gateway must never log, persist or forward it. It is not
a ChatGPT credential and is not read as one. `server.test.mjs` pins that it is not passed into
the translation layer.

## Isolation

The application states the rule itself in `serve --help`: **"One daemon per data-dir."** A
private data directory is therefore what keeps an existing instance untouched.

Two defaults make an unconfigured second instance collide, and both are handled:

| Default | Value | Why it matters |
| --- | --- | --- |
| `port` | `8000`, previews on `8001` (line 36747, `sX = 8e3`) | A running instance already holds both. Confirmed on this machine: the program-directory daemon listens on `127.0.0.1:8000` and `[::1]:8000`. |
| `data_dir` | `~/.claude-science` (line 36760; legacy `~/.claude-bioscience`, `~/.operon`) | Sharing it means sharing the lockfile, the database and the sign-in. |

`update.auto_update` defaults on, and the updater rewrites the executable in the shared program
directory — that directory already contains a `claude-science.exe.old.<n>` from a previous
in-place update. An isolated instance left on auto-update would therefore replace the binary an
existing installation is running. The launcher disables it for the instance it starts.

`--allow-ephemeral-data-dir` exists but is Linux-only and irrelevant here.

### Launch recipe

```
claude-science.exe --data-dir <private> --config <private>/config.toml
```

with `ANTHROPIC_BASE_URL` set on that child process only, and a config containing:

```toml
data_dir = "<private>"
host = "127.0.0.1"
port = <a port where both it and port+1 are free>

[update]
auto_update = false
```

`--data-dir` and `--config` are global flags; the value-taking flags are `--config`,
`--data-dir`, `--assets-root` and `--adopt-install`, and the boolean ones are `--here`,
`--trust-here-data` and `--allow-ephemeral-data-dir` (line 308733). `--port` is a `serve` flag
rather than a global one, which is why the port is set through the config file instead.

Do not pass `--dangerously-no-sandbox` or `--dangerously-skip-approvals`. They exist; they are
not part of this.

### Verifying the isolation actually held

The daemon writes `operon.lock` in its data directory:

```json
{ "pid": …, "version": "0.1.53", "port": …, "sandbox_port": …, "require_token": true,
  "sock": "…", "started_at": "…", "engine": "42.10.0:…" }
```

The launcher reads it after start and reports the port the daemon actually took, rather than
assuming it honoured the config. A port that is not the assigned one is surfaced as a warning
to be investigated, since it could mean the instance is not as separate as intended.

## What the gateway has to implement

`/v1/messages`, `/v1/messages/count_tokens` and `/v1/models`. The model list is genuinely used:
the application calls `models.list({ limit: 1000 })` through the redirectable base URL and reads
`id` and `display_name` from each entry (line 51760), then filters the result.

### More than one model is requested

The application asks for a model for background work as well as for the user's conversation, so
serving only the chat model leaves other features silently broken. From the configuration schema
at line 36786 and the constants at 36747 and 13845:

| Setting | Default |
| --- | --- |
| `default_model` | `claude-opus-5` |
| `kernel_default_model` | `claude-haiku-4-5-20251001` |
| `kernel_reasoning_model` | `claude-sonnet-5` |
| `lineage_extraction_model` | `claude-sonnet-4-6` |
| `verification.reviewer_model` | `claude-sonnet-5` |
| `biosecurity.trajectory_screen_model` | `claude-opus-5` (screening off by default) |
| `verification.terminal_sniff_model` | unset, falls back |

`claude-opus-5-5` is also requested in practice — it appears in this machine's daemon log
alongside `claude-opus-5`.

### Beta headers and cache behaviour

The OAuth path sends `anthropic-beta: oauth-2025-04-20` (line 52465). Other beta identifiers
present in the build: `prompt-caching-scope-2026-01-05`, `thinking-display-updates-2026-08-18`,
`thinking-resumption-2026-07-17`, `thinking-binding-controls-2026-08-01`, `compact-2026-09-04`.

`cache_keepalive` defaults to enabled, pinging every 270s up to 12 times, so the gateway will
receive periodic requests whose purpose is to keep a prompt cache warm. They are ordinary
requests as far as translation is concerned, but they cost ChatGPT usage while buying nothing,
because there is no Anthropic cache behind them. Consider turning `cache_keepalive.enabled` off
in the instance config.

### The compatibility boundary worth knowing about

Extended thinking is the part a translation layer cannot reproduce faithfully. The application
has `incomplete_thinking_max_retries` (3), `thinking_resumption`, `thinking_binding_all_models`
and `thinking_prefix_mismatch` with values `unset | drop_block | error`. Anthropic thinking
blocks carry a signature that the application may send back on a later turn; ChatGPT produces
no equivalent, and the adapter deliberately does not fabricate one — it records the omission
instead. `thinking_prefix_mismatch = "drop_block"` is the setting to reach for if the mismatch
causes trouble.

Also not equivalent, and refused rather than approximated by the adapter: hosted-web
`blocked_domains`, wildcard and path-scoped domain policies, assistant prefill, Anthropic file
IDs, provider-managed containers, and MCP execution on the provider side. Token counts and
output ceilings are estimates, so the application's usage and cost panels do not describe real
ChatGPT billing.

## The ChatGPT side, as observed

`bridge/smoke-chatgpt.mjs` asks for capabilities only and generates nothing. Run against this
machine's managed ChatGPT sign-in it reported ready, with eight models offered:

```
gpt-6-astra   gpt-6-sol   gpt-6-luna
gpt-5.6-sol   gpt-5.6-terra   gpt-5.6-luna
gpt-daybreak-blue-latest   gpt-5.5
```

The Codex client requires the native `codex.exe`, not the npm shim. It searches
`node_modules/@openai/codex/node_modules/@openai/codex-win32-<arch>/vendor/<triple>/bin/codex.exe`
and honours `SCIENCE_CODEX_PATH`. API-key mode is refused on this side too, so ChatGPT access is
a managed sign-in or nothing.

### Known defect: intermittent crash on shutdown

Closing the gateway sometimes aborts the process with a libuv assertion:

```
Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 76
```

It reproduced once in two identical runs, so it is a race in the close path rather than a
deterministic failure — most likely a handle closed twice while the Codex child is going away.
It happens during teardown, after useful work, and the launcher's shutdown only closes the
gateway it started. It is still a real defect and is not fixed.

## Packaging

Only the launcher is packaged. The application itself is already an executable and is not
rebuilt, rewrapped or redistributed — the launcher starts the installed one.

```bash
cd bridge && npm run build:exe   # bun build --compile -> dist-launcher/ChatGPTScienceLauncher.exe
```

The result is a single ~98 MB file; the size is bun's embedded runtime, and it means the
launcher runs on a machine with no Node installed. It goes to `dist-launcher/`, not `dist/`,
because `dist/` is the standalone application's vite output and vite clears it on build — an
executable left there is both deleted and, while running, blocks the build with EPERM.
`dist-launcher/` and `*.exe` are gitignored, so the binary is built rather than committed.

Both `launch.mjs` and `server.mjs` previously decided whether to run by comparing
`import.meta.url` against `process.argv[1]`. Bundled into one executable every module reports
the executable's own path, so both fired and the gateway's standalone mode won. The entry is
now explicit (`launcher-entry.mjs`), and standalone gateway mode additionally requires the
`SCIENCE_BRIDGE_TOKEN` it cannot work without.

### The packaged build cannot open PDFs

`documents.mjs` locates pdf.js at runtime with
`createRequire(import.meta.url).resolve('pdfjs-dist/package.json')`. Inside a compiled bundle
that resolves against the virtual bundle root, not a real directory, so the lookup fails. The
failure is clean — a 503 saying local PDF support is unavailable — but a PDF attachment will
not work in the packaged launcher. Running `node launch.mjs` from `bridge/` with
`npm install` done does support PDFs.

Fixing this means resolving the dependency relative to `process.execPath` when bundled and
shipping `node_modules` beside the executable, which turns the single file into a folder. That
is not done.

## State of this work

Established by reading the build and confirmed on this machine: the redirect point, the
loopback allowance, the mandatory OAuth sign-in, the API-key refusal, the port and data-dir
defaults, the in-place updater, the one-daemon-per-data-dir rule, the lockfile shape, the model
set and the beta headers.

Tested: the launcher's isolation guards and the gateway's access controls, 28 tests in
`bridge/launch.test.mjs` and `bridge/server.test.mjs`.

Verified by running it: an isolated daemon starts alongside an existing installation without
disturbing it. `bridge/verify-isolation.mjs` records the running installation's listeners and
process ids, starts a daemon with a private data directory and a private port, and compares.
Across repeated runs the isolated daemon took the port assigned to it (24475, 49101 — a fresh
pair each run), never 8000/8001, ran as its own process, and the existing installation ended
byte-identical to how it started with all 64 of its processes alive. It is stopped afterwards
by data directory, and nothing the script did not start is ever signalled.

That retires the largest risk in this approach. What it does NOT cover: signing in, and
actually producing an answer.

Not yet done: **no message has been answered through the original interface.** The translation layer's own test
coverage is being written. Until an instance has actually been started and a message has
actually been answered by ChatGPT through the original interface, treat this as a designed and
partly verified path, not a working bridge.
