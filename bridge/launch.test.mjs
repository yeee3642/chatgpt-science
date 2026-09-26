/**
 * Tests for the isolation guards.
 *
 * These cover the property the bridge exists to keep: launching an instance must not
 * reach an installation the launcher does not own. Nothing here starts the application,
 * spawns a daemon, or reads a real data directory.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import net from 'node:net';
import { resolveInstanceRoot, portFree, choosePort, writeConfig, describeDaemon, PROGRAM_DIR, FOREIGN_ROOTS } from './launch.mjs';

const HOME = os.homedir();

test('refuses an instance root inside an existing installation', () => {
  for (const foreign of FOREIGN_ROOTS) {
    assert.throws(() => resolveInstanceRoot(foreign), /belongs to an existing installation/, `should refuse ${foreign}`);
    assert.throws(() => resolveInstanceRoot(path.join(foreign, 'nested', 'deeper')), /belongs to an existing installation/);
  }
});

test('refuses an instance root that would contain an existing installation', () => {
  // A parent of the real data directory would put the installation under our control.
  assert.throws(() => resolveInstanceRoot(HOME), /belongs to an existing installation/);
});

test('refuses an instance root inside the shared program directory', () => {
  assert.throws(() => resolveInstanceRoot(path.join(PROGRAM_DIR, 'bridge')), /shared program directory/);
});

test('refuses a relative path that resolves into an existing installation', () => {
  const prior = process.cwd();
  try {
    process.chdir(HOME);
    assert.throws(() => resolveInstanceRoot('.claude-science'), /belongs to an existing installation/);
    assert.throws(() => resolveInstanceRoot('./.operon/sub'), /belongs to an existing installation/);
  } finally {
    process.chdir(prior);
  }
});

test('accepts an unrelated root and returns it absolute', async () => {
  const target = path.join(os.tmpdir(), 'chatgpt-science-bridge-test-root');
  assert.equal(resolveInstanceRoot(target), path.resolve(target));
});

test('the default instance root is outside every existing installation', () => {
  const root = resolveInstanceRoot(undefined);
  assert.ok(path.isAbsolute(root));
  for (const foreign of FOREIGN_ROOTS) {
    assert.ok(!root.toLowerCase().startsWith(foreign.toLowerCase() + path.sep), `default root must not sit under ${foreign}`);
  }
  assert.ok(!root.toLowerCase().startsWith(PROGRAM_DIR.toLowerCase() + path.sep));
});

test('portFree reports a listening port as unavailable', async () => {
  const server = net.createServer();
  await new Promise(resolve => server.listen({ host: '127.0.0.1', port: 0 }, resolve));
  const { port } = server.address();
  try {
    assert.equal(await portFree(port), false, 'a port with a listener must not be reported free');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('choosePort returns a pair that is actually free', async () => {
  const port = await choosePort();
  assert.ok(Number.isSafeInteger(port) && port > 0 && port < 65535);
  assert.equal(await portFree(port), true);
  assert.equal(await portFree(port + 1), true, 'the preview port must be free too');
});

test('choosePort never returns a port in use by a running daemon', async () => {
  // The shipped default is 8000 with previews on 8001. If an installation is running
  // there, neither may be handed to an isolated instance.
  const port = await choosePort();
  for (const taken of [8000, 8001]) {
    if (!(await portFree(taken))) {
      assert.notEqual(port, taken);
      assert.notEqual(port + 1, taken, 'the preview port must not land on a port in use');
    }
  }
});

test('the generated config disables auto-update and pins the private data dir', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-config-'));
  try {
    const file = await writeConfig(root, 51234);
    const text = await fs.readFile(file, 'utf8');
    assert.match(text, /^auto_update = false$/m, 'the updater rewrites the shared executable and must stay off');
    assert.match(text, /^\[update\]$/m, 'auto_update must sit under the update table to bind');
    assert.match(text, /^port = 51234$/m);
    assert.match(text, /^host = "127\.0\.0\.1"$/m, 'the daemon must not be exposed off-host');
    assert.ok(text.includes(JSON.stringify(root)), 'data_dir must point at the private root');
    // The update table must come after the scalar keys, or TOML binds them into it.
    assert.ok(text.indexOf('port = ') < text.indexOf('[update]'), 'top-level keys must precede the first table');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('the generated config names no foreign data directory', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-config-'));
  try {
    const text = await fs.readFile(await writeConfig(root, 51235), 'utf8');
    for (const foreign of FOREIGN_ROOTS) assert.ok(!text.includes(foreign), `config must not reference ${foreign}`);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// --- daemon reporting -------------------------------------------------------------------
// The port check is a safety signal. It regressed once: a mode check inserted between the
// port comparison and its else branch bound the warning to the mode, so a real mismatch
// (daemon on 2220, assigned 46005) printed nothing. These pin each branch independently.
const LOCK = { version: '0.1.53', port: 46005, pid: 999, sandbox_port: 46006 };
const describe = extra => describeDaemon({ lock: LOCK, assignedPort: 46005, mode: 'serve', exe: 'C:/tools/claude-science.exe', root: 'C:/instance-root', ...extra });
const warnings = lines => lines.filter(line => line.startsWith('[bridge] WARNING'));

test('a matching port is reported as verified and warns about nothing', () => {
  const lines = describe();
  assert.ok(lines.some(line => line.includes('verified')));
  assert.deepEqual(warnings(lines), []);
});

test('a mismatched port warns, in serve mode too', () => {
  const lines = describe({ lock: { ...LOCK, port: 2220 } });
  assert.ok(warnings(lines).length >= 1, 'a port the launcher did not assign must warn');
  assert.ok(lines.some(line => line.includes('2220') && line.includes('46005')), 'both ports must be named');
  assert.ok(!lines.some(line => line.includes('verified')), 'a mismatch must not also claim verification');
});

test('a mismatched port warns in desktop mode as well', () => {
  assert.ok(warnings(describe({ lock: { ...LOCK, port: 2220 }, mode: 'desktop' })).length >= 1);
});

test('a mismatch tells the user how to stop the daemon that took the port', () => {
  const lines = describe({ lock: { ...LOCK, port: 2220 } });
  assert.ok(lines.some(line => line.includes('stop --data-dir')), 'the warning must be actionable');
});

test('a missing lockfile warns rather than reporting success', () => {
  const lines = describeDaemon({ lock: null, assignedPort: 46005, mode: 'serve', exe: 'x', root: 'r' });
  assert.equal(warnings(lines).length, 1);
  assert.ok(!lines.some(line => line.includes('open the interface')), 'no URL when the daemon is unconfirmed');
});

test('serve mode prints the port the daemon actually reported, not the assigned one', () => {
  const lines = describe({ lock: { ...LOCK, port: 2220 } });
  assert.ok(lines.some(line => line.includes('http://127.0.0.1:2220')), 'the URL must use the real port');
  assert.ok(!lines.some(line => line.includes('http://127.0.0.1:46005')));
});

test('desktop mode prints no browser URL', () => {
  assert.ok(!describe({ mode: 'desktop' }).some(line => line.includes('open the interface')));
});
