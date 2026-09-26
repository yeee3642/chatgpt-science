# Interface-only bridge

Redirects Claude Science's model inference to a ChatGPT account by changing **only the
inference endpoint**. The original application — its executable, compiled interface, daemon,
kernels, artifacts, connectors and skills — is not modified, patched, restarted or copied.

This supersedes the `web/`, `worker/` and `server/reference-*.mjs` rebuild for the goal of
"original interface, GPT inference". Those remain in the tree for the separate standalone-app
goal; nothing here depends on them.

## How the redirect works

Claude Science resolves its inference endpoint from `ANTHROPIC_BASE_URL` and accepts a
loopback `http://` origin (HTTPS is required for every other host). Pointing that variable at
a local gateway that speaks the Anthropic Messages API is sufficient to move inference,
because the application requests `${base}/v1/messages` and `${base}/v1/models` through it.

Nothing else is redirected. OAuth, profile, account and usage endpoints are compiled against
`claude.ai` / `platform.claude.com` / `api.anthropic.com` and are not derived from that
variable, so they continue to reach Anthropic unchanged.

The variable is set on the launched child process only. It is never exported to the user's
environment, and no existing installation, data directory or shortcut is altered.

## Authentication is unchanged and still required

The application accepts a Claude OAuth token and nothing else. Its credential resolver
rejects API keys outright, and separately refuses any credential whose value equals
`ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` from the environment. A launched instance
therefore still requires a real Claude sign-in; this bridge does not remove, weaken or
work around that requirement, and does not reuse or copy stored credentials.

A consequence: the application sends its live Claude OAuth bearer token to whatever base URL
is configured, including this loopback gateway. The gateway must never log, persist or
forward it. It is not needed for ChatGPT inference and is not read as a credential.

ChatGPT access uses the Codex App Server with a managed ChatGPT sign-in. API-key mode is
refused there as well; Claude credentials are never presented to ChatGPT, or the reverse.

## Components

| File | Responsibility |
| --- | --- |
| `server.mjs` | Loopback HTTP gateway: Messages, count_tokens and Models, per-launch token, bounded bodies |
| `adapter.mjs` | Anthropic Messages ⇄ Codex translation: content blocks, streaming, tool round-trips, hosted web, PDFs |
| `codex-bridge.mjs` | Codex App Server client: ChatGPT account, model list, threads, approvals |
| `documents.mjs` | Base64 PDF page text and page images; byte-for-byte identical to `server/pdf-content.mjs` |

`codex-bridge.mjs` here is the variant that `adapter.mjs` is written against: it accepts the
`baseInstructions` and `webPolicy` options the adapter passes when starting a thread. The
copy under `server/` diverged for the standalone application and dropped both, so the two are
not interchangeable in this direction.

## State of this code

`adapter.mjs` and this `codex-bridge.mjs` were recovered from a local working directory inside
the installed application's program folder, where an application update could have deleted
them. They are committed here to preserve them; recovery is not verification.

**These files have no automated tests in this repository.** An earlier note claimed the
translation layer's text, streaming and tool round-trips were covered by tests; those test
files are not present in this tree or on the machine they were written on, so that claim is
not currently supported by anything runnable. `tests/bridge.test.mjs` exercises
`server/codex-bridge.mjs`, which is the diverged copy — it does not cover this directory.

The launcher, the isolated-instance recipe and the tests are not in this commit. Do not treat
the presence of these files as a working end-to-end bridge.
