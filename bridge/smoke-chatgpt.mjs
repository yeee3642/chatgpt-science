/**
 * Connectivity check for the ChatGPT side of the bridge.
 *
 * Starts the gateway with a real Codex connection, reports the account type and the models
 * the account offers, then shuts down. It asks for capabilities only and generates nothing,
 * so it does not consume generation quota.
 *
 * Touches no Claude Science installation: no data directory is read, no daemon is contacted
 * and the original executable is not run.
 *
 *   node smoke-chatgpt.mjs
 */
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { startGateway } from './server.mjs';
import { Adapter } from './adapter.mjs';

const secret = randomBytes(32).toString('hex');
const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'bridge-smoke-'));
let gateway;
let status = 1;

try {
  gateway = await startGateway({
    port: 0,
    secret,
    dataRoot: root,
    adapter: new Adapter({ cwd: root, model: process.env.SCIENCE_CHATGPT_MODEL || undefined }),
  });
  console.log(`gateway listening on ${gateway.origin}`);

  await gateway.startup;
  const health = await fetch(`${gateway.origin}/health`).then(response => response.json());
  console.log(`ready: ${health.ok}${health.error ? `  (${health.error})` : ''}`);

  if (!health.ok) {
    console.error('\nChatGPT is not reachable. The bridge needs a native codex.exe with a managed');
    console.error('ChatGPT sign-in; API-key mode is refused. Set SCIENCE_CODEX_PATH if it is not on PATH.');
  } else {
    const models = await fetch(`${gateway.origin}/${secret}/v1/models`).then(response => response.json());
    const list = models.data ?? [];
    console.log(`\nmodels offered (${list.length}):`);
    for (const model of list) console.log(`  ${model.id}${model.display_name && model.display_name !== model.id ? `  — ${model.display_name}` : ''}`);
    console.log('\nThe application also requests these ids for background work; each must resolve:');
    for (const id of ['claude-opus-5', 'claude-opus-5-5', 'claude-sonnet-5', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001']) console.log(`  ${id}`);
    status = 0;
  }
} catch (error) {
  console.error(`smoke check failed: ${error.message}`);
} finally {
  await gateway?.close().catch(() => {});
  await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
}
process.exit(status);
