/**
 * Launch an isolated Claude Science instance whose inference is served by ChatGPT.
 *
 * Changes exactly one thing about the application: the inference endpoint, via
 * ANTHROPIC_BASE_URL on the spawned child process only. The executable, the compiled
 * interface, the daemon, kernels and every other subsystem run as shipped.
 *
 * Refuses to share state with an existing installation. The instance gets its own data
 * directory, its own port and its own daemon, which the application enforces as
 * "one daemon per data-dir". Auto-update is disabled for this instance because the
 * updater replaces the executable in the shared program directory, which would reach
 * an installation this launcher does not own.
 */
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { startGateway } from './server.mjs';
import { Adapter } from './adapter.mjs';

const HOME = os.homedir();
export const PROGRAM_DIR = path.join(process.env.LOCALAPPDATA ?? path.join(HOME, 'AppData', 'Local'), 'Programs', 'ClaudeScience');
const ORIGINAL_EXE = path.join(PROGRAM_DIR, 'claude-science.exe');
/** Data roots belonging to an installation this launcher must never write to or adopt. */
export const FOREIGN_ROOTS = ['.claude-science', '.claude-bioscience', '.operon'].map(leaf => path.join(HOME, leaf));

const fail = message => { throw new Error(message); };
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const within = (root, target) => {
  const rel = path.relative(root, target);
  return rel === '' || (!path.isAbsolute(rel) && !rel.startsWith('..' + path.sep) && rel !== '..');
};

/** Reject any instance root that would collide with an installation we do not own. */
export function resolveInstanceRoot(input) {
  const root = path.resolve(input ?? path.join(process.env.LOCALAPPDATA ?? path.join(HOME, 'AppData', 'Local'), 'ChatGPTScienceBridge', 'instance'));
  for (const foreign of FOREIGN_ROOTS) {
    if (within(foreign, root) || within(root, foreign)) fail(`Instance root ${root} overlaps ${foreign}, which belongs to an existing installation. Choose a path outside it.`);
  }
  if (within(PROGRAM_DIR, root)) fail(`Instance root ${root} is inside the shared program directory. An application update would delete it.`);
  return root;
}

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

/** True only when nothing is listening on the port on either loopback family. */
export async function portFree(port) {
  for (const host of ['127.0.0.1', '::1']) {
    const busy = await new Promise(resolve => {
      const socket = net.connect({ host, port });
      const done = result => { socket.destroy(); resolve(result); };
      socket.setTimeout(700);
      socket.once('connect', () => done(true));
      socket.once('timeout', () => done(false));
      socket.once('error', error => done(error.code !== 'ECONNREFUSED' && error.code !== 'EHOSTUNREACH' && error.code !== 'EADDRNOTAVAIL'));
    });
    if (busy) return false;
  }
  return true;
}

/** The daemon also opens port+1 for previews, so both must be free before we commit. */
export async function choosePort() {
  for (let attempt = 0; attempt < 40; attempt++) {
    const port = await new Promise((resolve, reject) => {
      const probe = net.createServer();
      probe.once('error', reject);
      probe.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
        const { port: chosen } = probe.address();
        probe.close(() => resolve(chosen));
      });
    });
    if (port < 65535 && await portFree(port) && await portFree(port + 1)) return port;
  }
  fail('Could not find a free port pair for an isolated daemon.');
}

const toml = value => JSON.stringify(String(value));

export async function writeConfig(root, port) {
  const file = path.join(root, 'config.toml');
  await fsp.writeFile(file, [
    '# Generated per launch by the interface-only bridge. Edits are overwritten.',
    '# Isolation: a private data_dir gives this instance its own daemon.',
    `data_dir = ${toml(root)}`,
    'host = "127.0.0.1"',
    `port = ${port}`,
    '',
    '[update]',
    '# The updater rewrites the executable in the shared program directory, which is',
    '# used by installations this launcher does not own. Never update from here.',
    'auto_update = false',
    '',
  ].join('\n'), { encoding: 'utf8', mode: 0o600 });
  return file;
}

/** Report the daemon's own view of itself, so the port is verified rather than assumed. */
async function readLock(root, timeoutMs = 120000) {
  const file = path.join(root, 'operon.lock');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const lock = JSON.parse(await fsp.readFile(file, 'utf8'));
      if (Number.isSafeInteger(lock.pid) && Number.isSafeInteger(lock.port)) return lock;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 400));
  }
  return null;
}

/**
 * The lines to report about the daemon that came up, and whether it is the one we asked for.
 *
 * Separated from launch() and covered by tests because the port check is a safety signal: an
 * earlier edit inserted a mode check between the port comparison and its else branch, which
 * silently bound the mismatch warning to the mode and stopped it ever firing in serve mode.
 */
