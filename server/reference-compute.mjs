import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ACTIVE = new Set(['queued', 'starting', 'running', 'cancelling']);
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const unsupported = (feature) => { throw fail(`${feature} is not implemented by the independent ChatGPT compute service.`, 501); };
const encode = encodeURIComponent;
const iso = () => new Date().toISOString();
const isObject = (value) => value && typeof value === 'object' && !Array.isArray(value);
const terminal = (run) => !ACTIVE.has(run.status);
const seconds = (start, end) => Math.max(0, (Date.parse(end || iso()) - Date.parse(start || iso())) / 1000);
const environmentName = (kernel) => !kernel?.environmentId || ['default', 'r-default'].includes(kernel.environmentId)
  ? kernel?.language || 'python' : kernel.environmentId;

function outputText(run, stream = 'stdout') {
  return (run.outputs || []).map((output) => {
    if (output.type === 'stream' && (output.name || 'stdout') === stream) return output.text || '';
    if (stream === 'stderr' && output.type === 'error') return output.text || output.evalue || '';
    if (stream === 'stdout' && output.type === 'display') {
      const text = output.data?.['text/plain'];
      return Array.isArray(text) ? text.join('') : text || '';
    }
    return '';
  }).filter(Boolean).join('\n');
}

export function referenceEnvironmentSnapshot(environment = {}, name = 'Scientific environment') {
  return { environment_name: name, python_version: environment.python?.split(' ')[0] || '',
    r_version: environment.r || null, language: environment.language || 'python',
    packages: Object.entries(environment.packages || {}).map(([name, version]) => ({ name, version: String(version) })),
    captured_at: environment.capturedAt || null, execution_mode: 'host', sandboxed: false };
}

