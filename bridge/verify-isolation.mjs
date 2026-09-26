/**
 * Proves that an isolated instance can run without disturbing an installation already
 * running on this machine.
 *
 * Starts a daemon with a private data directory and a private port, checks it took the port
 * assigned to it, then stops it — and records the existing installation's listeners and
 * process ids before, during and after, so any disturbance would show up.
 *
 * Does not sign in, does not open a window, and never signals a process it did not start.
 *
 *   node verify-isolation.mjs
 */
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { choosePort, writeConfig, resolveInstanceRoot, PROGRAM_DIR } from './launch.mjs';

const run = promisify(execFile);
const EXE = path.join(PROGRAM_DIR, 'claude-science.exe');
const ok = (label, pass, detail = '') => {
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!pass) process.exitCode = 1;
  return pass;
};

/** Listener and process facts about any Claude Science already running here. */
async function observeExisting() {
  const script = `
$ErrorActionPreference='SilentlyContinue'
$procs = Get-Process claude-science,operon-winsbx | Select-Object -ExpandProperty Id
$listen = Get-NetTCPConnection -State Listen | Where-Object { $_.LocalPort -in 8000,8001 } |
  ForEach-Object { "$($_.LocalAddress):$($_.LocalPort)/$($_.OwningProcess)" }
[pscustomobject]@{ procs = @($procs); listeners = @($listen | Sort-Object) } | ConvertTo-Json -Compress`;
  const { stdout } = await run('powershell', ['-NoProfile', '-Command', script], { windowsHide: true, maxBuffer: 8 << 20 });
  const parsed = JSON.parse(stdout.trim() || '{}');
  const asArray = value => (value == null ? [] : Array.isArray(value) ? value : [value]);
  return { procs: asArray(parsed.procs).sort((a, b) => a - b), listeners: asArray(parsed.listeners) };
}

const summarise = state => `${state.procs.length} process(es), listeners on 8000/8001: ${state.listeners.join(', ') || 'none'}`;

async function readLock(root, timeoutMs) {
  const file = path.join(root, 'operon.lock');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const lock = JSON.parse(await fsp.readFile(file, 'utf8'));
      if (Number.isSafeInteger(lock.pid) && Number.isSafeInteger(lock.port)) return lock;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  return null;
}

const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

const root = resolveInstanceRoot(path.join(os.tmpdir(), `cs-isolation-check-${process.pid}`));
let child, lock, before;

try {
  console.log('1. Observing the installation already running\n');
  before = await observeExisting();
  console.log(`   baseline: ${summarise(before)}\n`);
  if (!before.listeners.length) console.log('   NOTE: nothing is listening on 8000/8001, so the collision case is not exercised.\n');

  await fsp.mkdir(root, { recursive: true });
  const port = await choosePort();
  const configFile = await writeConfig(root, port);
  console.log(`2. Starting an isolated daemon\n   data dir: ${root}\n   port: ${port} (previews ${port + 1})\n`);

  child = spawn(EXE, ['serve', '--no-browser', '--data-dir', root, '--config', configFile, '--port', String(port)], {
    env: { ...process.env, ANTHROPIC_BASE_URL: 'http://127.0.0.1:1/placeholder-not-contacted' },
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });

  lock = await readLock(root, 180000);
  console.log('3. Checking the isolated daemon\n');
  if (!ok('the isolated daemon wrote its own lockfile', Boolean(lock))) {
    console.log(`\n--- daemon output ---\n${output.slice(-3000)}`);
  } else {
    ok('it took the port assigned to it', lock.port === port, `lock reports ${lock.port}, assigned ${port}`);
    ok('it is not on the default port', lock.port !== 8000 && lock.sandbox_port !== 8001, `port ${lock.port}, preview ${lock.sandbox_port}`);
    ok('it is a different process from the existing install', !before.procs.includes(lock.pid), `pid ${lock.pid}`);
    ok('its lockfile is inside the private data dir', path.resolve(path.join(root, 'operon.lock')).startsWith(path.resolve(root)));
  }

  console.log('\n4. Re-checking the existing installation while ours runs\n');
  const during = await observeExisting();
  ok('its 8000/8001 listeners are unchanged', JSON.stringify(during.listeners) === JSON.stringify(before.listeners),
    `${before.listeners.join(', ') || 'none'} -> ${during.listeners.join(', ') || 'none'}`);
  ok('none of its processes disappeared', before.procs.every(pid => during.procs.includes(pid)),
    `${before.procs.filter(pid => !during.procs.includes(pid)).length} missing`);
} catch (error) {
  console.error(`\nverification error: ${error.message}`);
  process.exitCode = 1;
} finally {
  console.log('\n5. Stopping only the daemon this script started\n');
  try {
    if (lock?.pid) {
      await run(EXE, ['stop', '--data-dir', root], { windowsHide: true, timeout: 90000 }).catch(error => console.log(`   stop reported: ${error.message.split('\n')[0]}`));
      for (let i = 0; i < 40 && alive(lock.pid); i++) await new Promise(resolve => setTimeout(resolve, 500));
      ok('our daemon is gone', !alive(lock.pid), `pid ${lock.pid}`);
    }
    if (child && child.exitCode === null && !child.killed) child.kill();

    const after = await observeExisting();
    console.log(`\n   final: ${summarise(after)}`);
    if (before) {
      ok('the existing installation ends exactly as it started',
        JSON.stringify(after.listeners) === JSON.stringify(before.listeners),
        `${before.listeners.join(', ') || 'none'} -> ${after.listeners.join(', ') || 'none'}`);
      ok('every process it had at the start is still running',
        before.procs.every(pid => after.procs.includes(pid)),
        `${before.procs.filter(pid => !after.procs.includes(pid)).length} missing of ${before.procs.length}`);
    }
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
  } catch (error) {
    console.error(`cleanup error: ${error.message}`);
  }
  console.log(`\n${process.exitCode ? 'VERIFICATION FAILED' : 'verification passed'}`);
}
