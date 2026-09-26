import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const COLLECTIONS = ['projects', 'sessions', 'artifacts', 'runs', 'connections', 'memories', 'approvals'];
const ACTIVE_RUNS = new Set(['queued', 'starting', 'running', 'cancelling']);

export class Store {
  constructor(dataRoot) {
    if (typeof dataRoot !== 'string' || !dataRoot.trim()) throw new Error('A data directory is required.');
    fs.mkdirSync(path.resolve(dataRoot), { recursive: true, mode: 0o700 });
    if (fs.lstatSync(path.resolve(dataRoot)).isSymbolicLink()) throw new Error('The data directory cannot be a symbolic link.');
    this.dataRoot = fs.realpathSync(path.resolve(dataRoot));
    this.root = this.dataRoot;
    this.filePath = path.join(this.dataRoot, 'store.json');
    this.projectsRoot = this.ensureDirectory('projects');
    this.uploadsRoot = this.ensureDirectory('uploads');
    this.artifactsRoot = this.ensureDirectory('artifacts');
    this.exportsRoot = this.ensureDirectory('exports');
    this.data = Object.fromEntries(COLLECTIONS.map(name => [name, []]));
    this.data.settings = { theme: 'dark', maxRuntimeSeconds: 600, maxConcurrentRuns: 2, maxRetries: 0 };
    this.data.schemaVersion = 1;
    if (fs.existsSync(this.filePath)) {
      this.managedPath(this.filePath, { mustExist: true });
      let loaded;
      try { loaded = JSON.parse(fs.readFileSync(this.filePath, 'utf8')); }
      catch (error) { throw new Error(`Cannot read persisted project data; the file was left untouched: ${error.message}`); }
      if (!loaded || typeof loaded !== 'object' || Array.isArray(loaded)) throw new Error('Invalid persisted store format.');
      if (loaded.schemaVersion && loaded.schemaVersion !== 1) throw new Error('Unsupported persisted store version.');
      for (const name of COLLECTIONS) {
        if (loaded[name] !== undefined && !Array.isArray(loaded[name])) throw new Error(`Invalid persisted collection: ${name}`);
      }
      this.data = { ...this.data, ...loaded, settings: { ...this.data.settings, ...loaded.settings } };
    }
    const now = new Date().toISOString();
    let recovered = false;
    for (const run of this.data.runs) {
      if (!ACTIVE_RUNS.has(run.status)) continue;
      const remote = Boolean(run.jobId || run.remoteJobId);
      run.status = remote ? 'unknown' : 'interrupted';
      run.recoveryReason = remote ? 'Application restarted; reconcile the remote job before retrying.' : 'Application restarted before execution completion was recorded.';
      run.recoveredAt = now;
      if (!remote) run.endedAt = now;
      recovered = true;
    }
    for (const session of this.data.sessions) {
      if (['starting', 'running', 'thinking', 'streaming'].includes(session.status)) {
        session.status = 'interrupted';
        recovered = true;
      }
    }
    // Approval IDs belong to the previous app-server connection. Reusing a
    // persisted request after reconnect could approve an unrelated new request.
    if (this.data.approvals.length) {
      this.data.approvals = [];
      recovered = true;
    }
    if (recovered || !fs.existsSync(this.filePath)) this.save();
  }

  // All application-owned paths use this check. Symlinks and junctions are
  // rejected even when their present target is inside the data directory.
  managedPath(input, { mustExist = false } = {}) {
    if (typeof input !== 'string' || !input || input.includes('\0')) throw new Error('Invalid managed file path.');
    if (input.split(/[\\/]/).includes('..')) throw new Error('Path traversal is not allowed.');
    const absolute = path.isAbsolute(input) ? path.resolve(input) : path.resolve(this.dataRoot, input);
    const relative = path.relative(this.dataRoot, absolute);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('File is outside managed storage.');
    let cursor = this.dataRoot;
    for (const segment of relative.split(path.sep).filter(Boolean)) {
      if (process.platform === 'win32' && segment.includes(':')) throw new Error('Alternate data streams are not allowed.');
      cursor = path.join(cursor, segment);
      try {
        if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error('Symbolic links and junctions are not allowed in managed storage.');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    if (mustExist && !fs.existsSync(absolute)) throw new Error('Managed file does not exist.');
    return absolute;
  }

  ensureDirectory(relative) {
    const absolute = this.managedPath(relative);
    fs.mkdirSync(absolute, { recursive: true, mode: 0o700 });
    this.managedPath(absolute, { mustExist: true });
    return absolute;
  }

  projectRoot(id) {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw new Error('Invalid project identifier.');
    return this.ensureDirectory(path.join('projects', id));
  }

  save() {
    const serialized = JSON.stringify(this.data, null, 2);
    const target = this.managedPath(this.filePath);
    const temporary = this.managedPath(path.join(this.dataRoot, `.store-${randomUUID()}.tmp`));
    let fd;
    try {
      fd = fs.openSync(temporary, 'wx', 0o600);
      fs.writeFileSync(fd, serialized, 'utf8');
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      fs.renameSync(temporary, target);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  }

  // Synchronous transactions serialize mutations in this single server process.
  update(fn) {
    if (typeof fn !== 'function' || fn.constructor.name === 'AsyncFunction') throw new Error('Store updates must be synchronous.');
    const previous = structuredClone(this.data);
    try {
      const result = fn(this.data);
      if (result && typeof result.then === 'function') throw new Error('Store updates must be synchronous.');
      this.save();
      return result;
    } catch (error) {
      this.data = previous;
      throw error;
    }
  }
}

export default Store;