/** Compatibility DTOs for the copied UI; all operations delegate to our service. */
export function mountReferenceCompute(router, ctx) {
  const { store } = ctx;
  const pendingUserCells = new Map();
  const call = (method, route, body) => ctx.call(method, route, body);
  const getState = () => call('GET', '/api/state');
  const data = () => store.data;
  const findProject = (id) => {
    const project = data().projects.find((item) => item.id === id);
    if (!project) throw fail('Unknown project.', 404);
    return project;
  };
  const findSession = (id) => {
    const session = data().sessions.find((item) => item.id === id);
    if (!session) throw fail('Unknown research session.', 404);
    findProject(session.projectId);
    return session;
  };
  const allowedProject = (id) => {
    const project = findProject(id);
    if (!project.allowHostExecution) throw fail('Enable local code execution in this project before running code or changing environments. Code runs with your user permissions.', 403);
    return project;
  };
  const mutate = (fn, type = 'compute/settings') => {
    store.update(fn);
    ctx.notify?.(type);
  };
  const ownedRun = (frameId, id) => {
    const session = findSession(frameId);
    const run = data().runs.find((item) => item.id === id && item.sessionId === session.id && item.projectId === session.projectId);
    if (!run) throw fail('Execution does not belong to this session.', 404);
    return run;
  };
  const savedArtifacts = (run) => data().artifacts.filter((artifact) => artifact.projectId === run.projectId
    && ((run.artifactIds || []).includes(artifact.id) || artifact.versions?.some((version) => version.runId === run.id)));
  const virtualPath = (file) => '/' + path.relative(store.dataRoot || store.root, file).split(path.sep).join('/');
  const artifactFile = (artifact, version) => {
    if (ctx.artifacts?.file) return ctx.artifacts.file(artifact.id, version.id);
    return store.managedPath(version.path, { mustExist: true });
  };
  const runRecord = (run) => ({
    id: run.id, exec_id: run.id, tool_use_id: run.referenceOrigin === 'user' ? `user-${run.id}` : run.id,
    frame_id: run.sessionId || null, root_frame_id: run.sessionId || null, project_id: run.projectId,
    kernel_id: run.kernelId, kernel_kind: 'analysis', language: run.language || 'python',
    conda_env: run.referenceEnvironment || run.language || 'python', source: run.code || '',
    origin: run.referenceOrigin || 'agent', agent_name: 'ChatGPT',
    cell_index: run.executionCount ?? data().runs.filter((item) => item.kernelId === run.kernelId).indexOf(run) + 1,
    executed_at: run.startedAt, started_at: run.startedAt, ended_at: run.endedAt || null,
    duration_ms: seconds(run.startedAt, run.endedAt) * 1000,
    exit_status: ['completed', 'success'].includes(run.status) ? 'ok' : run.status,
    exit_code: ['completed', 'success'].includes(run.status) ? 0 : terminal(run) ? 1 : null,
    error_lineno: null, stdout: outputText(run), stderr: outputText(run, 'stderr') || run.error || '',
    user_intervention: run.referenceIntervention || null,
    environment_snapshot: referenceEnvironmentSnapshot(run.environment, run.referenceEnvironment || run.language),
    files_written: savedArtifacts(run).flatMap((artifact) => (artifact.versions || [])
      .filter((version) => version.runId === run.id).map((version) => ({
        path: virtualPath(artifactFile(artifact, version)), size: version.size || 0,
        artifact_id: artifact.id, version_id: version.id, content_type: version.mime || artifact.mime || artifact.contentType || 'application/octet-stream',
      }))),
  });
  let lastMachineCpu;
  function machineInfo(kernels) {
    const cpus = os.cpus();
    const current = cpus.reduce((sum, cpu) => ({ idle: sum.idle + cpu.times.idle,
      total: sum.total + Object.values(cpu.times).reduce((a, b) => a + b, 0) }), { idle: 0, total: 0 });
    const elapsed = lastMachineCpu ? current.total - lastMachineCpu.total : 0;
    const percent = elapsed > 0 ? Math.max(0, Math.min(100, (1 - (current.idle - lastMachineCpu.idle) / elapsed) * 100)) : null;
    lastMachineCpu = current;
    let disk;
    try { disk = fs.statfsSync(store.dataRoot || store.root); } catch {}
    return { sampled_at: iso(), total_mem_bytes: os.totalmem(), avail_mem_bytes: os.freemem(),
      cores: os.availableParallelism?.() || cpus.length, host_cores: cpus.length, total_cpu_pct: percent,
      kernel_rss_bytes: kernels.reduce((sum, item) => sum + (item.rss_bytes || 0), 0),
      kernel_cpu_pct: kernels.reduce((sum, item) => sum + (item.cpu_pct || 0), 0),
      kernel_count: kernels.length, busy_count: kernels.filter((item) => item.busy).length,
      disk_total_bytes: disk ? Number(disk.blocks) * Number(disk.bsize) : null,
      disk_avail_bytes: disk ? Number(disk.bavail) * Number(disk.bsize) : null };
  }
  function kernelDTO(kernel) {
    const session = data().sessions.find((item) => item.id === kernel.sessionId);
    const project = data().projects.find((item) => item.id === kernel.projectId);
    const runs = data().runs.filter((item) => item.kernelId === kernel.id);
    const active = runs.find((item) => ACTIVE.has(item.status));
    const last = [...runs].reverse().find(terminal);
    const cell = active ? { tag: active.id, source: active.code || '', origin: active.referenceOrigin || 'agent',
      started_at: active.startedAt, human_description: null, tool_use_id: active.referenceOrigin === 'user' ? `user-${active.id}` : active.id } : null;
    return { kernel_id: kernel.id, frame_id: session?.id || kernel.id, root_frame_id: session?.id || kernel.id,
      project_id: kernel.projectId, session_title: session?.title || null, project_name: project?.name || null,
      delegate_name: null, agent_name: 'ChatGPT', environment: environmentName(kernel), language: kernel.language,
      busy: Boolean(active) || kernel.status === 'busy', starting: ['starting', 'restarting'].includes(kernel.status),
      status: kernel.status, pid_visible: Boolean(kernel.resources?.pid), pid: kernel.resources?.pid || null,
      rss_bytes: kernel.resources?.memoryBytes ?? null, cpu_pct: kernel.resources?.cpuPercent ?? null,
      execution_count: runs.length, cell_count: runs.length, current_cell_tag: active?.id || null,
      current_cell: cell, last_used: kernel.lastActivity || kernel.createdAt,
      last_description: null, last_cell: last ? { source: last.code || '', ended_at: last.endedAt || last.startedAt,
        origin: last.referenceOrigin || 'agent' } : null };
  }
  async function kernelStats(frameId) {
    if (frameId) findSession(frameId);
    const state = await getState();
    const allKernels = (state.kernels || []).map(kernelDTO);
    const kernels = allKernels.filter((kernel) => !frameId || kernel.frame_id === frameId);
    return { kernels, machine: machineInfo(allKernels), ...(frameId ? { root_frame_id: frameId } : {}) };
  }
  async function environments() {
    const result = await call('GET', '/api/environments');
    return Array.isArray(result) ? result : result.environments || [];
  }
  async function environmentStatus() {
    const list = await environments();
    return { environments: list.map((env) => ({ id: env.id, env_name: env.name || env.id,
      environment: env.id, language: env.language || 'python', agent_name: null,
      status: env.setupError ? 'failed' : 'ready', error: env.setupError || null,
      package_count: Array.isArray(env.packages) ? env.packages.length : null,
      started_at: env.createdAt || null, path: env.path, managed: Boolean(env.managed) })),
      conda_disabled_reason: null, conda_disabled_kind: null, conda_split_solve: null,
      manager: 'app-local Python venv and R library' };
  }
  async function resolveEnvironment(language, requested) {
    if (!requested || requested === language) return language === 'r' ? 'r-default' : 'default';
    const matches = (await environments()).filter((env) => env.id === requested || env.name === requested);
    if (matches.length !== 1 || (matches[0].language || 'python') !== language) throw fail('Requested environment is missing, ambiguous, or has a different language.', 404);
    return matches[0].id;
  }
  async function executeCell(frameId, body) {
    const session = findSession(frameId);
    allowedProject(session.projectId);
    if (!isObject(body) || typeof body.code !== 'string' || !body.code.trim()) throw fail('A nonempty code cell is required.');
    const language = String(body.language || 'python').toLowerCase();
    if (!['python', 'r'].includes(language)) throw fail('Only Python and R cells are supported.');
    const environmentId = await resolveEnvironment(language, body.environment || body.environmentId);
    const state = await getState();
    let kernel = (state.kernels || []).find((item) => item.sessionId === session.id && item.projectId === session.projectId
      && item.language === language && item.environmentId === environmentId && !['closed', 'dead'].includes(item.status));
    if (!kernel) kernel = await call('POST', '/api/kernels', { projectId: session.projectId, sessionId: session.id, language, environmentId });
    if (pendingUserCells.has(kernel.id)) throw fail('This kernel is already starting a cell.', 409);
    pendingUserCells.set(kernel.id, { code: body.code, environment: environmentName(kernel) });
    let run;
    try {
      run = await call('POST', `/api/kernels/${encode(kernel.id)}/execute`, { code: body.code,
        ...(body.timeout !== undefined ? { timeout: body.timeout } : {}) });
    } finally { pendingUserCells.delete(kernel.id); }
    const saved = data().runs.find((item) => item.id === run.id);
    if (saved) {
      saved.referenceOrigin = 'user'; saved.referenceEnvironment = environmentName(kernel); store.save();
      ctx.notify?.('reference/compute-start', { runId: saved.id });
      if (terminal(saved)) ctx.notify?.('reference/compute-done', { runId: saved.id });
    }
    return { ok: true, exec_id: run.id, tool_use_id: `user-${run.id}`, kernel_id: kernel.id };
  }
  async function interruptCell(frameId, execId) {
    const run = ownedRun(frameId, execId);
    if (terminal(run)) return { ok: true, exec_id: execId, dequeued: false, already_finished: true };
    await call('POST', `/api/kernels/${encode(run.kernelId)}/interrupt`, {});
    return { ok: true, exec_id: execId, dequeued: false };
  }

  router.get('/environments/status', async (_req, res) => res.json(await environmentStatus()));
  router.get('/environments/preflight', async (_req, res) => res.json({ status: 'not_run', overall_class: null,
    origins: [], message: 'Bundled local runtimes are used; no package-download network probe has been performed.' }));
  router.post('/environments/retry', () => unsupported('Automatic global environment retry; use an enabled project to create or install its environment'));
  router.get('/environments', async (_req, res) => res.json(await environments()));
  router.post('/environments', async (req, res) => {
    const projectId = req.body.projectId || req.body.project_id;
    allowedProject(projectId);
    res.json(await call('POST', '/api/environments', { projectId, name: req.body.name, language: req.body.language,
      ...(req.body.packages !== undefined ? { packages: req.body.packages } : {}) }));
  });
  router.post('/environments/install', async (req, res) => {
    const projectId = req.body.projectId || req.body.project_id;
    allowedProject(projectId);
    res.json(await call('POST', '/api/environments/install', { projectId, environmentId: req.body.environmentId,
      packages: req.body.packages, manager: req.body.manager }));
  });
  router.get('/environments/export', async (req, res) => res.json(await call('GET',
    `/api/environments/export?environmentId=${encode(req.query.environmentId || 'default')}`)));
  router.post('/system/refresh-kernels', async (_req, res) => res.json({ ok: true, ...(await kernelStats()) }));
  router.get('/kernels', async (_req, res) => res.json(await kernelStats()));
  router.get('/frames/:frameId/kernels', async (req, res) => res.json({ ...(await kernelStats(req.params.frameId)),
    has_history: data().runs.some((run) => run.sessionId === req.params.frameId) }));
  router.post('/frames/:frameId/kernel-exec', async (req, res) => res.json(await executeCell(req.params.frameId, req.body)));
  for (const route of ['/frames/:frameId/kernel-exec/:execId/interrupt', '/frames/:frameId/executions/:execId/interrupt']) {
    router.post(route, async (req, res) => res.json(await interruptCell(req.params.frameId, req.params.execId)));
  }
  router.post('/frames/:frameId/kernels/:kernelId/stop', async (req, res) => {
    const session = findSession(req.params.frameId);
    const kernel = (await getState()).kernels?.find((item) => item.id === req.params.kernelId
      && item.sessionId === session.id && item.projectId === session.projectId);
    if (!kernel) throw fail('Kernel does not belong to this session.', 404);
    if (!['interrupt', 'kill'].includes(req.body.mode)) throw fail('Stop mode must be interrupt or kill.');
    if (req.body.attach_only) unsupported('Attached remote kernel control');
    const active = data().runs.find((run) => run.kernelId === kernel.id && ACTIVE.has(run.status));
    if (active) { active.referenceIntervention = { mode: req.body.mode, reason: String(req.body.reason || '').slice(0, 500), at: iso() }; store.save(); }
    const result = req.body.mode === 'kill' ? await call('DELETE', `/api/kernels/${encode(kernel.id)}`)
      : await call('POST', `/api/kernels/${encode(kernel.id)}/interrupt`, {});
    res.json({ ok: true, kernel_id: kernel.id, mode: req.body.mode, result });
  });
  router.get('/frames/:frameId/execution-log', (req, res) => {
    const session = findSession(req.params.frameId);
    let runs = data().runs.filter((run) => run.sessionId === session.id && run.projectId === session.projectId);
    if (req.query.versionId) {
      const artifact = data().artifacts.find((item) => item.projectId === session.projectId && item.versions?.some((version) => version.id === req.query.versionId));
      const version = artifact?.versions.find((item) => item.id === req.query.versionId);
      if (!version) throw fail('Unknown artifact version in this project.', 404);
      runs = runs.filter((run) => run.id === version.runId);
    }
    const limit = req.query.limit === undefined ? 5000 : Number(req.query.limit);
    const offset = req.query.cursor === undefined ? 0 : Number(req.query.cursor);
    if (!Number.isInteger(limit) || limit < 1 || limit > 5000 || !Number.isInteger(offset) || offset < 0) throw fail('Invalid execution-log pagination.');
    res.json(runs.slice(offset, offset + limit).map(runRecord));
  });

  const providerName = (connection) => connection.type === 'ssh' ? `ssh:${connection.config?.host || connection.id}`
    : connection.type === 'model' ? `infer:${connection.id}` : `byoc:${connection.id}`;
  const connections = () => data().connections.filter((connection) => ['ssh', 'modal', 'model'].includes(connection.type));
  function connectionFor(name) {
    const connection = connections().find((item) => providerName(item) === name || item.id === name);
    if (!connection) throw fail('Unknown configured compute provider.', 404);
    return connection;
  }
  function providerDTO(connection) {
    return { name: providerName(connection), displayName: connection.name,
      family: connection.type === 'ssh' ? 'ssh' : connection.type === 'model' ? 'infer' : 'byoc',
      checked: connection.config?.referenceEnabled !== false, managed: null, managedFamily: null, managedForeign: false,
      available: connection.lastTest?.ok === true, reachable: connection.lastTest?.ok === true,
      status: connection.lastTest ? connection.lastTest.ok ? 'ready' : 'error' : 'unprobed',
      error: connection.lastTest?.error || null, errorSummary: connection.lastTest?.error || null,
      detailsMd: connection.config?.detailsMd || '', probedAt: connection.lastTest?.at || null,
      scratchRoot: null, scratchRootSource: null, home: null, dataRoots: [], maxConcurrentJobs: null,
      connectionId: connection.id, ...(connection.type === 'model' ? { inferConfig: { url: connection.config?.url || '', hosted: true } } : {}) };
  }
  router.get('/compute/providers', (_req, res) => res.json(connections().map(providerDTO)));
  router.get('/compute/providers/:name', (req, res) => res.json(providerDTO(connectionFor(req.params.name))));
  router.post('/compute/providers/:name/probe', async (req, res) => {
    const connection = connectionFor(req.params.name);
    const result = await call('POST', `/api/connections/${encode(connection.id)}/test`, {});
    res.json({ ...result, message: result.message || (result.ok ? 'Provider probe completed.' : result.error || 'Provider probe did not succeed.') });
  });
  router.patch('/compute/providers/:name', async (req, res) => {
    const connection = connectionFor(req.params.name);
    if (Object.keys(req.body).some((key) => !['name', 'detailsMd'].includes(key))) unsupported('Provider resource limits or arbitrary provider configuration from this screen');
    if (req.body.detailsMd !== undefined && (typeof req.body.detailsMd !== 'string' || req.body.detailsMd.length > 20000)) throw fail('Provider notes must be bounded text.');
    res.json(providerDTO(await call('PATCH', `/api/connections/${encode(connection.id)}`,
      { ...(req.body.detailsMd === undefined ? {} : { config: { ...connection.config, detailsMd: req.body.detailsMd } }) })));
  });
  router.delete('/compute/providers/:name', async (req, res) => {
    const connection = connectionFor(req.params.name);
    res.json(await call('DELETE', `/api/connections/${encode(connection.id)}`));
  });
  router.delete('/compute/inference-providers/:name', async (req, res) => {
    const connection = connectionFor(req.params.name);
    if (connection.type !== 'model') throw fail('This is not a model provider.');
    res.json(await call('DELETE', `/api/connections/${encode(connection.id)}`));
  });
  router.post('/compute/ssh-hosts', async (req, res) => {
    if (typeof req.body.alias !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(req.body.alias)) throw fail('Use a configured SSH alias.');
    const overrides = req.body.overrides || {};
    if (!isObject(overrides) || Object.entries(overrides).some(([key, value]) => key !== 'authMethod' || value !== 'publickey')) {
      unsupported('SSH password or per-host overrides; configure keys, user and port in your own SSH config');
    }
    const existing = connections().find((item) => item.type === 'ssh' && item.config?.host === req.body.alias);
    if (existing) return res.json(providerDTO(existing));
    const connection = await call('POST', '/api/connections', { name: req.body.alias, type: 'ssh',
      config: { host: req.body.alias, detailsMd: String(req.body.initialContext || '').slice(0, 20000), agentAccess: 'ask' } });
    res.json(providerDTO(connection));
  });
  router.get('/compute/ssh-config-aliases', (_req, res) => {
    const configPath = ctx.sshConfigPath || path.join(os.homedir(), '.ssh', 'config');
    const configFound = fs.existsSync(configPath);
    let aliases = [], wildcardCount = 0;
    if (configFound) {
      if (fs.statSync(configPath).size > 1024 * 1024) throw fail('SSH configuration is too large to list.', 413);
      for (const match of fs.readFileSync(configPath, 'utf8').matchAll(/^\s*Host\s+([^\r\n#]+)/gim)) {
        for (const alias of match[1].trim().split(/\s+/)) {
          if (/[*?!]/.test(alias)) wildcardCount += 1;
          else if (/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(alias)) aliases.push(alias);
        }
      }
    }
    res.json({ aliases: [...new Set(aliases)], configFound, configPath, wildcardCount, isWsl: false });
  });
  router.get('/compute/session/:frameId/enabled', (req, res) => {
    const session = findSession(req.params.frameId);
    const available = connections().map(providerName);
    res.json((session.referenceComputeProviders || available).filter((name) => available.includes(name)));
  });
  router.put('/compute/session/:frameId/enabled/:name', (req, res) => {
    const session = findSession(req.params.frameId); connectionFor(req.params.name);
    if (typeof req.body.checked !== 'boolean') throw fail('checked must be a boolean.');
    const enabled = new Set(session.referenceComputeProviders || connections().map(providerName));
    if (req.body.checked) enabled.add(req.params.name); else enabled.delete(req.params.name);
    mutate(() => { session.referenceComputeProviders = [...enabled]; });
    res.json([...enabled]);
  });
  router.post('/compute/session/migrate', () => unsupported('Session provider migration'));
  router.get('/compute/managed-endpoints', (_req, res) => res.json([]));
  for (const route of ['/compute/providers/:name/data-roots', '/compute/providers/:name/scratch-root',
    '/compute/gpu/enabled', '/compute/bionemo/enabled', '/compute/byoc/:provider/enabled']) router.put(route, () => unsupported('Managed remote/GPU configuration'));
  router.post('/compute/managed-endpoints/:name/stop', () => unsupported('Managed inference endpoint lifecycle'));
  for (const route of ['/compute/gpu', '/compute/gpu/detect', '/compute/byoc/:provider']) router.get(route, () => unsupported('GPU/BYOC discovery'));
  for (const route of ['/compute/gpu/enabled', '/compute/bionemo/enabled']) router.get(route, (_req, res) => res.json({ enabled: false,
    unavailableReason: 'Automatic GPU provisioning is not implemented; configured SSH/Modal jobs use your own provider.' }));
  for (const route of ['/compute/providers/:name/files', '/compute/providers/:name/download']) router.get(route, () => unsupported('Remote filesystem browsing'));
  router.post('/compute/providers/:name/import', () => unsupported('Remote filesystem import'));

  function jobDTO(job) {
    const connection = data().connections.find((item) => item.id === job.connectionId);
    const metadata = data().referenceJobMetadata?.[job.id] || {};
    const state = ({ completed: 'done', cancelled: 'failed', unknown: 'orphaned', submitting: 'queued', submitted: 'queued' })[job.status] || job.status;
    const stdout = job.stdout || '', stderr = job.stderr || '';
    return { jobId: job.id, projectId: job.projectId, rootFrameId: job.sessionId || metadata.sessionId || null,
      frameId: job.sessionId || metadata.sessionId || null, state, environment: job.scheduler || job.provider,
      providerLabel: connection?.name || job.host || job.provider, providerFamily: job.provider === 'ssh' ? 'ssh' : 'byoc',
      providerName: connection ? providerName(connection) : job.connectionId, intent: metadata.intent || '',
      startedAtIso: job.createdAt, endedAtIso: job.endedAt || null, externalId: job.remoteId || null,
      hardwareDetails: null, tierType: null, supportsTail: false, errorKind: job.error ? 'execution_failed' : null,
      systemHint: job.error || null, leftOnRemote: [], exitCode: job.exitCode ?? null,
      harvest: { stdout: { exists: Boolean(stdout), size: Buffer.byteLength(stdout) }, stderr: { exists: Boolean(stderr), size: Buffer.byteLength(stderr) } } };
  }
  router.get('/compute/jobs', async (req, res) => {
    if (req.query.projectId) findProject(req.query.projectId);
    const jobs = await call('GET', '/api/jobs');
    res.json({ jobs: jobs.filter((job) => (!req.query.projectId || job.projectId === req.query.projectId) && ACTIVE.has(job.status)
      || (!req.query.projectId || job.projectId === req.query.projectId) && ['submitted', 'submitting', 'unknown'].includes(job.status)).map(jobDTO) });
  });
  router.post('/compute/jobs', async (req, res) => {
    const session = req.body.frameId || req.body.rootFrameId ? findSession(req.body.frameId || req.body.rootFrameId) : null;
    const projectId = session?.projectId || req.body.projectId;
    allowedProject(projectId);
    if (session && req.body.projectId && req.body.projectId !== projectId) throw fail('Job project and session do not match.');
    const connection = connectionFor(req.body.provider || req.body.connectionId);
    if (session?.referenceComputeProviders && !session.referenceComputeProviders.includes(providerName(connection))) {
      throw fail('This compute provider is disabled for the session.', 403);
    }
    const job = await call('POST', '/api/jobs', { projectId, connectionId: connection.id, script: req.body.script,
      scheduler: req.body.scheduler, timeoutSeconds: req.body.timeoutSeconds });
    if (session || req.body.intent) mutate((state) => {
      state.referenceJobMetadata ||= {};
      state.referenceJobMetadata[job.id] = { sessionId: session?.id || null, intent: String(req.body.intent || '').slice(0, 1000) };
    }, 'job/submitted');
    res.json(jobDTO(job));
  });
  router.get('/compute/jobs/:id', async (req, res) => res.json(jobDTO(await call('GET', `/api/jobs/${encode(req.params.id)}`))));
  router.post('/compute/jobs/:id/cancel', async (req, res) => res.json(jobDTO(await call('POST', `/api/jobs/${encode(req.params.id)}/cancel`, {}))));
  router.get('/compute/jobs/:id/logs', async (req, res) => {
    const stream = req.query.stream || 'stdout';
    if (!['stdout', 'stderr'].includes(stream)) throw fail('Log stream must be stdout or stderr.');
    const job = await call('GET', `/api/jobs/${encode(req.params.id)}`);
    let text = job[stream] || '';
    const size = Buffer.byteLength(text);
    const tail = req.query.tail === undefined ? null : Number(req.query.tail);
    if (tail !== null && (!Number.isInteger(tail) || tail < 1 || tail > 128 * 1024)) throw fail('Invalid log tail size.');
    if (tail !== null) text = text.slice(-tail);
    res.json({ text, content: text, size, exists: Boolean(size), truncated: tail !== null && text.length < (job[stream] || '').length,
      complete: ['completed', 'failed', 'cancelled', 'timed_out'].includes(job.status) });
  });

  function managedFile(input, required = true) {
    let value = input || '.';
    if (typeof value !== 'string' || value.includes('\0')) throw fail('Invalid local file path.');
    // The copied browser uses POSIX-looking virtual paths. Map these exclusively
    // into this application's owned data directory, never the OS filesystem root.
    if (value.startsWith('/') && !value.startsWith('//')) value = value.slice(1) || '.';
    try { return store.managedPath(value, { mustExist: required }); }
    catch (error) { throw fail(`Outside managed project storage: ${error.message}`, 403); }
  }
  function artifactDTO(artifact, versionId) {
    const version = artifact.versions?.find((item) => item.id === versionId) || artifact.versions?.at(-1);
    return { ...artifact, id: artifact.id, artifact_id: artifact.id, version_id: version?.id || null,
      project_id: artifact.projectId, root_frame_id: artifact.sessionId || null, filename: artifact.name,
      content_type: version?.mime || artifact.mime || artifact.contentType || 'application/octet-stream', size_bytes: version?.size || 0,
      created_at: version?.createdAt || artifact.createdAt, is_user_upload: true };
  }
  router.get('/compute/local/hostinfo', (_req, res) => res.json({ hostLabel: os.hostname(), hostDetail: `${os.platform()} · managed research files`,
    root: '/', executionMode: 'host', sandboxed: false }));
  router.get('/compute/local/files', (req, res) => {
    const directory = managedFile(req.query.path);
    if (!fs.statSync(directory).isDirectory()) throw fail('Path is not a directory.');
    const all = fs.readdirSync(directory, { withFileTypes: true });
    const entries = [];
    for (const item of all) {
      if (item.isSymbolicLink() || item.name === 'store.json' || item.name.startsWith('.store-')) continue;
      const file = store.managedPath(path.join(directory, item.name), { mustExist: true });
      const stat = fs.statSync(file);
      entries.push({ name: item.name, isDirectory: stat.isDirectory(), size: stat.size, mtime: stat.mtimeMs });
      if (entries.length >= 1000) break;
    }
    res.json({ entries, truncated: all.length > 1000, roots: { home: '/', scratch: '/projects' }, resolvedPath: virtualPath(directory) || '/' });
  });
  router.get('/compute/local/download', (req, res) => {
    const file = managedFile(req.query.path);
    if (!fs.statSync(file).isFile()) throw fail('Path is not a file.');
    res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.query.disposition === 'inline') res.sendFile(file); else res.download(file, path.basename(file));
  });
  router.post('/compute/local/import', async (req, res) => {
    findProject(req.body.projectId);
    const file = managedFile(req.body.path), stat = fs.statSync(file);
    if (!stat.isFile()) throw fail('Only files can be imported.');
    if (stat.size > 50 * 1024 * 1024) throw fail('File exceeds the 50 MiB browser import limit.', 413);
    const artifact = await ctx.artifacts.importFile({ projectId: req.body.projectId, filePath: file, name: path.basename(file), source: 'local-import' });
    ctx.notify?.('artifact/created', { artifactId: artifact.id, projectId: artifact.projectId });
    res.json(artifactDTO(artifact));
  });
  router.get('/files/ref-artifact', (req, res) => {
    if (req.query.host !== 'local') unsupported('Remote file-to-artifact lookup');
    findProject(req.query.projectId);
    const file = managedFile(req.query.path);
    for (const artifact of data().artifacts.filter((item) => item.projectId === req.query.projectId)) {
      for (const version of artifact.versions || []) if (path.resolve(artifactFile(artifact, version)) === path.resolve(file)) return res.json(artifactDTO(artifact, version.id));
    }
    res.json(null);
  });

  const streamed = new Map();
  async function mapEvent(event) {
    if (event.type?.startsWith('kernel/')) {
      const stats = await kernelStats();
      // Include sessions whose last kernel was just closed, so clients clear it.
      const frames = new Set([...data().sessions.map((session) => session.id), ...stats.kernels.map((kernel) => kernel.root_frame_id)]);
      return [...frames].map((frameId) => ({ type: 'kernel_stats', root_frame_id: frameId,
        kernels: stats.kernels.filter((kernel) => kernel.root_frame_id === frameId), machine: stats.machine }));
    }
    const run = event.runId && data().runs.find((item) => item.id === event.runId);
    if (!run?.sessionId) return [];
    // The owned API emits run/started before returning its HTTP response. Stamp
    // terminal cells here too, so that first event uses the same identity as its
    // eventual acknowledgement and completion instead of creating a second cell.
    const pending = pendingUserCells.get(run.kernelId);
    if (pending?.code === run.code) {
      run.referenceOrigin = 'user'; run.referenceEnvironment = pending.environment;
    }
    const base = { root_frame_id: run.sessionId, frame_id: run.sessionId,
      tool_use_id: run.referenceOrigin === 'user' ? `user-${run.id}` : run.id, origin: run.referenceOrigin || 'agent',
      language: run.language || 'python', environment: run.referenceEnvironment || run.language || 'python', kernel_target: 'analysis' };
    if (['run/started', 'reference/compute-start'].includes(event.type)) return [{ type: 'execution_cell_update', ...base,
      phase: 'start', source: run.code || '', started_at: run.startedAt }];
    if (event.type === 'run/output') {
      const outputs = run.outputs || [], previous = streamed.get(run.id) || 0;
      streamed.set(run.id, outputs.length);
      const text = outputText({ outputs: outputs.slice(previous) });
      return text ? [{ type: 'tool_stdout_chunk', ...base, data: text }] : [];
    }
    if (['run/completed', 'reference/compute-done'].includes(event.type)) {
      streamed.delete(run.id);
      return [{ type: 'execution_cell_update', ...base, phase: 'done', cell_id: run.id,
        exit_code: ['completed', 'success'].includes(run.status) ? 0 : 1,
        stdout: outputText(run), stderr: outputText(run, 'stderr') || run.error || '',
        cancelled: ['interrupted', 'cancelled'].includes(run.status), duration_ms: seconds(run.startedAt, run.endedAt) * 1000,
        user_intervention: run.referenceIntervention || null }];
    }
    return [];
  }
  return { executeCell, interruptCell, kernelStats, mapEvent, runRecord, environmentStatus };
}
