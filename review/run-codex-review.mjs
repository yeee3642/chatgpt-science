/**
 * Runs review tasks through the Codex CLI (a non-Anthropic model), so the work is not
 * checked by the same model family that produced it.
 *
 * Read-only sandbox, ephemeral sessions, structured output validated against a per-task
 * JSON Schema. Nothing here writes to the reviewed tree.
 *
 *   node run-codex-review.mjs [taskId ...]
 */
import { execFile } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { TASKS } from './tasks.mjs';

const CODEX = process.env.SCIENCE_CODEX_PATH
  ?? path.join(os.homedir(), 'AppData/Roaming/npm/node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe');
const MODEL = process.env.CODEX_REVIEW_MODEL ?? 'gpt-6-astra';
const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const OUT = path.join(HERE, 'out');
const CONCURRENCY = Number(process.env.CODEX_REVIEW_CONCURRENCY ?? 3);
const TIMEOUT_MS = Number(process.env.CODEX_REVIEW_TIMEOUT_MS ?? 15 * 60 * 1000);

async function runTask(task) {
  const schemaFile = path.join(OUT, `${task.id}.schema.json`);
  const outFile = path.join(OUT, `${task.id}.json`);
  await writeFile(schemaFile, JSON.stringify(task.schema, null, 2), 'utf8');

  const args = [
    'exec', '-m', task.model ?? MODEL,
    '-s', 'read-only',
    '-C', task.cwd,
    '--skip-git-repo-check', '--ephemeral', '--color', 'never',
    '--output-schema', schemaFile,
    '-o', outFile,
    // The prompt goes on stdin, not argv. Passed as an argument, a long prompt overruns the
    // Windows command-line limit and the sandbox helper fails to launch with error 206
    // ("filename or extension is too long"), which surfaces as the model being unable to read
    // any file — it reports the task as unverifiable rather than failing outright.
  ];

  const started = Date.now();
  const log = await new Promise(resolve => {
    const child = execFile(CODEX, args, { timeout: TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => resolve({ error, stdout, stderr }));
    child.stdin?.end(task.prompt);
  });
  const seconds = Math.round((Date.now() - started) / 1000);

  let result = null, parseError = null;
  try { result = JSON.parse(await readFile(outFile, 'utf8')); }
  catch (error) { parseError = error.message; }

  const tokens = /tokens used\s*\r?\n\s*([\d,]+)/.exec(log.stdout ?? '')?.[1] ?? 'n/a';
  if (!result) {
    await writeFile(path.join(OUT, `${task.id}.stdout.txt`), `${log.stdout ?? ''}\n--- stderr ---\n${log.stderr ?? ''}`, 'utf8');
  }
  return { id: task.id, seconds, tokens, result, parseError, failed: !result };
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const wanted = process.argv.slice(2);
  const queue = (wanted.length ? TASKS.filter(t => wanted.includes(t.id)) : TASKS).slice();
  if (!queue.length) { console.error(`No matching tasks. Known: ${TASKS.map(t => t.id).join(', ')}`); process.exit(2); }

  console.log(`reviewer: ${MODEL}   tasks: ${queue.length}   concurrency: ${CONCURRENCY}\n`);
  const results = [];
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    for (let task = queue.shift(); task; task = queue.shift()) {
      process.stdout.write(`  start  ${task.id}\n`);
      const outcome = await runTask(task);
      results.push(outcome);
      process.stdout.write(`  ${outcome.failed ? 'FAILED' : 'done  '} ${outcome.id}  ${outcome.seconds}s  ${outcome.tokens} tokens\n`);
    }
  });
  await Promise.all(workers);

  console.log('\n=== summary ===');
  for (const r of results.sort((a, b) => a.id.localeCompare(b.id))) {
    if (r.failed) { console.log(`${r.id}: NO STRUCTURED OUTPUT (${r.parseError}) — see out/${r.id}.stdout.txt`); continue; }
    console.log(`${r.id}: ${JSON.stringify(r.result).slice(0, 220)}…`);
  }
  await writeFile(path.join(OUT, '_summary.json'), JSON.stringify(results, null, 2), 'utf8');
  console.log(`\nfull results in ${OUT}`);
  if (results.some(r => r.failed)) process.exitCode = 1;
}

await main();
