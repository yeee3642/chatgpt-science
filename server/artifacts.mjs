import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import Papa from 'papaparse';
import { defaultPythonPath } from './kernel-client.mjs';
import { expandPdfDocuments } from './pdf-content.mjs';

const MAX_FILE_BYTES = 100 * 1024 * 1024;
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_PACKAGE_BYTES = 100 * 1024 * 1024;
const MAX_ROWS = 200;
const MAX_COLUMNS = 100;
const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIME = {
  '.txt': 'text/plain', '.md': 'text/markdown', '.markdown': 'text/markdown',
  '.csv': 'text/csv', '.tsv': 'text/tab-separated-values',
  '.html': 'text/html', '.htm': 'text/html', '.json': 'application/json',
  '.ipynb': 'application/x-ipynb+json', '.pdf': 'application/pdf',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.parquet': 'application/vnd.apache.parquet',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
  '.ogg': 'audio/ogg', '.flac': 'audio/flac', '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.pdb': 'chemical/x-pdb', '.cif': 'chemical/x-cif',
  '.mol': 'chemical/x-mdl-molfile', '.sdf': 'chemical/x-mdl-sdfile',
  '.smi': 'chemical/x-daylight-smiles', '.smiles': 'chemical/x-daylight-smiles',
};
const CODE_EXTENSIONS = new Set(['.py', '.r', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.cpp', '.c', '.h', '.rs', '.go', '.java', '.sh', '.ps1', '.sql', '.yaml', '.yml', '.toml', '.json', '.xml', '.css', '.tex', '.log']);
const TEXT_KINDS = new Set(['text', 'code', 'markdown', 'csv', 'html', 'notebook', 'structure', 'molecule', 'genome', 'msa', 'fasta', 'latex']);
const sha256 = buffer => createHash('sha256').update(buffer).digest('hex');
const now = () => new Date().toISOString();
const copy = value => structuredClone(value);

function fail(message) { throw new Error(message); }
function requiredString(value, label, max = 10000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) fail('Invalid ' + label + '.');
  return value;
}
function validName(name) {
  requiredString(name, 'artifact name', 240);
  if (/[/\\\u0000-\u001f]/.test(name)) fail('Artifact names cannot contain path separators or control characters.');
  return name;
}
function plainObject(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function limitedJson(value, max = MAX_TEXT_BYTES) {
  const serialized = JSON.stringify(value);
  if (serialized === undefined || Buffer.byteLength(serialized) > max) fail('Metadata exceeds the allowed size.');
  return JSON.parse(serialized);
}

export function classifyArtifact(name) {
  const ext = path.extname(name).toLowerCase();
  let kind = 'unknown';
  if (['.txt', '.text'].includes(ext)) kind = 'text';
  else if (['.md', '.markdown'].includes(ext)) kind = 'markdown';
  else if (['.csv', '.tsv'].includes(ext)) kind = 'csv';
  else if (['.xlsx', '.xls'].includes(ext)) kind = 'xlsx';
  else if (ext === '.parquet') kind = 'parquet';
  else if (ext === '.ipynb') kind = 'notebook';
  else if (ext === '.pdf') kind = 'pdf';
  else if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'].includes(ext)) kind = 'image';
  else if (['.html', '.htm'].includes(ext)) kind = 'html';
  else if (ext === '.docx') kind = 'docx';
  else if (['.mp3', '.wav', '.ogg', '.flac', '.m4a'].includes(ext)) kind = 'audio';
  else if (['.mp4', '.webm', '.mov'].includes(ext)) kind = 'video';
  else if (['.pdb', '.cif', '.mmcif', '.bcif'].includes(ext)) kind = 'structure';
  else if (['.mol', '.sdf', '.smi', '.smiles'].includes(ext)) kind = 'molecule';
  else if (['.bed', '.gff', '.gff3', '.gtf', '.vcf', '.bam', '.bai', '.bigwig', '.bw', '.wig'].includes(ext)) kind = 'genome';
  else if (['.aln', '.a3m', '.sto', '.stockholm', '.msa'].includes(ext)) kind = 'msa';
  else if (['.fasta', '.fa', '.fna', '.faa', '.fastq', '.fq'].includes(ext)) kind = 'fasta';
  else if (ext === '.tex') kind = 'latex';
  else if (CODE_EXTENSIONS.has(ext)) kind = 'code';
  const binaryScientific = ['.bcif', '.bam', '.bai', '.bigwig', '.bw'].includes(ext);
  return { kind, mime: MIME[ext] || (TEXT_KINDS.has(kind) && !binaryScientific ? 'text/plain' : 'application/octet-stream'), binaryScientific };
}

// Local parsers only: no workbook formulas, macros, notebook cells, external XML
// entities or embedded scripts are executed by preview.
const PYTHON_PREVIEW = [
  'import sys,json,math,zipfile,xml.etree.ElementTree as ET',
  'p,kind=sys.argv[1:3]',
  'def clean(v):',
  '    if v is None: return None',
  '    if isinstance(v,float) and not math.isfinite(v): return None',
  '    if isinstance(v,(str,int,float,bool)): return v',
  '    return str(v)',
  'result={}',
  'if kind=="xls":',
  '    import xlrd',
  '    wb=xlrd.open_workbook(p,on_demand=True)',
  '    ws=wb.sheet_by_index(0)',
  '    cols=min(ws.ncols,100)',
  '    columns=[str(v) if v!="" else "Column "+str(i+1) for i,v in enumerate(ws.row_values(0,0,cols))] if ws.nrows else []',
  '    rows=[[clean(v) for v in ws.row_values(i,0,cols)] for i in range(1,min(ws.nrows,201))]',
  '    result={"columns":columns,"rows":rows,"sheet":ws.name,"sheets":wb.sheet_names(),"truncated":ws.nrows>201 or ws.ncols>100}',
  '    wb.release_resources()',
  'elif kind=="xlsx":',
  '    import openpyxl',
  '    handle=open(p,"rb")',
  '    wb=openpyxl.load_workbook(handle,read_only=True,data_only=True,keep_links=False)',
  '    ws=wb.worksheets[0]',
  '    it=ws.iter_rows(values_only=True)',
  '    first=next(it,())',
  '    columns=[str(v) if v is not None else "Column "+str(i+1) for i,v in enumerate(first[:100])]',
  '    rows=[]',
  '    for i,row in enumerate(it):',
  '        if i>=200: break',
  '        rows.append([clean(v) for v in row[:100]])',
  '    result={"columns":columns,"rows":rows,"sheet":ws.title,"sheets":wb.sheetnames,"truncated":bool(ws.max_row and ws.max_row>201) or bool(ws.max_column and ws.max_column>100)}',
  '    wb.close()',
  '    handle.close()',
  'elif kind=="parquet":',
  '    import pyarrow.parquet as pq',
  '    pf=pq.ParquetFile(p)',
  '    columns=pf.schema_arrow.names[:100]',
  '    batch=next(pf.iter_batches(batch_size=200,columns=columns),None)',
  '    records=batch.to_pylist() if batch is not None else []',
  '    result={"columns":columns,"rows":[[clean(row.get(c)) for c in columns] for row in records],"truncated":pf.metadata.num_rows>200 or len(pf.schema_arrow.names)>100,"totalRows":pf.metadata.num_rows}',
  'elif kind=="docx":',
  '    with zipfile.ZipFile(p) as z:',
  '        info=z.getinfo("word/document.xml")',
  '        if info.file_size>16777216: raise ValueError("Document XML is too large for preview")',
  '        with z.open(info) as src: raw=src.read(16777217)',
  '        if len(raw)>16777216: raise ValueError("Document XML is too large for preview")',
  '        if b"<!DOCTYPE" in raw.upper() or b"<!ENTITY" in raw.upper(): raise ValueError("XML entities are not allowed")',
  '        root=ET.fromstring(raw)',
  '        ns={"w":"http://schemas.openxmlformats.org/wordprocessingml/2006/main"}',
  '        text="\\n".join("".join(t.text or "" for t in paragraph.findall(".//w:t",ns)) for paragraph in root.findall(".//w:p",ns))',
  '        result={"text":text[:2097152],"truncated":len(text)>2097152}',
  'else: raise ValueError("Unsupported parser")',
  'print(json.dumps(result,ensure_ascii=True,allow_nan=False))',
].join('\n');

function pythonPreview(filePath, kind, settings) {
  const configured = settings?.pythonPath;
  const executable = configured || process.env.SCIENCE_PYTHON_PATH || defaultPythonPath();
  const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API.?KEY|PRIVATE.?KEY|AUTH|COOKIE|^PYTHONHOME$|^PYTHONPATH$/i.test(key)));
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['-I', '-c', PYTHON_PREVIEW, filePath, kind], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', errors = '', settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => { child.kill(); finish(new Error('Preview timed out after 20 seconds. Download remains available.')); }, 20000);
    child.stdout.on('data', chunk => {
      output += chunk;
      if (Buffer.byteLength(output) > 12 * 1024 * 1024) { child.kill(); finish(new Error('Preview output exceeds the safe limit.')); }
    });
    child.stderr.on('data', chunk => { if (errors.length < 12000) errors += chunk; });
    child.on('error', error => finish(new Error('Preview Python is unavailable: ' + error.message)));
    child.on('close', code => {
      if (code !== 0) return finish(new Error('Preview parser failed: ' + (errors.trim().split('\n').at(-1) || 'exit ' + code)));
      try { finish(null, JSON.parse(output)); } catch { finish(new Error('Preview parser returned invalid data.')); }
    });
  });
}

