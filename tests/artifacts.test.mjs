import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { Store } from '../server/store.mjs';
import { ArtifactManager, classifyArtifact } from '../server/artifacts.mjs';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PYTHON = path.join(APP_ROOT, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function fixture(t) {
  const parent = path.resolve(os.tmpdir());
  const directory = fs.mkdtempSync(path.join(parent, 'science-artifacts-test-'));
  t.after(() => {
    const relative = path.relative(parent, path.resolve(directory));
    assert.ok(!relative.startsWith('..') && !path.isAbsolute(relative) && relative.startsWith('science-artifacts-test-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const store = new Store(path.join(directory, 'data'));
  const project = { id: randomUUID(), name: 'Research', createdAt: new Date().toISOString() };
  project.root = store.projectRoot(project.id);
  store.update(data => data.projects.push(project));
  return { directory, store, manager: new ArtifactManager(store), project };
}

test('store starts empty, persists serial concurrent updates, and never invents completed runs', async t => {
  const f = fixture(t);
  for (const collection of ['sessions', 'artifacts', 'runs', 'connections', 'memories', 'approvals']) assert.deepEqual(f.store.data[collection], []);
  await Promise.all(Array.from({ length: 30 }, (_, index) => Promise.resolve().then(() => f.store.update(data => {
    data.memories.push({ id: String(index), projectId: f.project.id, text: 'note ' + index });
  }))));
  f.store.update(data => {
    data.runs.push({ id: 'local', status: 'running' }, { id: 'remote', status: 'running', jobId: 'slurm-3' }, { id: 'finished', status: 'completed' });
    data.sessions.push({ id: 'session', status: 'running' }, { id: 'starting-session', status: 'starting' });
    data.approvals.push({ id: 1, method: 'item/commandExecution/requestApproval', params: { command: 'old request' } });
  });
  const reopened = new Store(f.store.dataRoot);
  assert.equal(reopened.data.memories.length, 30);
  assert.equal(reopened.data.runs[0].status, 'interrupted');
  assert.equal(reopened.data.runs[1].status, 'unknown');
  assert.equal(reopened.data.runs[2].status, 'completed');
  assert.equal(reopened.data.sessions[0].status, 'interrupted');
  assert.equal(reopened.data.sessions[1].status, 'interrupted');
  assert.deepEqual(reopened.data.approvals, []);
  assert.deepEqual(fs.readdirSync(f.store.dataRoot).filter(name => name.endsWith('.tmp')), []);
  assert.equal(JSON.parse(fs.readFileSync(f.store.filePath, 'utf8')).memories.length, 30);
});

test('store transaction rollback preserves committed state; corrupt persistence is not reset', t => {
  const f = fixture(t);
  assert.throws(() => f.store.update(data => { data.projects.length = 0; throw new Error('abort'); }), /abort/);
  assert.equal(f.store.data.projects.length, 1);
  assert.equal(new Store(f.store.dataRoot).data.projects.length, 1);
  assert.throws(() => f.store.update(async () => {}), /synchronous/);
  fs.writeFileSync(f.store.filePath, '{corrupt');
  assert.throws(() => new Store(f.store.dataRoot), /left untouched/);
  assert.equal(fs.readFileSync(f.store.filePath, 'utf8'), '{corrupt');
});

test('version identity and byte content survive updates, rename, and application restart', async t => {
  const f = fixture(t);
  const bytes = Buffer.from([0, 255, 10, 13, 128, 65, 66]);
  const upload = path.join(f.store.uploadsRoot, 'source.bin');
  fs.writeFileSync(upload, bytes);
  const original = await f.manager.importFile({ projectId: f.project.id, filePath: upload, name: 'dataset.bin' });
  const initial = original.versions[0];
  assert.equal(initial.hash, sha256(bytes));
  assert.deepEqual(fs.readFileSync(f.manager.file(original.id)), bytes);
  fs.writeFileSync(upload, 'changed upload');
  assert.deepEqual(fs.readFileSync(f.manager.file(original.id)), bytes);
  const changed = await f.manager.addVersion(original.id, { text: 'new content' });
  assert.notEqual(changed.versions[0].id, changed.versions[1].id);
  assert.equal(changed.versions[1].parentVersionId, initial.id);
  assert.deepEqual(fs.readFileSync(f.manager.file(original.id, initial.id)), bytes);
  f.manager.update(original.id, { name: 'renamed.bin', starred: true });
  const reopened = new ArtifactManager(new Store(f.store.dataRoot));
  assert.equal(reopened.get(original.id).starred, true);
  assert.equal(reopened.get(original.id).name, 'renamed.bin');
  assert.equal(fs.readFileSync(reopened.file(original.id), 'utf8'), 'new content');
  fs.writeFileSync(reopened.file(original.id), 'tamper');
  assert.throws(() => reopened.file(original.id), /integrity/);
});

test('version change expires review and keeps annotation anchored to its original version', async t => {
  const f = fixture(t);
  const artifact = await f.manager.createText({ projectId: f.project.id, name: 'analysis.md', text: 'Old observation.' });
  const versionId = artifact.versions[0].id;
  const annotation = f.manager.annotate(artifact.id, { text: 'Check this claim.', anchor: { type: 'text', selection: 'Old observation.' }, versionId });
  f.store.update(data => data.artifacts[0].reviews.push({ id: randomUUID(), status: 'passed', versionId }));
  await f.manager.addVersion(artifact.id, { text: 'New observation.' });
  const updated = f.manager.get(artifact.id);
  assert.equal(updated.reviews[0].status, 'stale');
  assert.equal(updated.reviews[0].previousStatus, 'passed');
  assert.equal(updated.annotations[0].id, annotation.id);
  assert.equal(updated.annotations[0].versionId, versionId);
  assert.equal(updated.annotations[0].stale, true);
  assert.throws(() => f.manager.annotate(artifact.id, { text: 'x', anchor: { type: 'text' }, versionId: 'not-a-version' }), /version not found/);
});

test('managed storage rejects traversal, external reads, and symbolic-link escapes', async t => {
  const f = fixture(t);
  const outside = path.join(f.directory, 'outside.txt');
  fs.writeFileSync(outside, 'private');
  await assert.rejects(f.manager.importFile({ projectId: f.project.id, filePath: outside }), /outside managed storage/);
  await assert.rejects(f.manager.createText({ projectId: f.project.id, name: '..\\escape.txt', text: 'no' }), /path separators/);
  assert.throws(() => f.store.managedPath(path.join(f.store.dataRoot, 'uploads') + path.sep + '..' + path.sep + 'store.json'), /traversal/);
  assert.throws(() => f.store.projectRoot('../escape'), /identifier/);
  const link = path.join(f.store.uploadsRoot, 'outside-link');
  try {
    fs.symlinkSync(f.directory, link, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES'].includes(error.code)) { t.diagnostic('Host does not allow symlink creation; escape checks otherwise passed.'); return; }
    throw error;
  }
  await assert.rejects(f.manager.importFile({ projectId: f.project.id, filePath: path.join(link, 'outside.txt') }), /Symbolic links and junctions/);
});

test('project boundaries are checked for session and run references', async t => {
  const f = fixture(t);
  f.store.update(data => {
    data.sessions.push({ id: 'foreign-session', projectId: 'foreign' });
    data.runs.push({ id: 'foreign-run', projectId: 'foreign' });
  });
  await assert.rejects(f.manager.createText({ projectId: f.project.id, sessionId: 'foreign-session', name: 'x.txt', text: 'x' }), /Session does not belong/);
  await assert.rejects(f.manager.createText({ projectId: f.project.id, runId: 'foreign-run', name: 'x.txt', text: 'x' }), /Run does not belong/);
});

test('CSV preview parses quoted multiline values; notebook preview preserves actual cells', async t => {
  const f = fixture(t);
  const csv = await f.manager.createText({ projectId: f.project.id, name: 'observations.csv', text: 'name,value\n"a,b",3\n"two\nlines",4\n' });
  const content = await f.manager.content(csv.id);
  assert.deepEqual(content.columns, ['name', 'value']);
  assert.deepEqual(content.rows, [['a,b', '3'], ['two\nlines', '4']]);
  assert.equal(content.truncated, false);
  const notebook = { nbformat: 4, cells: [{ cell_type: 'code', source: ['x = 3'], outputs: [{ output_type: 'stream', text: '3' }] }] };
  const artifact = await f.manager.createText({ projectId: f.project.id, name: 'analysis.ipynb', text: JSON.stringify(notebook) });
  assert.deepEqual((await f.manager.content(artifact.id)).notebook, notebook);
  const malformed = await f.manager.createText({ projectId: f.project.id, name: 'broken.ipynb', text: '{' });
  assert.match((await f.manager.content(malformed.id)).previewError, /Notebook preview unavailable/);
});

test('binary preview reads real xlsx, parquet, and docx content', { skip: !fs.existsSync(PYTHON) }, async t => {
  const f = fixture(t);
  f.store.data.settings.pythonPath = PYTHON;
  const script = [
    'import sys,pathlib,zipfile',
    'import openpyxl,pyarrow as pa,pyarrow.parquet as pq',
    'p=pathlib.Path(sys.argv[1])',
    'wb=openpyxl.Workbook();ws=wb.active;ws.append(["trial","score"]);ws.append(["a",0.9]);wb.save(p/"values.xlsx")',
    'pq.write_table(pa.table({"trial":["b"],"score":[0.8]}),p/"values.parquet")',
    'with zipfile.ZipFile(p/"notes.docx","w") as z:',
    '    z.writestr("word/document.xml", \'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Measured result</w:t></w:r></w:p></w:body></w:document>\')',
  ].join('\n');
  execFileSync(PYTHON, ['-I', '-c', script, f.store.uploadsRoot], { windowsHide: true, timeout: 30000 });
  for (const [name, rows] of [['values.xlsx', [['a', 0.9]]], ['values.parquet', [['b', 0.8]]]]) {
    const artifact = await f.manager.importFile({ projectId: f.project.id, filePath: path.join(f.store.uploadsRoot, name), name });
    const result = await f.manager.content(artifact.id);
    assert.equal(result.previewError, undefined);
    assert.deepEqual(result.columns, ['trial', 'score']);
    assert.deepEqual(result.rows, rows);
  }
  const docx = await f.manager.importFile({ projectId: f.project.id, filePath: path.join(f.store.uploadsRoot, 'notes.docx'), name: 'notes.docx' });
  assert.equal((await f.manager.content(docx.id)).text, 'Measured result');
});

test('portable project round-trip remaps IDs, retains bytes and links, and drops connection credentials', async t => {
  const f = fixture(t);
  const sessionId = randomUUID(), runId = randomUUID();
  f.store.update(data => {
    data.sessions.push({ id: sessionId, projectId: f.project.id, title: 'Trial', threadId: 'private-thread', messages: [] });
    data.runs.push({ id: runId, projectId: f.project.id, sessionId, status: 'completed', artifactIds: [], code: 'print(3)', outputs: [] });
    data.connections.push({ id: randomUUID(), projectId: f.project.id, type: 'ssh', name: 'HPC', config: { password: 'secret-value', privateKey: 'private-value', envRefs: { TOKEN: 'HPC_TOKEN' } } });
    data.memories.push({ id: randomUUID(), projectId: f.project.id, text: 'A measured result.' });
  });
  const original = await f.manager.createText({ projectId: f.project.id, sessionId, runId, name: 'result.txt', text: 'Result 3', source: 'kernel' });
  f.manager.annotate(original.id, { text: 'Verified against output.', anchor: { type: 'text', selection: '3' }, versionId: original.versions[0].id });
  await f.manager.addVersion(original.id, { text: 'Result 4', runId });
  const exported = await f.manager.exportProject(f.project.id);
  assert.equal(exported.project.root, undefined);
  assert.equal(exported.sessions[0].threadId, undefined);
  assert.equal(exported.artifacts[0].versions[0].path, undefined);
  assert.ok(!JSON.stringify(exported).includes('secret-value'));
  assert.ok(!JSON.stringify(exported).includes('private-value'));
  const importedProject = await f.manager.importProject(exported);
  assert.notEqual(importedProject.id, f.project.id);
  const imported = f.store.data.artifacts.find(item => item.projectId === importedProject.id);
  assert.notEqual(imported.id, original.id);
  assert.equal(imported.versions.length, 2);
  assert.equal(imported.versions[1].parentVersionId, imported.versions[0].id);
  assert.equal(imported.annotations[0].versionId, imported.versions[0].id);
  assert.equal(fs.readFileSync(f.manager.file(imported.id), 'utf8'), 'Result 4');
  assert.equal(fs.readFileSync(f.manager.file(imported.id, imported.versions[0].id), 'utf8'), 'Result 3');
  const importedRun = f.store.data.runs.find(run => run.projectId === importedProject.id);
  assert.deepEqual(importedRun.artifactIds, [imported.id]);
  assert.equal(imported.versions[0].runId, importedRun.id);
  const importedConnection = f.store.data.connections.find(item => item.projectId === importedProject.id);
  assert.deepEqual(importedConnection.config, { envRefs: { TOKEN: 'HPC_TOKEN' } });
  assert.equal(importedConnection.status, 'unconfigured');
});

test('import rejects damaged content and cross-project references before changing project data', async t => {
  const f = fixture(t);
  await f.manager.createText({ projectId: f.project.id, name: 'data.txt', text: 'original' });
  const manifest = await f.manager.exportProject(f.project.id);
  const damaged = structuredClone(manifest);
  damaged.artifacts[0].versions[0].contentBase64 = Buffer.from('corrupted').toString('base64');
  await assert.rejects(f.manager.importProject(damaged), /integrity/);
  assert.equal(f.store.data.projects.length, 1);
  const invalid = structuredClone(manifest);
  invalid.artifacts[0].sessionId = 'another-project-session';
  await assert.rejects(f.manager.importProject(invalid), /session reference/);
  assert.equal(f.store.data.projects.length, 1);
  const maliciousPath = structuredClone(manifest);
  maliciousPath.artifacts[0].versions[0].path = '../../outside.txt';
  const imported = await f.manager.importProject(maliciousPath);
  assert.ok(f.store.data.artifacts.find(item => item.projectId === imported.id).versions[0].path.startsWith('artifacts/'));
  assert.equal(fs.existsSync(path.join(f.directory, 'outside.txt')), false);
});

test('unknown file types remain downloadable and scientific formats have explicit classification', async t => {
  const f = fixture(t);
  assert.equal(classifyArtifact('structure.pdb').kind, 'structure');
  assert.equal(classifyArtifact('molecule.sdf').kind, 'molecule');
  assert.equal(classifyArtifact('regions.bed').kind, 'genome');
  assert.equal(classifyArtifact('alignment.aln').kind, 'msa');
  assert.equal(classifyArtifact('sequence.fasta').kind, 'fasta');
  const artifact = await f.manager.createText({ projectId: f.project.id, name: 'opaque.custom', text: 'opaque data' });
  const content = await f.manager.content(artifact.id);
  assert.equal(content.kind, 'unknown');
  assert.equal(content.text, undefined);
  assert.equal(content.mime, 'application/octet-stream');
  assert.match(content.url, /\/file\?version=/);
});
