import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

const appRoot = fileURLToPath(new URL('../', import.meta.url));
const secretName = /TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API.?KEY|PRIVATE.?KEY|AUTH|COOKIE/i;

export function defaultRuntimeDir() {
  return path.resolve(process.env.SCIENCE_RUNTIME_DIR || process.env.ROOT_RUNTIME
    || (process.resourcesPath ? path.join(process.resourcesPath, 'runtime') : path.join(appRoot, '.runtime')));
}

export function defaultPythonPath(runtimeDir = defaultRuntimeDir()) {
  const standaloneRoot = path.join(runtimeDir, 'python');
  const executable = process.platform === 'win32' ? 'python.exe' : 'bin/python3';
  const direct = path.join(standaloneRoot, executable);
  if (fs.existsSync(direct)) return direct;
  if (fs.existsSync(standaloneRoot)) {
    // uv creates a version alias symlink with an absolute target. Resolve only
    // real version directories so relocating the installed app stays portable.
    const versions = fs.readdirSync(standaloneRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('cpython-'))
      .map((entry) => entry.name).sort().reverse();
    for (const version of versions) {
      const candidate = path.join(standaloneRoot, version, executable);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  const candidate = path.join(appRoot, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  return fs.existsSync(candidate) ? candidate : (process.platform === 'win32' ? 'python' : 'python3');
}

function physicalWorkerPath(runtimeDir, workerDir) {
  const candidates = [
    workerDir && path.join(workerDir, 'kernel_worker.py'),
    path.join(runtimeDir, 'worker', 'kernel_worker.py'),
    process.resourcesPath && path.join(process.resourcesPath, 'worker', 'kernel_worker.py'),
    path.join(appRoot.replace(/\.asar(?=[\\/]|$)/, '.asar.unpacked'), 'worker', 'kernel_worker.py'),
    path.join(appRoot, 'worker', 'kernel_worker.py'),
  ].filter(Boolean);
  const found = candidates.find((candidate) => !/[\\/]app\.asar[\\/]/.test(candidate) && fs.existsSync(candidate));
  if (!found) throw new Error('Physical kernel worker is missing. Package worker/kernel_worker.py outside app.asar or set SCIENCE_WORKER_DIR.');
  return found;
}

/** JSONL transport to real persistent Jupyter kernels. This is host execution. */
export class KernelClient extends EventEmitter {
  constructor({ pythonPath, root = appRoot, idleSeconds = 1800, runtimeDir = defaultRuntimeDir(),
    workerDir = process.env.SCIENCE_WORKER_DIR, environmentDir = process.env.SCIENCE_ENVIRONMENT_DIR,
    rPath = process.env.SCIENCE_R_PATH } = {}) {
    super();
    this.runtimeDir = path.resolve(runtimeDir);
    this.pythonPath = pythonPath || defaultPythonPath(this.runtimeDir);
    this.workerDir = workerDir;
    this.environmentDir = environmentDir;
    this.rPath = rPath;
    this.root = path.resolve(root);
    this.idleSeconds = idleSeconds;
    this.pending = new Map();
    this.child = null;
    this.closed = false;
    this.stderr = '';
  }

  start() {
    if (this.closed) throw new Error('Kernel client is shut down');
    if (this.child) return;
    fs.mkdirSync(this.root, { recursive: true });
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !secretName.test(key)));
    delete env.PYTHONPATH;
    delete env.PYTHONSTARTUP;
    delete env.PYTHONHOME;
    Object.assign(env, { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1',
      PYTHONNOUSERSITE: '1', SCIENCE_RUNTIME_DIR: this.runtimeDir });
    if (this.environmentDir) env.SCIENCE_ENVIRONMENT_DIR = path.resolve(this.environmentDir);
    if (this.rPath) env.SCIENCE_R_PATH = path.resolve(this.rPath);
    const child = spawn(this.pythonPath, ['-u', physicalWorkerPath(this.runtimeDir, this.workerDir),
      '--root', this.root, '--idle-seconds', String(this.idleSeconds)], {
      cwd: this.root, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    this.child = child;
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, 'utf8') > 20 * 1024 * 1024) {
        this.failAll(new Error('Kernel worker response exceeded transport limit'));
        child.kill();
        return;
      }
      let end;
      while ((end = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        try { this.receive(JSON.parse(line)); }
        catch (error) { this.emit('diagnostic', { message: `Invalid worker message: ${error.message}` }); }
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      this.stderr = (this.stderr + chunk).slice(-16000);
      this.emit('diagnostic', { message: chunk });
    });
    child.stdin.on('error', (error) => this.failAll(error));
    child.once('error', (error) => {
      this.child = null;
      this.failAll(new Error(`Cannot start Python worker (${this.pythonPath}): ${error.message}`));
    });
    child.once('exit', (code, signal) => {
      if (this.child === child) this.child = null;
      this.failAll(new Error(`Python worker exited (${code ?? signal ?? 'unknown'}). ${this.stderr.slice(-2000)}`));
      this.emit('status', { status: 'worker-stopped', code, signal });
    });
  }

  receive(message) {
    if (message.event) {
      const { event, ...payload } = message;
      this.emit(event, payload);
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) {
      const error = new Error(message.error.message || String(message.error));
      error.name = message.error.type || 'KernelError';
      pending.reject(error);
    } else pending.resolve(message.result);
  }

  failAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  request(method, params = {}) {
    try { this.start(); } catch (error) { return Promise.reject(error); }
    const id = randomUUID();
    const timeoutMs = method === 'execute' ? 4 * 3600_000 : method.startsWith('environments') ? 900_000 : 70_000;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Kernel worker request timed out: ${method}`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, method, params }) + '\n', (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  probe() { return this.request('probe'); }
  create(params) { return this.request('create', params); }
  execute(params) { return this.request('execute', params); }
  interrupt(params) { return this.request('interrupt', typeof params === 'string' ? { kernelId: params } : params); }
  restart(params) { return this.request('restart', typeof params === 'string' ? { kernelId: params } : params); }
  close(params) { return this.request('close', typeof params === 'string' ? { kernelId: params } : params); }
  list() { return this.request('list'); }
  listEnvironments() { return this.request('environments/list'); }
  createEnvironment(params) { return this.request('environments/create', params); }
  installPackages(params) { return this.request('environments/install', params); }
  exportEnvironment(params) { return this.request('environments/export', params); }
  preview(params) { return this.request('preview', params); }

  async shutdown() {
    if (this.closed) return { ok: true };
    if (!this.child) { this.closed = true; return { ok: true }; }
    const child = this.child;
    try { return await this.request('shutdown'); }
    finally {
      this.closed = true;
      const exited = new Promise((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) resolve();
        else child.once('exit', resolve);
      });
      child.stdin.end();
      const timer = setTimeout(() => child.kill(), 10_000);
      timer.unref?.();
      await exited;
      clearTimeout(timer);
    }
  }
}