export class ArtifactManager {
  constructor(store) { this.store = store; }

  _project(id) {
    const project = this.store.data.projects.find(item => item.id === id);
    if (!project) fail('Project not found.');
    return project;
  }
  _context(projectId, sessionId, runId) {
    this._project(projectId);
    if (sessionId && !this.store.data.sessions.some(item => item.id === sessionId && item.projectId === projectId)) fail('Session does not belong to this project.');
    if (runId && !this.store.data.runs.some(item => item.id === runId && item.projectId === projectId)) fail('Run does not belong to this project.');
  }
  _record(id) {
    const artifact = this.store.data.artifacts.find(item => item.id === id);
    if (!artifact) fail('Artifact not found.');
    return artifact;
  }
  _version(artifact, id) {
    const version = id ? artifact.versions.find(item => item.id === id) : artifact.versions.at(-1);
    if (!version) fail('Artifact version not found.');
    return version;
  }
  _readManaged(filePath, max = MAX_FILE_BYTES) {
    const safePath = this.store.managedPath(filePath, { mustExist: true });
    const before = fs.statSync(safePath);
    if (!before.isFile()) fail('Only regular files can be imported.');
    if (before.size > max) fail('File exceeds the 100 MiB limit.');
    const fd = fs.openSync(safePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
      const opened = fs.fstatSync(fd);
      this.store.managedPath(safePath, { mustExist: true });
      const after = fs.statSync(safePath);
      if (opened.dev !== after.dev || opened.ino !== after.ino || before.ino !== opened.ino || before.dev !== opened.dev) fail('Source file changed while opening.');
      if (!opened.isFile() || opened.size > max) fail('File is not a regular file or exceeds the size limit.');
      const buffer = Buffer.alloc(opened.size);
      let count = 0;
      while (count < buffer.length) {
        const length = fs.readSync(fd, buffer, count, buffer.length - count, count);
        if (!length) fail('Source file changed while reading.');
        count += length;
      }
      if (fs.fstatSync(fd).size !== opened.size) fail('Source file changed while reading.');
      return buffer;
    } finally { fs.closeSync(fd); }
  }
  _writeVersion(artifactId, name, buffer, options = {}) {
    if (buffer.length > MAX_FILE_BYTES) fail('File exceeds the 100 MiB limit.');
    const id = randomUUID();
    const hash = sha256(buffer);
    const directory = this.store.ensureDirectory(path.join('artifacts', artifactId, id));
    const destination = this.store.managedPath(path.join(directory, hash), { mustExist: false });
    const fd = fs.openSync(destination, 'wx', 0o600);
    try { fs.writeFileSync(fd, buffer); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    const format = classifyArtifact(name);
    return {
      id, hash, path: path.relative(this.store.dataRoot, destination).split(path.sep).join('/'),
      size: buffer.length, createdAt: now(), name, kind: format.kind, mime: format.mime,
      ...(options.runId ? { runId: options.runId } : {}),
      source: typeof options.source === 'string' ? options.source.slice(0, 2000) : 'import',
    };
  }
  _create({ projectId, sessionId, name, runId, source }, buffer) {
    this._context(projectId, sessionId, runId);
    validName(name);
    const id = randomUUID();
    const version = this._writeVersion(id, name, buffer, { runId, source });
    const artifact = {
      id, projectId, ...(sessionId ? { sessionId } : {}), name, kind: version.kind,
      starred: false, versions: [version], currentVersionId: version.id,
      annotations: [], reviews: [], createdAt: version.createdAt, updatedAt: version.createdAt,
    };
    this.store.update(data => {
      data.artifacts.push(artifact);
      if (runId) {
        const run = data.runs.find(item => item.id === runId);
        run.artifactIds ??= [];
        if (!run.artifactIds.includes(id)) run.artifactIds.push(id);
      }
    });
    return copy(artifact);
  }
  async importFile({ projectId, sessionId, filePath, name, runId, source = 'import' }) {
    const buffer = this._readManaged(filePath);
    return this._create({ projectId, sessionId, name: name || path.basename(filePath), runId, source }, buffer);
  }
  async createText({ projectId, sessionId, name, text, runId, source = 'manual' }) {
    if (typeof text !== 'string') fail('Artifact text must be a string.');
    return this._create({ projectId, sessionId, name, runId, source }, Buffer.from(text, 'utf8'));
  }
  async addVersion(id, { text, filePath, source = 'manual', runId } = {}) {
    const artifact = this._record(id);
    this._context(artifact.projectId, artifact.sessionId, runId);
    if ((typeof text === 'string') === (typeof filePath === 'string')) fail('Provide either text or filePath for a new version.');
    const buffer = typeof text === 'string' ? Buffer.from(text, 'utf8') : this._readManaged(filePath);
    const version = this._writeVersion(id, artifact.name, buffer, { source, runId });
    version.parentVersionId = artifact.versions.at(-1).id;
    this.store.update(data => {
      const record = data.artifacts.find(item => item.id === id);
      record.versions.push(version);
      record.currentVersionId = version.id;
      record.updatedAt = version.createdAt;
      for (const review of record.reviews || []) {
        review.previousStatus ??= review.status;
        review.status = 'stale';
        review.stale = true;
        review.staleAt = version.createdAt;
      }
      for (const annotation of record.annotations || []) annotation.stale = annotation.versionId !== version.id;
      if (runId) {
        const run = data.runs.find(item => item.id === runId);
        run.artifactIds ??= [];
        if (!run.artifactIds.includes(id)) run.artifactIds.push(id);
      }
    });
    return this.get(id);
  }
  get(id) { return copy(this._record(id)); }
  file(id, versionId) {
    const artifact = this._record(id);
    const version = this._version(artifact, versionId);
    const safePath = this.store.managedPath(version.path, { mustExist: true });
    const relative = path.relative(this.store.artifactsRoot, safePath);
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) fail('Artifact content is outside artifact storage.');
    const buffer = this._readManaged(safePath);
    if (buffer.length !== version.size || sha256(buffer) !== version.hash) fail('Artifact content failed its integrity check.');
    return safePath;
  }
  async content(id, versionId) {
    const artifact = this._record(id);
    const version = this._version(artifact, versionId);
    const filePath = this.file(id, version.id);
    const format = classifyArtifact(version.name || artifact.name);
    const result = {
      mime: version.mime || format.mime, kind: version.kind || format.kind, size: version.size,
      url: '/api/artifacts/' + encodeURIComponent(id) + '/file?version=' + encodeURIComponent(version.id),
      truncated: false,
    };
    if (TEXT_KINDS.has(format.kind) && !format.binaryScientific) {
      const fd = fs.openSync(filePath, 'r');
      const bytes = Buffer.alloc(Math.min(version.size, MAX_TEXT_BYTES));
      try { fs.readSync(fd, bytes, 0, bytes.length, 0); } finally { fs.closeSync(fd); }
      result.text = new TextDecoder('utf-8').decode(bytes);
      result.truncated = version.size > MAX_TEXT_BYTES;
      if (format.kind === 'csv') {
        const parsed = Papa.parse(result.text, { delimiter: path.extname(version.name).toLowerCase() === '.tsv' ? '\t' : '', skipEmptyLines: 'greedy', preview: MAX_ROWS + 2 });
        result.columns = (parsed.data[0] || []).slice(0, MAX_COLUMNS).map((value, index) => value || 'Column ' + (index + 1));
        result.rows = parsed.data.slice(1, MAX_ROWS + 1).map(row => row.slice(0, MAX_COLUMNS));
        result.truncated ||= Boolean(parsed.meta.truncated) || parsed.data.length > MAX_ROWS + 1 || parsed.data.some(row => row.length > MAX_COLUMNS);
        if (parsed.errors.length) result.warnings = parsed.errors.slice(0, 5).map(error => error.message);
      } else if (format.kind === 'notebook' && !result.truncated) {
        try {
          const notebook = JSON.parse(result.text);
          if (!plainObject(notebook) || !Array.isArray(notebook.cells)) fail('Notebook must contain a cells array.');
          result.notebook = notebook;
        } catch (error) { result.previewError = 'Notebook preview unavailable: ' + error.message; }
      }
    } else if (['xlsx', 'parquet', 'docx'].includes(format.kind)) {
      {
        const parserKind=path.extname(version.name || artifact.name).toLowerCase()==='.xls'?'xls':format.kind;
        try { Object.assign(result, await pythonPreview(filePath, parserKind, this.store.data.settings)); }
        catch (error) { result.previewError = error.message; }
      }
    }
    return result;
  }
  async modelContent(id, versionId) {
    const artifact=this.get(id);
    const version=artifact.versions.find(v=>v.id===(versionId||artifact.currentVersionId));
    if(!version)fail('Artifact version not found.');
    const metadata={artifactId:id,versionId:version.id,name:version.name||artifact.name,sha256:version.hash||version.sha256,runId:version.runId||null};
    const file=this.file(id,version.id);
    const format=classifyArtifact(version.name||artifact.name);
    if(format.kind==='pdf'){
      if(version.size>24*1024*1024)fail('PDF is too large for one model request. Split it into smaller documents before analysis.');
      const body=await expandPdfDocuments({messages:[{role:'user',content:[{type:'document',title:artifact.name,source:{type:'base64',media_type:'application/pdf',data:fs.readFileSync(file).toString('base64')}}]}]});
      return [{type:'inputText',text:JSON.stringify(metadata)},...body.messages[0].content.map(block=>block.type==='image'?{type:'inputImage',imageUrl:`data:${block.source.media_type};base64,${block.source.data}`}:{type:'inputText',text:block.source?.data||block.text||''})];
    }
    if(format.kind==='image'&&['image/png','image/jpeg','image/webp','image/gif'].includes(format.mime)){
      if(version.size>8*1024*1024)fail('Image is too large for one model request. Resize it before analysis.');
      return [{type:'inputText',text:JSON.stringify(metadata)},{type:'inputImage',imageUrl:`data:${format.mime};base64,${fs.readFileSync(file).toString('base64')}`}];
    }
    if(format.kind==='image'&&format.mime==='image/svg+xml')return[{type:'inputText',text:JSON.stringify({...metadata,representation:'SVG source',text:fs.readFileSync(file,'utf8').slice(0,MAX_TEXT_BYTES)})}];
    return[{type:'inputText',text:JSON.stringify({...metadata,...await this.content(id,version.id)})}];
  }

