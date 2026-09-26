import { EventEmitter } from 'node:events';
import { spawn, execFile } from 'node:child_process';
import { access, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const MAX_FRAME_BYTES = 40 * 1024 * 1024;
const APPROVAL_METHODS = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
  'item/tool/requestUserInput',
  'tool/requestUserInput',
  'mcpServer/elicitation/request',
]);

async function executable(candidate) {
  if (!candidate) return false;
  try {
    await access(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
    return true;
  } catch { return false; }
}

/** Resolve the native npm payload instead of invoking a Windows .cmd/.ps1 shell. */
export async function findCodexExecutable(env = process.env) {
  if (env.SCIENCE_CODEX_PATH) {
    const configured = path.resolve(env.SCIENCE_CODEX_PATH);
    if (process.platform === 'win32' && !configured.toLowerCase().endsWith('.exe')) {
      throw new Error('SCIENCE_CODEX_PATH must point to the native codex.exe executable.');
    }
    if (!await executable(configured)) throw new Error('SCIENCE_CODEX_PATH does not point to an executable file.');
    return configured;
  }

  let discovered = [];
  try {
    const { stdout } = await execFileAsync(process.platform === 'win32' ? 'where.exe' : 'which', ['codex'], {
      windowsHide: true, timeout: 5000, encoding: 'utf8', env,
    });
    discovered = stdout.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
  } catch { /* npm paths below also cover a missing PATH entry. */ }

  if (process.platform !== 'win32') {
    for (const candidate of discovered) if (await executable(candidate)) return await realpath(candidate);
    throw new Error('Codex CLI was not found. Install Codex or set SCIENCE_CODEX_PATH.');
  }

  for (const candidate of discovered) {
    if (candidate.toLowerCase().endsWith('.exe') && await executable(candidate)) return candidate;
  }
  const roots = new Set(discovered.map(candidate => path.dirname(candidate)));
  if (env.APPDATA) roots.add(path.join(env.APPDATA, 'npm'));
  const architectures = process.arch === 'arm64' ? ['arm64', 'x64'] : ['x64', 'arm64'];
  for (const root of roots) {
    const packageRoot = path.join(root, 'node_modules', '@openai', 'codex');
    for (const arch of architectures) {
      const triple = arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc';
      const platformRoot = path.join(packageRoot, 'node_modules', '@openai', `codex-win32-${arch}`);
      for (const base of [platformRoot, packageRoot]) {
        for (const folder of ['bin', 'codex']) {
          const candidate = path.join(base, 'vendor', triple, folder, 'codex.exe');
          if (await executable(candidate)) return candidate;
        }
      }
    }
  }
  throw new Error('Native Codex executable was not found. Set SCIENCE_CODEX_PATH to codex.exe.');
}

function errorFromProtocol(error) {
  const result = new Error(typeof error?.message === 'string' ? error.message : 'Codex request failed.');
  if (typeof error?.code === 'number') result.code = error.code;
  return result;
}

function normalizeTools(definitions = []) {
  return definitions.map(definition => {
    if (!definition || !/^[a-zA-Z0-9_-]{1,64}$/.test(definition.name ?? '')) {
      throw new Error('Science tool names must contain 1–64 letters, digits, underscores, or hyphens.');
    }
    if (!definition.description || !definition.inputSchema || definition.inputSchema.type !== 'object') {
      throw new Error(`Science tool ${definition.name} needs a description and an object JSON Schema.`);
    }
    return { type: 'function', name: definition.name, description: definition.description, inputSchema: definition.inputSchema };
  });
}

/**
 * Local JSONL client for Codex App Server, verified against CLI 0.155.1.
 * The transportFactory option is a test seam; normal callers use the native CLI.
 * Never reads auth files or forwards raw stderr, which can contain private data.
 */
export class CodexBridge extends EventEmitter {
  constructor({ cwd, toolHandler, toolDefinitions = [], skillsRoot, transportFactory,
    requestTimeoutMs = 90000, toolTimeoutMs = 300000 } = {}) {
    super();
    this.cwd = path.resolve(cwd ?? process.cwd());
    this.skillsRoot = skillsRoot ? path.resolve(skillsRoot) : null;
    this.toolHandler = toolHandler;
    this.toolDefinitions = normalizeTools(toolDefinitions);
    this.toolNames = new Set(this.toolDefinitions.map(tool => tool.name));
    this.readOnlyToolNames = new Set(toolDefinitions.filter(tool => tool.readOnly === true || tool.annotations?.readOnlyHint === true).map(tool => tool.name));
    this.transportFactory = transportFactory;
    this.requestTimeoutMs = requestTimeoutMs;
    this.toolTimeoutMs = toolTimeoutMs;
    this.process = null;
    this.pending = new Map();
    this.approvals = new Map();
    this.activeTurns = new Map();
    this.threadPolicies = new Map();
    this.nextId = 1;
    this.state = 'stopped';
    this.startPromise = null;
    this.closing = false;
    this.generation = 0;
  }

  _status(state, detail = {}) {
    this.state = state;
    this.emit('status', { state, ...detail });
  }

  _report(error) {
    if (this.listenerCount('error')) this.emit('error', error);
    else this.emit('status', { state: this.state, error: error.message });
  }

  async start() {
    if (this.state === 'ready') return this;
    if (this.startPromise) return this.startPromise;
    if (this.closing) throw new Error('Codex bridge is closing.');
    this.startPromise = this._start();
    try { return await this.startPromise; }
    finally { this.startPromise = null; }
  }

  async _start() {
    this._status('starting');
    const generation = ++this.generation;
    let child;
    try {
      if (this.transportFactory) child = await this.transportFactory();
      else {
        const executablePath = await findCodexExecutable();
        if (this.closing || generation !== this.generation) throw new Error('Codex bridge was closed during startup.');
        child = spawn(executablePath, ['app-server', '--listen', 'stdio://'], {
          cwd: this.cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], shell: false,
        });
      }
      if (this.closing || generation !== this.generation) {
        child.kill();
        throw new Error('Codex bridge was closed during startup.');
      }
      this.process = child;
      const decoder = new StringDecoder('utf8');
      let buffer = '';
      child.stdout.on('data', chunk => {
        if (generation !== this.generation) return;
        buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk);
        let newline;
        while ((newline = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          if (Buffer.byteLength(line) > MAX_FRAME_BYTES) {
            this._report(new Error('Codex protocol frame exceeded its size limit.'));
            continue;
          }
          try { this._message(JSON.parse(line), generation); }
          catch { this._report(new Error('Codex returned an invalid JSONL protocol frame.')); }
        }
        if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES) {
          this._report(new Error('Codex protocol stream exceeded its frame limit.'));
          child.kill();
        }
      });
      // Drain stderr to prevent backpressure without retaining credentials or prompts.
      child.stderr?.resume();
      child.stdin.on('error', error => {
        if (generation === this.generation && !this.closing) this._report(new Error(`Codex input stream failed (${error.code ?? 'stream error'}).`));
      });
      child.on('error', error => {
        if (generation !== this.generation) return;
        const failure = new Error(`Codex process failed (${error.code ?? 'process error'}).`);
        this._rejectPending(failure);
        this._status('error', { error: failure.message });
        this._report(failure);
      });
      child.on('exit', (code, signal) => {
        if (generation !== this.generation) return;
        this.process = null;
        this._rejectPending(new Error('Codex process stopped before completing the request.'));
        this.approvals.clear();
        this.activeTurns.clear();
        this._status(this.closing || code === 0 ? 'stopped' : 'error', { code, signal });
      });
      await this._request('initialize', {
        clientInfo: { name: 'science_api_bridge', title: 'Science API Bridge', version: '0.1.0' },
        capabilities: { experimentalApi: true },
      });
      this._write({ method: 'initialized', params: {} });
      if (this.skillsRoot) await this._request('skills/extraRoots/set', { extraRoots: [this.skillsRoot] });
      this._status('ready');
      return this;
    } catch (error) {
      if (child && this.process === child) child.kill();
      this.process = null;
      this._rejectPending(error);
      this._status(this.closing ? 'stopped' : 'error', this.closing ? {} : { error: error.message });
      throw error;
    }
  }

  _write(message) {
    if (!this.process?.stdin || this.process.stdin.destroyed || this.process.stdin.writableEnded) {
      throw new Error('Codex bridge is not connected.');
    }
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  _request(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex request timed out: ${method}.`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer, method, params });
      try { this._write({ id, method, params }); }
      catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  _rejectPending(error) {
    for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(error); }
    this.pending.clear();
  }

  _message(message, generation) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) return;
    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(errorFromProtocol(message.error));
      else {
        if (pending.method === 'turn/start' && message.result?.turn?.status === 'inProgress') {
          this.activeTurns.set(pending.params.threadId, message.result.turn.id);
        }
        pending.resolve(message.result);
      }
      return;
    }
    if (message.id !== undefined && typeof message.method === 'string') {
      if (message.method === 'item/tool/call') {
        void this._toolCall(message, generation);
      } else if (APPROVAL_METHODS.has(message.method)) {
        this.approvals.set(String(message.id), message);
        this.emit('approval', { id: message.id, method: message.method, params: message.params });
      } else {
        this._write({ id: message.id, error: { code: -32601, message: 'This client does not implement that server request.' } });
      }
      return;
    }
    if (typeof message.method !== 'string') return;
    const params = message.params ?? {};
    if (message.method === 'turn/started' && params.threadId && params.turn?.id) {
      this.activeTurns.set(params.threadId, params.turn.id);
    }
    if (message.method === 'turn/completed' && params.threadId) {
      if (!params.turn?.id || this.activeTurns.get(params.threadId) === params.turn.id) this.activeTurns.delete(params.threadId);
      for (const [id, request] of this.approvals) {
        if (request.params?.threadId === params.threadId) this.approvals.delete(id);
      }
    }
    if (message.method === 'serverRequest/resolved') this.approvals.delete(String(params.requestId));
    this.emit('notification', message);
  }

  async _toolCall(message, generation) {
    let timeout;
    let result;
    try {
      const { tool, arguments: args, threadId, turnId, callId, namespace } = message.params ?? {};
      if (namespace || !this.toolNames.has(tool) || typeof this.toolHandler !== 'function') {
        throw new Error('Requested science tool is not registered in this workbench.');
      }
      if (this.threadPolicies.get(threadId)?.readOnly && !this.readOnlyToolNames.has(tool)) {
        throw new Error('This review session only permits read-only science tools.');
      }
      const value = await Promise.race([
        Promise.resolve().then(() => this.toolHandler(tool, args, { threadId, turnId, callId })),
        new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Science tool timed out. Check the run before retrying.')), this.toolTimeoutMs); }),
      ]);
      if (value?.__codexContentItems) {
        result = { contentItems: value.__codexContentItems, success: value.success !== false };
      } else {
        result = { contentItems: [{ type: 'inputText', text: JSON.stringify(value ?? null) }], success: true };
      }
      if (Buffer.byteLength(JSON.stringify(result)) > 32 * 1024 * 1024) throw new Error('External tool output exceeds the 32 MiB bridge limit.');
    } catch (error) {
      result = { contentItems: [{ type: 'inputText', text: JSON.stringify({ error: error.message ?? 'Science tool failed.' }) }], success: false };
    } finally { clearTimeout(timeout); }
    if (generation !== this.generation || this.closing || !this.process) return;
    try { this._write({ id: message.id, result }); }
    catch (error) { this._report(error); }
  }

  async account() { await this.start(); return this._request('account/read', { refreshToken: false }); }
  async login() { await this.start(); return this._request('account/login/start', { type: 'chatgpt' }); }
  async request(method, params = {}) { await this.start(); return this._request(method, params); }

  async models() {
    await this.start();
    const models = [];
    let cursor;
    const seen = new Set();
    do {
      const result = await this._request('model/list', { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) });
      models.push(...(result.data ?? []));
      cursor = result.nextCursor;
      if (cursor && seen.has(cursor)) throw new Error('Codex model pagination returned a repeated cursor.');
      if (cursor) seen.add(cursor);
    } while (cursor);
    return models;
  }

  async _reviewConfig(cwd, webPolicy) {
    // Sandbox permissions do not constrain remote MCP tools. Disable inherited
    // tool integrations in this thread only; do not edit the user's config.
    const { config = {} } = await this._request('config/read', { cwd, includeLayers: false });
    const overrides = {
      'features.shell_tool': false,
      'features.unified_exec': false,
      'features.browser_use': false,
      'features.computer_use': false,
      'features.multi_agent': false,
      'features.apps': false,
      'features.plugins': false,
      'features.hooks': false,
      'features.image_generation': false,
      'features.memories': false,
      'features.sleep_tool': false,
      'features.skill_search': false,
      'features.skip_host_skill_discovery': true,
      'tools.view_image': false,
      'agents.enabled': false,
      'project_doc_max_bytes': 0,
      'web_search': 'disabled',
    };
    // These override keys are not a TOML parser: quoted dotted segments would
    // become literal server names. Replace the maps to preserve arbitrary ids.
    // config/read includes nullable normalized defaults that cannot be sent
    // back as TOML overrides. Preserve only the required transport selector.
    overrides.mcp_servers = Object.fromEntries(Object.entries(config.mcp_servers ?? {}).map(([name, server]) => [name, {
      ...(typeof server.url === 'string' ? { url: server.url } : { command: server.command || process.execPath }), enabled: false,
    }]));
    overrides.plugins = Object.fromEntries(Object.keys(config.plugins ?? {}).map(name => [name, { enabled: false }]));
    if (webPolicy) {
      overrides.web_search = 'live';
      overrides['tools.web_search'] = { context_size: 'low', ...(webPolicy.allowedDomains?.length ? { allowed_domains: webPolicy.allowedDomains } : {}), ...(webPolicy.location ? { location: webPolicy.location } : {}) };
    }
    return overrides;
  }

  async startThread({ cwd = this.cwd, instructions = '', baseInstructions, model, readOnly = false, ephemeral = false, webPolicy } = {}) {
    await this.start();
    cwd = path.resolve(cwd);
    const result = await this._request('thread/start', {
      cwd, approvalPolicy: readOnly ? 'never' : 'on-request', approvalsReviewer: 'user', sandbox: readOnly ? 'read-only' : 'workspace-write',
      developerInstructions: instructions,
      ...(baseInstructions ? { baseInstructions } : {}),
      dynamicTools: readOnly ? this.toolDefinitions.filter(tool => this.readOnlyToolNames.has(tool.name)) : this.toolDefinitions,
      ...(readOnly ? { config: await this._reviewConfig(cwd, webPolicy) } : {}),
      ...(ephemeral ? { ephemeral: true } : {}),
      ...(model ? { model } : {}),
    });
    if (result.thread?.id) this.threadPolicies.set(result.thread.id, { readOnly, cwd });
    return result;
  }

  async resumeThread(threadId, options = {}) {
    await this.start();
    const prior = this.threadPolicies.get(threadId);
    const readOnly = options.readOnly ?? prior?.readOnly ?? false;
    const cwd = path.resolve(options.cwd ?? prior?.cwd ?? this.cwd);
    const result = await this._request('thread/resume', {
      threadId, cwd, approvalPolicy: readOnly ? 'never' : 'on-request', approvalsReviewer: 'user', sandbox: readOnly ? 'read-only' : 'workspace-write',
      ...(readOnly ? { config: await this._reviewConfig(cwd) } : {}),
    });
    this.threadPolicies.set(threadId, { readOnly, cwd });
    return result;
  }

  async send(threadId, text, { model } = {}) {
    if (typeof text !== 'string' || !text.trim()) throw new Error('A non-empty message is required.');
    await this.start();
    return this._request('turn/start', {
      threadId, input: [{ type: 'text', text }], ...(model ? { model } : {}),
    });
  }

  async interrupt(threadId) {
    await this.start();
    const turnId = this.activeTurns.get(threadId);
    if (!turnId) return { interrupted: false };
    return this._request('turn/interrupt', { threadId, turnId });
  }

  respondApproval(id, decision) {
    const request = this.approvals.get(String(id));
    if (!request) throw new Error('Approval is no longer pending.');
    const accepted = decision === 'accept' || decision === 'acceptForSession';
    let result;
    if (request.method === 'item/tool/requestUserInput' || request.method === 'tool/requestUserInput') {
      if (decision && typeof decision === 'object' && decision.answers) result = { answers: decision.answers };
      else if (!accepted && ['decline', 'cancel'].includes(decision)) result = { answers: {} };
      else throw new Error('This request requires answers to its questions.');
    } else if (request.method === 'mcpServer/elicitation/request') {
      if (decision && typeof decision === 'object' && ['accept', 'decline', 'cancel'].includes(decision.action)) result = decision;
      else if (['decline', 'cancel'].includes(decision)) result = { action: decision, content: null };
      else if (accepted && request.params?.mode === 'url') result = { action: 'accept', content: null };
      else throw new Error('This request requires structured form answers.');
    } else if (request.method === 'item/permissions/requestApproval') {
      if (!['accept', 'acceptForSession', 'decline', 'cancel'].includes(decision)) throw new Error('Unsupported permission decision.');
      result = { permissions: accepted ? request.params.permissions : {}, scope: decision === 'acceptForSession' ? 'session' : 'turn' };
    } else {
      if (!['accept', 'acceptForSession', 'decline', 'cancel'].includes(decision)) throw new Error('Unsupported approval decision.');
      result = { decision };
    }
    this._write({ id: request.id, result });
    this.approvals.delete(String(id));
    return { ok: true };
  }

  async close() {
    this.closing = true;
    ++this.generation;
    const child = this.process;
    this.process = null;
    this._rejectPending(new Error('Codex bridge was closed.'));
    this.approvals.clear();
    this.activeTurns.clear();
    if (child && child.exitCode == null) {
      await new Promise(resolve => {
        const timer = setTimeout(() => { child.kill(); resolve(); }, 1500);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
        try { child.stdin.end(); } catch { child.kill(); }
      });
    }
    this._status('stopped');
  }
}