export function describeDaemon({ lock, assignedPort, mode, exe, root }) {
  if (!lock) return ['[bridge] WARNING: no lockfile appeared; could not verify the daemon port.'];
  const lines = [`[bridge] daemon reports version ${lock.version} on port ${lock.port} (pid ${lock.pid})`];
  if (lock.port === assignedPort) {
    lines.push('[bridge] verified: the isolated daemon took the port assigned to it');
  } else {
    // Usually means a daemon was already serving this data directory, so the port this launch
    // reserved was ignored. Harmless if that daemon is ours, but it has to be said out loud:
    // the alternative reading is that this instance is not as separate as intended.
    lines.push(`[bridge] WARNING: daemon is on port ${lock.port}, not the assigned ${assignedPort}.`);
    lines.push(`[bridge] WARNING: a daemon was probably already running for this data directory. Confirm pid ${lock.pid} is yours, or stop it with: "${exe}" stop --data-dir "${root}"`);
  }
  if (mode === 'serve') lines.push(`[bridge] open the interface at http://127.0.0.1:${lock.port}  (run: "${path.basename(exe)}" url --data-dir "${root}" for a sign-in link)`);
  return lines;
}

export async function launch({ instanceRoot, model, exe = ORIGINAL_EXE, args = [], mode = 'serve' } = {}) {
  if (!['serve', 'desktop'].includes(mode)) fail(`Unknown mode ${mode}; use serve or desktop.`);
  if (process.platform !== 'win32') fail('This launcher targets the Windows build.');
  if (!fs.existsSync(exe)) fail(`Original executable not found at ${exe}. Install or point --exe at it; this launcher never modifies it.`);

  const root = resolveInstanceRoot(instanceRoot);
  // Desktop mode cannot take --data-dir: the shell only engages with an empty argv, and the
  // config path is read from argv too. The data root is derived from the home directory, so a
  // private home is the only way to isolate it without arguments.
  const isolatedHome = path.join(root, 'home');
  const dataDir = mode === 'desktop' ? path.join(isolatedHome, '.claude-science') : root;
  await fsp.mkdir(dataDir, { recursive: true });

  const [digest, port] = await Promise.all([sha256(exe), choosePort()]);
  console.log(`[bridge] original executable ${exe}`);
  console.log(`[bridge] sha256 ${digest}`);
  console.log(`[bridge] instance root ${root}`);
  console.log(`[bridge] data dir ${dataDir}`);
  console.log(`[bridge] isolated daemon port ${port} (previews ${port + 1})`);

  // The gateway path segment is the credential: the application sends every request
  // under it, and requests without it are refused.
  const secret = randomBytes(32).toString('hex');
  const bridgeState = path.join(root, 'bridge-state');
  await fsp.mkdir(bridgeState, { recursive: true });
  const gateway = await startGateway({
    port: 0,
    secret,
    dataRoot: bridgeState,
    // Built here rather than left to the gateway's default so the requested model is
    // honoured without going through a process-wide environment variable.
    adapter: new Adapter({
      cwd: bridgeState,
      model: model || process.env.SCIENCE_CHATGPT_MODEL || undefined,
      maxContexts: 8,
      contextTtlMs: 15 * 60 * 1000,
      requestTimeoutMs: 15 * 60 * 1000,
    }),
  });

  // Prove ChatGPT is usable before starting the application, so a failure here never
  // leaves a half-configured instance behind.
  try {
    await gateway.startup;
    const health = await fetch(`${gateway.origin}/health`).then(response => response.json());
    if (!health.ok) fail(`ChatGPT is not ready: ${health.error ?? 'unknown reason'}`);
    console.log('[bridge] ChatGPT connection ready');
  } catch (error) {
    await gateway.close().catch(() => {});
    fail(`Refusing to launch: ${error.message}`);
  }

  const configFile = await writeConfig(dataDir, port);
  const baseUrl = `${gateway.origin}/${secret}`;

  // ANTHROPIC_BASE_URL is set on this child only. It is never exported to the user's
  // environment and no existing installation, shortcut or data directory is touched.
  const env = { ...process.env, ANTHROPIC_BASE_URL: baseUrl };
  delete env.ANTHROPIC_API_KEY;   // refused by the application, and not ours to forward
  delete env.ANTHROPIC_AUTH_TOKEN;

  // 'serve' runs the daemon and serves the original interface in a browser; it is the mode
  // verified against this build. 'desktop' is the bare invocation the shortcut uses, which
  // wraps the same interface in Electron — the same UI, but that invocation is not verified
  // here, so it is opt-in rather than the default.
  const invocation = mode === 'serve'
    ? ['serve', '--no-browser', '--data-dir', root, '--config', configFile, '--port', String(port)]
    : [];
  if (mode === 'desktop') {
    if (args.length) fail('Desktop mode takes no extra arguments: the shell only engages when argv is empty.');
    // Derived from the home directory rather than a flag, for the reason above.
    env.USERPROFILE = isolatedHome;
    env.HOME = isolatedHome;
    // The native sandbox resolves its protected-root table from the profile and refuses to
    // arm if the AppData roots are missing, which a bare directory does not have. Without
    // these the app starts and then dies with "Sandbox unavailable".
    await Promise.all(['AppData/Local', 'AppData/Roaming', 'AppData/LocalLow', 'Documents', 'Desktop']
      .map(leaf => fsp.mkdir(path.join(isolatedHome, leaf), { recursive: true })));
    // An Explorer launch has this; a launch from a shell may not, and the shell check
    // rejects a session without it.
    env.SESSIONNAME ??= 'Console';
    // Any of these makes the app read the session as remote and refuse the desktop shell.
    for (const remote of ['SSH_CONNECTION', 'SSH_TTY', 'SSH_CLIENT']) delete env[remote];
    // Set by the app on its own re-spawn; present in our environment it would be read as
    // "already the desktop child" and the shell would never start.
    delete env.OPERON_WIN_DESKTOP_LAUNCH;
  }
  // The shell refuses to start when a console is attached, which is why running the
  // executable from a terminal prints usage instead. detached + ignored stdio leaves the
  // child without one. windowsHide must NOT be set: it adds CREATE_NO_WINDOW, which still
  // gives the process a console and only hides it, so the check fails and the app exits.
  const child = mode === 'desktop'
    ? spawn(exe, [], { env, cwd: path.dirname(exe), detached: true, stdio: 'ignore' })
    : spawn(exe, [...invocation, ...args], {
        env, cwd: root, stdio: ['ignore', 'inherit', 'inherit'], windowsHide: false,
      });
  if (mode === 'desktop') child.unref();
  console.log(`[bridge] launched original application in ${mode} mode, pid ${child.pid}`);
  console.log('[bridge] inference is served by ChatGPT; sign-in still uses your Claude account');

  const lock = await readLock(dataDir);
  for (const line of describeDaemon({ lock, assignedPort: port, mode, exe, root: dataDir })) {
    (line.startsWith('[bridge] WARNING') ? console.warn : console.log)(line);
  }

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    // Only the gateway we started is closed. The launched application is signalled and
    // left to exit on its own; no process this launcher did not spawn is ever touched.
    await gateway.close().catch(() => {});
  };
  if (mode === 'desktop') {
    // The helper returns as soon as it has started the detached shell, so its exit says
    // nothing about the application. Tying the gateway to it would close the gateway while
    // the app is still running and leave inference dead. Follow the daemon instead.
    console.log('[bridge] the application runs detached; leave this window open so inference keeps working (Ctrl-C to stop the gateway)');
    const watch = setInterval(() => {
      if (lock?.pid && !alive(lock.pid)) {
        clearInterval(watch);
        console.log('[bridge] the isolated daemon exited');
        void shutdown().then(() => process.exit(0));
      }
    }, 3000);
    watch.unref?.();
  } else {
    child.once('exit', code => { console.log(`[bridge] application exited (${code})`); void shutdown().then(() => process.exit(code ?? 0)); });
  }
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => void shutdown().then(() => process.exit(0)));

  return { child, gateway, root, dataDir, port, baseUrl, digest };
}

/**
 * Command-line entry. Exported rather than run on import-detection, because when these
 * modules are bundled into a single executable every module sees the same path and more
 * than one "am I the entry point?" check would fire.
 */
export async function main(argv = process.argv.slice(2)) {
  const option = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(`Launch an isolated Claude Science instance with ChatGPT inference.

  --instance-root DIR  Private data directory (default: %LOCALAPPDATA%\\ChatGPTScienceBridge\\instance)
  --model ID           ChatGPT model to serve (default: the account's default)
  --exe PATH           Original executable (default: the installed one)
  --desktop            Launch the Electron shell instead of serving the interface over
                       http. Isolated through a private home directory, because the
                       shell only starts with an empty argv and so cannot take
                       --data-dir.

Runs alongside an existing installation without touching it: private data directory,
private port, its own daemon, auto-update disabled. Sign-in still requires your Claude
account; only inference is served by ChatGPT.`);
    return 0;
  }
  await launch({
    instanceRoot: option('--instance-root'),
    model: option('--model'),
    exe: option('--exe'),
    mode: argv.includes('--desktop') ? 'desktop' : 'serve',
  });
  return 0;
}