  annotate(id, { text, anchor, versionId } = {}) {
    const artifact = this._record(id);
    requiredString(text, 'annotation text', 50000);
    const version = this._version(artifact, versionId);
    if (!plainObject(anchor) || !['text', 'image', 'pdf', 'html'].includes(anchor.type)) fail('Invalid annotation anchor.');
    const safeAnchor = { type: anchor.type };
    for (const key of ['selection', 'selector']) {
      if (anchor[key] !== undefined) {
        if (typeof anchor[key] !== 'string' || anchor[key].length > 50000) fail('Invalid annotation selection.');
        safeAnchor[key] = anchor[key];
      }
    }
    for (const key of ['x', 'y', 'width', 'height', 'page', 'start', 'end']) {
      if (anchor[key] !== undefined) {
        if (!Number.isFinite(anchor[key]) || anchor[key] < 0 || anchor[key] > 1e9) fail('Invalid annotation coordinates.');
        safeAnchor[key] = anchor[key];
      }
    }
    const annotation = { id: randomUUID(), text, anchor: safeAnchor, versionId: version.id, createdAt: now(), pending: true, stale: version.id !== artifact.versions.at(-1).id };
    this.store.update(data => data.artifacts.find(item => item.id === id).annotations.push(annotation));
    return copy(annotation);
  }
  update(id, { name, starred } = {}) {
    this._record(id);
    if (name !== undefined) validName(name);
    if (starred !== undefined && typeof starred !== 'boolean') fail('starred must be a boolean.');
    this.store.update(data => {
      const artifact = data.artifacts.find(item => item.id === id);
      if (name !== undefined) artifact.name = name;
      if (starred !== undefined) artifact.starred = starred;
      artifact.updatedAt = now();
    });
    return this.get(id);
  }

