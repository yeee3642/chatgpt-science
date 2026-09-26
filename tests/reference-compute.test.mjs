import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import express from 'express';
import { startServer } from '../server/index.mjs';
import { defaultPythonPath } from '../server/kernel-client.mjs';
import { mountReferenceCompute, referenceEnvironmentSnapshot } from '../server/reference-compute.mjs';

const workspaceWork = fileURLToPath(new URL('../../../work/', import.meta.url));
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
class UnusedModelBridge extends EventEmitter { async close() {} }

async function fixture(t, options = {}) {
  fs.mkdirSync(workspaceWork, { recursive: true });
  const root = fs.mkdtempSync(path.join(workspaceWork, 'reference-compute-test-'));
  const service = await startServer({ dataRoot: root, initialize: false, referenceUi: false,
    pythonPath: defaultPythonPath(), bridgeFactory: () => new UnusedModelBridge(), ...options });
  const calls = [], notifications = [];
  const call = async (method, route, body) => {
    calls.push({ method, route, body });
    const response = await fetch(service.origin + route, { method,
      headers: { Cookie: 'science_session=' + service.token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json();
    if (!response.ok) throw Object.assign(new Error(result.error), { status: response.status });
    return result;
  };
  const app = express(); app.use(express.json());
  const ctx = { store: service.store, artifacts: service.artifacts, call,
    sshConfigPath: path.join(root, 'ssh-config'), notify: (type, body) => notifications.push({ type, ...body }) };
  const adapter = mountReferenceCompute(app, ctx);
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }));
  const server = await new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
  const origin = 'http://127.0.0.1:' + server.address().port;
  const request = (route, body, method = body === undefined ? 'GET' : 'POST') => fetch(origin + route, { method,
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
  const json = async (route, body, method) => {
    const response = await request(route, body, method); const result = await response.json();
    assert.ok(response.ok, `${route}: ${JSON.stringify(result)}`); return result;
  };
  t.after(async () => {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections?.(); });
    await service.close();
    const relative = path.relative(workspaceWork, root);
    assert.ok(!relative.startsWith('..') && !path.isAbsolute(relative) && path.basename(root).startsWith('reference-compute-test-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const project = await call('POST', '/api/projects', { name: 'Reference compute evidence' });
  const session = await call('POST', '/api/sessions', { projectId: project.id, title: 'Real kernel terminal' });
  const waitRun = async id => {
    const expires = Date.now() + 30000;
    while (Date.now() < expires) {
      const run = await call('GET', '/api/runs/' + id);
      if (!['running', 'queued', 'starting', 'cancelling'].includes(run.status)) return run;
      await delay(60);
    }
    assert.fail('Run did not finish: ' + id);
  };
  return { service, root, calls, notifications, adapter, ctx, call, request, json, project, session, waitRun };
}

test('reference environment DTO exposes measured versions without claiming a sandbox', () => {
  assert.deepEqual(referenceEnvironmentSnapshot({ python: '3.12.13 bundled', language: 'python',
    packages: { numpy: '2.4.3' }, capturedAt: '2026-09-20T00:00:00Z' }, 'Python'), {
    environment_name: 'Python', python_version: '3.12.13', r_version: null, language: 'python',
    packages: [{ name: 'numpy', version: '2.4.3' }], captured_at: '2026-09-20T00:00:00Z', execution_mode: 'host', sandboxed: false,
  });
});

test('reference terminal executes persistent real Python and R, records evidence, and controls only its session kernels', { timeout: 120000 }, async t => {
  const f = await fixture(t);
  const endpoint = `/frames/${f.session.id}/kernel-exec`;
  const denied = await f.request(endpoint, { language: 'python', code: 'print(42)' });
  assert.equal(denied.status, 403);
  assert.equal(f.calls.filter(item => item.route === '/api/kernels').length, 0);
  await f.call('PATCH', '/api/projects/' + f.project.id, { allowHostExecution: true });

  const environments = await f.json('/environments/status');
  assert.ok(environments.environments.some(env => env.id === 'default' && env.language === 'python' && env.status === 'ready'));
  assert.ok(environments.environments.some(env => env.id === 'r-default' && env.language === 'r' && env.status === 'ready'));
  const preflight = await f.json('/environments/preflight');
  assert.equal(preflight.status, 'not_run');

  const first = await f.json(endpoint, { language: 'python', environment: 'python', code: 'reference_value = 40\nprint("reference-setup")' });
  assert.equal(first.ok, true); assert.equal(first.tool_use_id, 'user-' + first.exec_id);
  assert.equal((await f.waitRun(first.exec_id)).status, 'completed');
  const second = await f.json(endpoint, { language: 'python', environment: 'Scientific Python', code: 'print(reference_value + 2)' });
  assert.equal(second.kernel_id, first.kernel_id);
  assert.equal((await f.waitRun(second.exec_id)).status, 'completed');

  const r = await f.json(endpoint, { language: 'r', environment: 'r', code: 'reference_value <- 6 * 7\nprint(reference_value)\noptions(jupyter.plot_mimetypes = c("image/png")); plot(c(1, 2, 3), c(3, 1, 4))' });
  const rRun = await f.waitRun(r.exec_id);
  assert.equal(rRun.status, 'completed');
  assert.ok(rRun.outputs.some(output => output.data?.['image/png']));
  const rAgain = await f.json(endpoint, { language: 'r', code: 'print(reference_value + 1)' });
  assert.equal(rAgain.kernel_id, r.kernel_id);
  assert.equal((await f.waitRun(rAgain.exec_id)).status, 'completed');

  const history = await f.json(`/frames/${f.session.id}/execution-log`);
  assert.equal(history.length, 4);
  assert.match(history.find(run => run.id === second.exec_id).stdout, /42/);
  assert.match(history.find(run => run.id === rAgain.exec_id).stdout, /43/);
  assert.ok(history.every(run => run.origin === 'user' && run.exit_status === 'ok' && run.agent_name === 'ChatGPT'));
  const rRecord = history.find(run => run.id === r.exec_id);
  assert.match(rRecord.environment_snapshot.r_version, /R version/);
  assert.ok(rRecord.files_written.length >= 1);
  assert.equal(rRecord.files_written[0].content_type, 'image/png');
  const savedVersion = rRecord.files_written[0].version_id;
  assert.deepEqual((await f.json(`/frames/${f.session.id}/execution-log?versionId=${savedVersion}`)).map(run => run.id), [r.exec_id]);
  assert.equal((await f.request(`/frames/${f.session.id}/execution-log?limit=-1`)).status, 400);
  assert.equal((await f.request(`/frames/${f.session.id}/execution-log?versionId=absent`)).status, 404);
  const projected = await f.adapter.mapEvent({ type: 'run/completed', runId: r.exec_id });
  assert.equal(projected[0].tool_use_id, 'user-' + r.exec_id);
  assert.equal(projected[0].exit_code, 0); assert.match(projected[0].stdout, /42/);

  const stats = await f.json(`/frames/${f.session.id}/kernels`);
  assert.equal(stats.kernels.length, 2); assert.equal(stats.has_history, true);
  assert.ok(stats.machine.total_mem_bytes > 0); assert.ok(stats.machine.disk_total_bytes > 0);
  assert.ok(stats.kernels.every(kernel => kernel.root_frame_id === f.session.id));
  const pythonEnvironment = await f.json('/environments/export?environmentId=default');
  const rEnvironment = await f.json('/environments/export?environmentId=r-default');
  assert.match(pythonEnvironment.requirements, /ipykernel==/i); assert.match(rEnvironment.requirements, /IRkernel==/);

  const other = await f.call('POST', '/api/sessions', { projectId: f.project.id });
  assert.equal((await f.request(`/frames/${other.id}/kernels/${first.kernel_id}/stop`, { mode: 'kill' })).status, 404);
  assert.equal((await f.request(`/frames/${other.id}/kernel-exec/${first.exec_id}/interrupt`, {})).status, 404);
  assert.equal((await f.request(endpoint, { language: 'python', environment: 'r-default', code: 'print(1)' })).status, 404);
  const running = await f.json(endpoint, { language: 'python', code: 'import time\nprint("waiting", flush=True)\ntime.sleep(30)' });
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const run = await f.call('GET', '/api/runs/' + running.exec_id);
    if (JSON.stringify(run.outputs).includes('waiting')) break;
    await delay(50);
  }
  const stopped = await f.json(`/frames/${f.session.id}/kernels/${first.kernel_id}/stop`, { mode: 'interrupt', reason: 'test-owned-kernel' });
  assert.equal(stopped.ok, true);
  const stoppedRun = await f.waitRun(running.exec_id);
  assert.equal(stoppedRun.status, 'interrupted');
  assert.equal(stoppedRun.referenceIntervention.reason, 'test-owned-kernel');
  for (const id of [first.kernel_id, r.kernel_id]) await f.json(`/frames/${f.session.id}/kernels/${id}/stop`, { mode: 'kill' });
  assert.deepEqual((await f.json(`/frames/${f.session.id}/kernels`)).kernels, []);
  const removed = await f.adapter.mapEvent({ type: 'kernel/closed' });
  assert.ok(removed.some(event => event.root_frame_id === f.session.id && event.kernels.length === 0));
  assert.equal((await f.json(`/frames/${f.session.id}/execution-log`)).length, 5);
});

test('reference file browser confines downloads and imports to managed files and preserves the original bytes', async t => {
  const f = await fixture(t);
  const file = path.join(f.service.store.projectRoot(f.project.id), 'evidence.csv');
  fs.writeFileSync(file, 'metric,value\naccuracy,0.875\n');
  const virtual = '/' + path.relative(f.root, file).split(path.sep).join('/');
  const listing = await f.json('/compute/local/files?path=' + encodeURIComponent(virtual.slice(0, virtual.lastIndexOf('/'))));
  assert.ok(listing.entries.some(entry => entry.name === 'evidence.csv' && !entry.isDirectory));
  const download = await f.request('/compute/local/download?path=' + encodeURIComponent(virtual));
  assert.equal(download.status, 200); assert.equal(await download.text(), fs.readFileSync(file, 'utf8'));
  assert.match(download.headers.get('content-security-policy'), /^sandbox;/);
  assert.equal(download.headers.get('x-content-type-options'), 'nosniff');
  const imported = await f.json('/compute/local/import', { projectId: f.project.id, path: virtual });
  assert.equal(imported.project_id, f.project.id); assert.equal(imported.filename, 'evidence.csv');
  assert.equal(imported.content_type, 'text/csv');
  const artifact = f.service.store.data.artifacts.find(item => item.id === imported.id);
  assert.equal(fs.readFileSync(f.service.artifacts.file(artifact.id), 'utf8'), fs.readFileSync(file, 'utf8'));
  const artifactPath = '/' + path.relative(f.root, f.service.artifacts.file(artifact.id)).split(path.sep).join('/');
  const lookup = await f.json(`/files/ref-artifact?host=local&projectId=${f.project.id}&path=${encodeURIComponent(artifactPath)}`);
  assert.equal(lookup.id, artifact.id);
  assert.equal((await f.request('/compute/local/download?path=' + encodeURIComponent('../outside.txt'))).status, 403);
  assert.equal((await f.request('/compute/local/files?path=' + encodeURIComponent(path.dirname(f.root)))).status, 403);
  assert.equal((await f.request('/compute/local/import', { projectId: 'absent', path: virtual })).status, 404);
  assert.ok(f.notifications.some(event => event.type === 'artifact/created' && event.artifactId === imported.id));
});

test('reference provider controls persist actual own connections and reject unsupported configuration', async t => {
  const f = await fixture(t);
  fs.writeFileSync(f.ctx.sshConfigPath, 'Host research-node research-alias\n  HostName 127.0.0.1\nHost *.example !skip\nHost research-node\n');
  assert.deepEqual((await f.json('/compute/ssh-config-aliases')).aliases, ['research-node', 'research-alias']);
  const provider = await f.json('/compute/ssh-hosts', { alias: 'research-node', overrides: { authMethod: 'publickey' }, initialContext: 'Test connection; never contacted.' });
  assert.equal(provider.name, 'ssh:research-node'); assert.equal(provider.status, 'unprobed'); assert.equal(provider.available, false);
  assert.equal((await f.json('/compute/providers')).length, 1);
  await f.json('/compute/providers/' + encodeURIComponent(provider.name), { name: provider.name, detailsMd: 'Updated instructions' }, 'PATCH');
  assert.equal((await f.json('/compute/providers/' + encodeURIComponent(provider.name))).detailsMd, 'Updated instructions');
  assert.deepEqual(await f.json(`/compute/session/${f.session.id}/enabled`), [provider.name]);
  await f.json(`/compute/session/${f.session.id}/enabled/${encodeURIComponent(provider.name)}`, { checked: false }, 'PUT');
  assert.deepEqual(await f.json(`/compute/session/${f.session.id}/enabled`), []);
  await f.call('PATCH', '/api/projects/' + f.project.id, { allowHostExecution: true });
  assert.equal((await f.request('/compute/jobs', { frameId: f.session.id, provider: provider.name, script: 'true' })).status, 403);
  assert.equal((await f.request('/compute/ssh-hosts', { alias: 'other', overrides: { password: 'not-used' } })).status, 501);
  assert.equal((await f.request('/compute/providers/' + encodeURIComponent(provider.name), { maxConcurrentJobs: 12 }, 'PATCH')).status, 501);
  await f.json('/compute/providers/' + encodeURIComponent(provider.name), undefined, 'DELETE');
  assert.deepEqual(await f.json('/compute/providers'), []);
  assert.equal(f.calls.filter(item => /\/test$|\/api\/jobs/.test(item.route)).length, 0);
});

test('reference execution events keep one cell identity when startup beats the HTTP acknowledgement', async () => {
  const routes = new Map(), router = Object.fromEntries(['get','post','put','patch','delete'].map(method => [method, (route, handler) => routes.set(method + ' ' + route, handler)]));
  const data = { projects: [{ id: 'p', allowHostExecution: true }], sessions: [{ id: 's', projectId: 'p' }], runs: [], artifacts: [] };
  let adapter, firstEvent;
  const kernel = { id: 'k', projectId: 'p', sessionId: 's', language: 'python', environmentId: 'default' };
  const ctx = { store: { data, save() {} }, async call(method, route, body) {
    if (route === '/api/state') return { kernels: [kernel] };
    if (route.endsWith('/execute')) {
      const run = { id: 'run', kernelId: 'k', sessionId: 's', projectId: 'p', language: 'python', code: body.code, status: 'running', startedAt: new Date().toISOString() };
      data.runs.push(run);
      firstEvent = await adapter.mapEvent({ type: 'run/started', runId: run.id });
      return run;
    }
    throw new Error('Unexpected route: ' + method + ' ' + route);
  } };
  adapter = mountReferenceCompute(router, ctx);
  const acknowledgement = await adapter.executeCell('s', { code: 'print(42)' });
  assert.equal(firstEvent[0].tool_use_id, acknowledgement.tool_use_id);
  assert.equal(firstEvent[0].origin, 'user');
  assert.equal(firstEvent[0].source, 'print(42)');
});
