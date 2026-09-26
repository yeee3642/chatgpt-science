/** Manual, opt-in service verification. Uses the signed-in ChatGPT account once.
 * Not part of npm test. Creates only an isolated fixture and its evidence files.
 * Run: node scripts/verify-live.mjs --run-live --work-root <scratch-directory>
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';
import { startServer } from '../server/index.mjs';

const args = process.argv.slice(2);
if (!args.includes('--run-live')) {
  console.error('This verification uses the signed-in ChatGPT account. Run explicitly with --run-live.');
  process.exitCode = 2;
} else {
  await verify();
}

async function verify() {
  const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const workIndex = args.indexOf('--work-root');
  const workRoot = path.resolve(workIndex >= 0 ? args[workIndex + 1] : path.join(appRoot, '..', '..', 'work'));
  await fs.mkdir(workRoot, { recursive: true });
  const fixtureRoot = await fs.mkdtemp(path.join(workRoot, 'science-service-live-'));
  const evidencePath = path.join(fixtureRoot, 'evidence.json');
  const report = { startedAt: new Date().toISOString(), passed: false, fixtureRoot, checks: {}, timeline: [] };
  const startedAt = performance.now();
  let service, cookie, sessionId;
  let generationDeadline = null;

  async function api(endpoint, { method = 'GET', body, bytes = false } = {}) {
    const remaining = generationDeadline ? Math.max(1, generationDeadline - performance.now()) : 15000;
    const response = await fetch(service.origin + '/api' + endpoint, {
      method, headers: { Cookie: cookie, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(Math.min(15000, Math.ceil(remaining))),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(`API ${method} ${endpoint.split('?')[0]} failed (${response.status}): ${error.error || 'request rejected'}`);
    }
    return bytes ? Buffer.from(await response.arrayBuffer()) : response.json();
  }

  try {
    service = await startServer({ dataRoot: path.join(fixtureRoot, 'data'), port: 0 });
    const bootstrap = await fetch(service.launchUrl, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
    assert.equal(bootstrap.status, 302, 'Local bootstrap must authenticate the fixture session.');
    cookie = bootstrap.headers.get('set-cookie')?.split(';')[0];
    assert.ok(cookie?.startsWith('science_session='), 'Bootstrap did not issue the expected local session cookie.');
    report.checks.localSession = 'authenticated';

    const readinessDeadline = performance.now() + 45000;
    let state;
    while (performance.now() < readinessDeadline) {
      state = await api('/state');
      if (state.account?.authenticated && state.capabilities?.codex && state.capabilities?.python?.available) break;
      if (state.account?.status === 'unavailable') throw new Error('Managed ChatGPT readiness failed: ' + (state.account.error || 'account unavailable'));
      await pause(500);
    }
    assert.equal(state.account?.account?.type, 'chatgpt', 'Verification requires genuine managed ChatGPT authentication.');
    assert.equal(state.account?.authenticated, true);
    assert.equal(state.capabilities?.codex, true);
    assert.equal(state.capabilities?.python?.available, true, 'Scientific Python runtime did not become ready.');
    report.checks.account = { type: 'chatgpt', authenticated: true };
    report.checks.pythonAvailable = true;

    const project = await api('/projects', { method: 'POST', body: { name: 'Live verification: square sum', description: 'Disposable verification fixture. Use only local arithmetic and versioned artifact tools.' } });
    await api('/projects/' + project.id, { method: 'PATCH', body: { allowHostExecution: true } });
    const session = await api('/sessions', { method: 'POST', body: { projectId: project.id, title: 'Verify Python output and artifact provenance' } });
    sessionId = session.id; report.projectId = project.id; report.sessionId = session.id;
    const prompt = [
      'This is a bounded service integration test inside this isolated project.',
      'Make exactly two science tool calls, in this order, and no other tool calls:',
      '1. Call science_execute once with language "python", code "print(sum(i*i for i in range(1, 6)))", and timeout 30.',
      '2. After receiving the actual completed run, call science_save_document once with name "result.md", runId equal to that returned run ID, and Markdown text stating the actual printed result and the same run ID.',
      'Do not guess the result, inspect files, call connectors, search the web, or perform other computations. Finish with a brief success message after the save succeeds.',
    ].join('\n');
    generationDeadline = performance.now() + 120000;
    const sentAt = performance.now();
    await api('/sessions/' + session.id + '/message', { method: 'POST', body: { text: prompt } });
    let completed;
    let lastState = '';
    while (performance.now() < generationDeadline) {
      completed = await api('/sessions/' + session.id);
      if (completed.status !== lastState) { lastState = completed.status; report.timeline.push({ elapsedMs: Math.round(performance.now() - sentAt), status: lastState }); }
      if (completed.status === 'completed') break;
      if (['failed', 'error', 'interrupted', 'unknown'].includes(completed.status)) throw new Error('Research session did not complete: ' + (completed.error || completed.status));
      await pause(500);
    }
    assert.equal(completed?.status, 'completed', 'Research session exceeded the 120-second verification bound.');
    report.generationElapsedMs = Math.round(performance.now() - sentAt);
    generationDeadline = null;
    state = await api('/state');
    const runs = state.runs.filter(run => run.projectId === project.id);
    assert.equal(runs.length, 1, 'Expected exactly one recorded execution.');
    const run = await api('/runs/' + runs[0].id);
    assert.equal(run.status, 'completed');
    const stdout = run.outputs.filter(output => output.type === 'stream').map(output => output.text || '').join('').trim();
    assert.equal(stdout, '55', 'The actual Python output must be 55.');
    assert.equal(run.code.replace(/\s/g, ''), 'print(sum(i*iforiinrange(1,6)))');
    const fixtureArtifacts = state.artifacts.filter(artifact => artifact.projectId === project.id);
    assert.equal(fixtureArtifacts.length, 1, 'Expected exactly one saved artifact.');
    const artifact = await api('/artifacts/' + fixtureArtifacts[0].id);
    assert.equal(artifact.name, 'result.md');
    const version = artifact.versions.find(item => item.id === artifact.currentVersionId);
    assert.ok(version, 'Artifact must have a stored current version.');
    assert.equal(version.runId, run.id, 'Artifact provenance must point to the actual execution.');
    assert.equal(version.source, 'agent');
    const content = await api('/artifacts/' + artifact.id + '/content?version=' + version.id);
    const bytes = await api('/artifacts/' + artifact.id + '/file?version=' + version.id + '&download=1', { bytes: true });
    assert.match(content.text || '', /\b55\b/);
    assert.ok(content.text.includes(run.id), 'Document must identify its source run.');
    assert.equal(bytes.toString('utf8'), content.text);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), version.hash, 'Stored artifact hash must match actual downloaded bytes.');
    assert.ok(run.artifactIds.includes(artifact.id), 'Execution must link back to its artifact.');
    const toolCalls = completed.activity.filter(item => item.type === 'dynamicToolCall');
    assert.deepEqual(toolCalls.map(item => item.tool), ['science_execute', 'science_save_document']);
    assert.equal(completed.activity.some(item => ['commandExecution', 'mcpToolCall', 'webSearch', 'collabToolCall'].includes(item.type)), false);
    report.checks.sessionStatus = completed.status;
    report.checks.tools = toolCalls.map(({ id, tool, status }) => ({ id, tool, status }));
    report.checks.run = { id: run.id, language: run.language, status: run.status, code: run.code, stdout, startedAt: run.startedAt, endedAt: run.endedAt };
    report.checks.artifact = { id: artifact.id, name: artifact.name, versionId: version.id, runId: version.runId, source: version.source, sha256: version.hash, bytes: bytes.length, text: content.text };
    report.checks.nativeToolCalls = 0;
    report.passed = true;
  } catch (error) {
    report.error = { name: error.name, message: error.message };
    process.exitCode = 1;
  } finally {
    generationDeadline = null;
    if (!report.passed && service && cookie && sessionId) await api('/sessions/' + sessionId + '/interrupt', { method: 'POST', body: {} }).catch(() => {});
    if (service) {
      try { await service.close(); report.cleanup = { ownedServiceClosed: true }; }
      catch (error) { report.cleanup = { ownedServiceClosed: false, error: error.message }; report.passed = false; process.exitCode = 1; }
    }
    report.endedAt = new Date().toISOString(); report.elapsedMs = Math.round(performance.now() - startedAt);
    await fs.writeFile(evidencePath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    console.log(JSON.stringify({ passed: report.passed, elapsedMs: report.elapsedMs, generationElapsedMs: report.generationElapsedMs, toolCount: report.checks.tools?.length, result: report.checks.run?.stdout, cleanup: report.cleanup, evidencePath, ...(report.error ? { error: report.error } : {}) }));
  }
}