  async exportProject(projectId) {
    const project = this._project(projectId);
    let total = 0;
    const artifacts = this.store.data.artifacts.filter(item => item.projectId === projectId).map(artifact => ({
      ...copy(artifact),
      versions: artifact.versions.map(version => {
        const bytes = this._readManaged(this.file(artifact.id, version.id));
        total += bytes.length;
        if (total > MAX_PACKAGE_BYTES) fail('Project export exceeds the 100 MiB content limit.');
        const { path: ignoredPath, ...metadata } = version;
        return { ...copy(metadata), contentBase64: bytes.toString('base64') };
      }),
    }));
    const sessions = this.store.data.sessions.filter(item => item.projectId === projectId).map(session => {
      const { threadId, ...portable } = session;
      return copy(portable);
    });
    const runs = this.store.data.runs.filter(item => item.projectId === projectId).map(run => {
      const { pid, kernelId, jobId, remoteJobId, ...portable } = run;
      return copy(portable);
    });
    const memories = this.store.data.memories.filter(item => item.projectId === projectId).map(copy);
    // Connections are opt-in hints only; never export tokens, keys, passwords,
    // whole environment maps, remote URLs with credentials or local key paths.
    const connections = this.store.data.connections.filter(item => item.projectId === projectId).map(connection => ({
      id: connection.id, name: connection.name, type: connection.type,
      config: { envRefs: plainObject(connection.config?.envRefs)
        ? Object.fromEntries(Object.entries(connection.config.envRefs).filter(([key, value]) => /^[A-Za-z0-9_]+$/.test(key) && typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value)))
        : {} },
      status: 'unconfigured',
    }));
    const { root, ...portableProject } = project;
    const manifest = { format: 'science-workbench-project', version: 1, exportedAt: now(), project: copy(portableProject), sessions, runs, artifacts, memories, connections };
    if (Buffer.byteLength(JSON.stringify(manifest)) > Math.ceil(MAX_PACKAGE_BYTES * 4 / 3) + 16 * 1024 * 1024) fail('Project export metadata exceeds its size limit.');
    return manifest;
  }

  async importProject(manifest) {
    if (!plainObject(manifest) || manifest.format !== 'science-workbench-project' || manifest.version !== 1 || !plainObject(manifest.project)) fail('Unsupported project package.');
    requiredString(manifest.project.id, 'source project ID', 100);
    requiredString(manifest.project.name, 'project name', 240);
    const collections = {};
    for (const name of ['sessions', 'runs', 'artifacts', 'memories', 'connections']) {
      if (!Array.isArray(manifest[name]) || manifest[name].length > 10000) fail('Invalid package collection: ' + name);
      collections[name] = manifest[name];
    }
    if (Buffer.byteLength(JSON.stringify(manifest)) > Math.ceil(MAX_PACKAGE_BYTES * 4 / 3) + 16 * 1024 * 1024) fail('Project package exceeds its size limit.');
    const idMap = new Map([[manifest.project.id, randomUUID()]]);
    const versionIds = new Set();
    const artifactIds = new Set();
    const sessionIds = new Set();
    const runIds = new Set();
    const buffers = new Map();
    const register = id => {
      requiredString(id, 'package identifier', 100);
      if (idMap.has(id)) fail('Duplicate package identifier.');
      idMap.set(id, randomUUID());
    };
    let total = 0;
    for (const name of Object.keys(collections)) {
      for (const record of collections[name]) {
        if (!plainObject(record)) fail('Invalid package record.');
        register(record.id);
        if (record.projectId !== undefined && record.projectId !== manifest.project.id) fail('Package contains a record from another project.');
        if (name === 'sessions') sessionIds.add(record.id);
        if (name === 'runs') runIds.add(record.id);
        if (name !== 'artifacts') continue;
        artifactIds.add(record.id);
        validName(record.name);
        if (!Array.isArray(record.versions) || !record.versions.length || record.versions.length > 10000) fail('Invalid artifact versions.');
        for (const version of record.versions) {
          if (!plainObject(version)) fail('Invalid artifact version.');
          register(version.id);
          versionIds.add(version.id);
          if (typeof version.contentBase64 !== 'string' || version.contentBase64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(version.contentBase64)) fail('Invalid base64 artifact content.');
          const bytes = Buffer.from(version.contentBase64, 'base64');
          if (bytes.toString('base64') !== version.contentBase64) fail('Noncanonical base64 artifact content.');
          total += bytes.length;
          if (total > MAX_PACKAGE_BYTES || bytes.length > MAX_FILE_BYTES) fail('Project package exceeds the 100 MiB content limit.');
          if (!Number.isSafeInteger(version.size) || version.size !== bytes.length || version.hash !== sha256(bytes)) fail('Artifact package failed its integrity check.');
          buffers.set(version.id, bytes);
          if (version.name !== undefined) validName(version.name);
        }
      }
    }
    const checkRef = (id, ids, label) => { if (id !== undefined && id !== null && !ids.has(id)) fail('Invalid ' + label + ' reference in package.'); };
    for (const artifact of collections.artifacts) {
      checkRef(artifact.sessionId, sessionIds, 'session');
      const ownVersions = new Set(artifact.versions.map(version => version.id));
      checkRef(artifact.currentVersionId, ownVersions, 'current version');
      for (const version of artifact.versions) {
        checkRef(version.runId, runIds, 'run');
        checkRef(version.parentVersionId, ownVersions, 'parent version');
      }
      if (artifact.annotations !== undefined && !Array.isArray(artifact.annotations)) fail('Invalid artifact annotations.');
      if (artifact.reviews !== undefined && !Array.isArray(artifact.reviews)) fail('Invalid artifact reviews.');
      for (const annotation of artifact.annotations || []) {
        if (!plainObject(annotation)) fail('Invalid imported annotation.');
        checkRef(annotation.versionId, ownVersions, 'annotation version');
      }
    }
    for (const run of collections.runs) {
      checkRef(run.sessionId, sessionIds, 'run session');
      if (run.artifactIds !== undefined && !Array.isArray(run.artifactIds)) fail('Invalid run artifact references.');
      for (const id of run.artifactIds || []) checkRef(id, artifactIds, 'run artifact');
    }
    const remap = value => {
      if (typeof value === 'string') return idMap.get(value) || value;
      if (Array.isArray(value)) return value.map(remap);
      if (plainObject(value)) return Object.fromEntries(Object.entries(value).filter(([key]) => !['__proto__', 'constructor', 'prototype'].includes(key)).map(([key, entry]) => [key, remap(entry)]));
      return value;
    };
    const importedAt = now();
    const projectId = idMap.get(manifest.project.id);
    const project = {
      id: projectId, name: manifest.project.name + ' (imported)',
      description: typeof manifest.project.description === 'string' ? manifest.project.description.slice(0, 10000) : '',
      root: this.store.projectRoot(projectId), createdAt: importedAt, archived: false, importedAt,
    };
    const artifacts = collections.artifacts.map(record => {
      const id = idMap.get(record.id);
      const versions = record.versions.map(version => {
        const stored = this._writeVersion(id, version.name || record.name, buffers.get(version.id), { source: 'project-import' });
        // Use the preallocated ID to keep all manifest references consistent.
        idMap.set(version.id, stored.id);
        return { ...stored, originalCreatedAt: version.createdAt, importedAt, ...(version.runId ? { runId: idMap.get(version.runId) } : {}), originalSource: typeof version.source === 'string' ? version.source.slice(0, 2000) : 'unknown' };
      });
      for (let index = 0; index < versions.length; index++) {
        const parent = record.versions[index].parentVersionId;
        if (parent) versions[index].parentVersionId = idMap.get(parent);
      }
      return {
        id, projectId, ...(record.sessionId ? { sessionId: idMap.get(record.sessionId) } : {}),
        name: record.name, kind: versions.at(-1).kind, starred: Boolean(record.starred),
        versions, currentVersionId: versions.at(-1).id,
        annotations: (record.annotations || []).map(annotation => ({
          id: randomUUID(), text: typeof annotation.text === 'string' ? annotation.text.slice(0, 50000) : '',
          anchor: plainObject(annotation.anchor) ? limitedJson(annotation.anchor, 100000) : { type: 'text' },
          versionId: idMap.get(annotation.versionId), createdAt: annotation.createdAt || importedAt,
          pending: false, imported: true, stale: idMap.get(annotation.versionId) !== versions.at(-1).id,
        })),
        reviews: (record.reviews || []).map(review => ({ ...limitedJson(remap(review), 200000), id: randomUUID(), status: 'stale', stale: true, imported: true, staleAt: importedAt })),
        createdAt: importedAt, updatedAt: importedAt,
      };
    });
    const sessions = collections.sessions.map(session => ({
      id: idMap.get(session.id), projectId, title: typeof session.title === 'string' ? session.title.slice(0, 500) : 'Imported session',
      messages: Array.isArray(session.messages) ? remap(limitedJson(session.messages, 8 * 1024 * 1024)) : [],
      status: 'idle', createdAt: session.createdAt || importedAt, importedAt,
    }));
    const runs = collections.runs.map(run => {
      const result = remap(limitedJson(run, 8 * 1024 * 1024));
      for (const key of ['pid', 'kernelId', 'jobId', 'remoteJobId', 'cwd', 'root', 'environment']) delete result[key];
      return { ...result, id: idMap.get(run.id), projectId, status: ['queued', 'starting', 'running', 'cancelling', 'unknown'].includes(run.status) ? 'unknown' : run.status, importedAt, environment: { imported: true, available: false } };
    });
    const memories = collections.memories.map(memory => ({
      id: idMap.get(memory.id), projectId, text: typeof memory.text === 'string' ? memory.text.slice(0, 100000) : '',
      createdAt: memory.createdAt || importedAt, source: 'project-import', importedAt,
    }));
    const connections = collections.connections.map(connection => ({
      id: idMap.get(connection.id), projectId,
      name: typeof connection.name === 'string' ? connection.name.slice(0, 240) : 'Imported connection',
      type: typeof connection.type === 'string' ? connection.type.slice(0, 30) : 'unknown',
      config: { envRefs: plainObject(connection.config?.envRefs)
        ? Object.fromEntries(Object.entries(connection.config.envRefs).filter(([key, value]) => /^[A-Za-z0-9_]+$/.test(key) && typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value)))
        : {} },
      status: 'unconfigured', importedAt,
    }));
    this.store.update(data => {
      data.projects.push(project); data.artifacts.push(...artifacts);
      data.sessions.push(...sessions); data.runs.push(...runs);
      data.memories.push(...memories); data.connections.push(...connections);
    });
    return copy(project);
  }
}

export default ArtifactManager;
