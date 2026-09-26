import { spawn } from 'node:child_process';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

const MAX_RESPONSE = 4 * 1024 * 1024;
const MAX_LOG = 128 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SAFE_ALIAS = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'timed_out']);

function requiredText(value, name, max = 512) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) {
    throw new Error(`${name} must be nonempty text, at most ${max} characters.`);
  }
  return value.trim();
}

function boundedInteger(value, fallback, min, max) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Value must be an integer from ${min} to ${max}.`);
  return value;
}

function envValue(name, environment = process.env, required = true) {
  if (!name && !required) return undefined;
  if (typeof name !== 'string' || !ENV_NAME.test(name)) throw new Error('Provide a valid environment-variable reference for this credential.');
  const value = environment[name];
  if (!value && required) throw new Error(`Credential environment variable ${name} is not set.`);
  return value;
}

function referencedSecrets(config, environment = process.env) {
  const result = [];
  for (const [key, value] of Object.entries(config || {})) {
    if (/Env$/.test(key) && typeof value === 'string' && environment[value]) result.push(environment[value]);
    if ((key === 'headersEnv' || key === 'envRefs') && value && typeof value === 'object') {
      for (const name of Object.values(value)) if (environment[name]) result.push(environment[name]);
    }
  }
  return result;
}

function integrationSecrets(config, options) {
  return [...referencedSecrets(config, options.environment), ...(options.authProvider?.secretValues() || [])];
}

function redact(value, secrets = []) {
  let text = String(value ?? '');
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) text = text.split(secret).join('[REDACTED]');
  return text.replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+/gi, '$1[REDACTED]')
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]')
    .replace(/([?&](?:sig|token|api_key|key|access_token)=)[^&\s]+/gi, '$1[REDACTED]')
    .replace(/((?:token|secret|password|api[_-]?key)\s*[=:]\s*)[^\s,;]+/gi, '$1[REDACTED]');
}

function safeJson(value, secrets = []) {
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized || '') > MAX_RESPONSE) throw new Error('Integration response exceeds the 4 MiB limit.');
  // Replace string values instead of serialized JSON so quote-containing secrets remain redactable.
  if (typeof value === 'string') return redact(value, secrets);
  if (Array.isArray(value)) return value.map(item => safeJson(item, secrets));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, safeJson(item, secrets)]));
  return value;
}

function endpointUrl(value, { allowQuery = false } = {}) {
  const url = new URL(requiredText(value, 'Endpoint URL', 2048));
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw new Error('Use HTTPS, or HTTP for a local loopback endpoint.');
  if (url.username || url.password || url.hash || (!allowQuery && url.search)) throw new Error('Keep credentials out of endpoint URLs; use environment-variable references.');
  return url;
}

function authHeaders(config, environment) {
  const headers = {};
  if (config.tokenEnv) headers.Authorization = `Bearer ${envValue(config.tokenEnv, environment)}`;
  if (config.apiKeyEnv) {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(config.apiKeyHeader || 'x-api-key')) throw new Error('Invalid API key header name.');
    headers[config.apiKeyHeader || 'x-api-key'] = envValue(config.apiKeyEnv, environment);
  }
  for (const [header, variable] of Object.entries(config.headersEnv || {})) {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(header)) throw new Error('Invalid HTTP header name.');
    headers[header] = envValue(variable, environment);
  }
  return headers;
}

async function limitedBody(response, maxBytes = MAX_RESPONSE) {
  if (Number(response.headers.get('content-length')) > maxBytes) throw new Error('Provider response is too large.');
  if (!response.body) return '';
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > maxBytes) throw new Error('Provider response is too large.');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function publicGet(url, { fetchImpl = fetch, timeoutMs = 8000, retries = 1, signal } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (let attempt = 0; ; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('Literature provider timed out.');
    try {
      const response = await fetchImpl(url, {
        headers: { Accept: 'application/json, application/atom+xml', 'User-Agent': 'ScienceWorkbench/0.1 (literature research)' },
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(remaining)]) : AbortSignal.timeout(remaining),
        redirect: 'error',
      });
      if (!response.ok) {
        await response.body?.cancel();
        const error = new Error(`Provider returned HTTP ${response.status}.`);
        error.retryable = response.status === 429 || response.status >= 500;
        throw error;
      }
      return await limitedBody(response);
    } catch (error) {
      if (signal?.aborted || attempt >= retries || error.retryable === false || Date.now() >= deadline || /too large/.test(error.message)) throw error;
      if (error.retryable === undefined && error.name !== 'TypeError') throw error;
      // GET only, one bounded retry; never retry tool calls, submissions or uploads.
    }
  }
}

function xmlText(value = '') {
  return value.replace(/<[^>]*>/g, '').replace(/&(?:amp|lt|gt|quot|apos|#x[0-9a-f]+|#[0-9]+);/gi, entity => {
    const named = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };
    if (named[entity]) return named[entity];
    const number = entity.startsWith('&#x') ? parseInt(entity.slice(3, -1), 16) : parseInt(entity.slice(2, -1), 10);
    return Number.isFinite(number) && number > 0 && number <= 0x10ffff ? String.fromCodePoint(number) : '';
  }).replace(/\s+/g, ' ').trim();
}

function atomTag(entry, tag) {
  return xmlText(entry.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i'))?.[1] || '');
}

export async function searchLiterature(query, options = {}) {
  query = requiredText(query, 'Search query', 500);
  if (query.length < 2) throw new Error('Search query must contain at least two characters.');
  const limit = boundedInteger(options.limit, 10, 1, 25);
  const crossref = new URL('https://api.crossref.org/works');
  crossref.search = new URLSearchParams({ query, rows: String(limit), select: 'DOI,title,author,published,URL,abstract' });
  const arxiv = new URL('https://export.arxiv.org/api/query');
  arxiv.search = new URLSearchParams({ search_query: `all:${query}`, start: '0', max_results: String(limit), sortBy: 'relevance' });
  const tasks = [
    publicGet(crossref, options).then(text => {
      const items = JSON.parse(text)?.message?.items;
      if (!Array.isArray(items)) throw new Error('Crossref returned an unexpected response.');
      return items.slice(0, limit).map(item => ({
        id: `crossref:${item.DOI || randomUUID()}`, title: xmlText(item.title?.[0] || ''),
        authors: (item.author || []).map(author => [author.given, author.family].filter(Boolean).join(' ') || author.name || '').filter(Boolean),
        year: item.published?.['date-parts']?.[0]?.[0] || null,
        url: item.DOI ? `https://doi.org/${encodeURIComponent(item.DOI)}` : item.URL || '',
        doi: item.DOI || null, abstract: xmlText(item.abstract || ''), source: 'Crossref',
      }));
    }),
    publicGet(arxiv, options).then(text => {
      if (!/<feed[\s>]/.test(text)) throw new Error('arXiv returned an unexpected response.');
      return [...text.matchAll(/<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/g)].slice(0, limit).map(([, entry]) => {
        const id = atomTag(entry, 'id');
        return { id: `arxiv:${id.split('/').pop()}`, title: atomTag(entry, 'title'),
          authors: [...entry.matchAll(/<author(?:\s[^>]*)?>([\s\S]*?)<\/author>/g)].map(([, author]) => atomTag(author, 'name')),
          year: Number(atomTag(entry, 'published').slice(0, 4)) || null, url: id.replace(/^http:/, 'https:'),
          doi: atomTag(entry, 'arxiv:doi') || null, abstract: atomTag(entry, 'summary'), source: 'arXiv' };
      });
    }),
  ];
  const settled = await Promise.allSettled(tasks);
  const successes = settled.filter(item => item.status === 'fulfilled');
  if (!successes.length) throw new Error(`Literature search unavailable: ${settled.map((item, i) => `${i ? 'arXiv' : 'Crossref'}: ${item.reason.message}`).join(' ')}`);
  settled.forEach((item, i) => { if (item.status === 'rejected') options.onWarning?.(`${i ? 'arXiv' : 'Crossref'}: ${item.reason.message}`); });
  const seen = new Set();
  return successes.flatMap(item => item.value).filter(item => {
    if (!item.title) return false;
    const identity = (item.doi || item.title).toLowerCase();
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

export function runProcess(command, args, { input, timeoutMs = 15000, cwd, environment, onOutput, maxOutput = MAX_RESPONSE } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, windowsHide: true, cwd, env: environment, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', size = 0, finished = false;
    const timer = setTimeout(() => { child.kill(); finish(new Error(`Command timed out after ${timeoutMs} ms.`)); }, timeoutMs);
    const finish = (error, code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      error ? reject(Object.assign(error, { stdout, stderr })) : resolve({ code, stdout, stderr });
    };
    const consume = (stream, chunk) => {
      size += chunk.length;
      if (size > maxOutput) { child.kill(); finish(new Error('Command output exceeded the configured limit.')); return; }
      const text = chunk.toString();
      if (stream === 'stdout') stdout += text; else stderr += text;
      onOutput?.(stream, text);
    };
    child.stdout.on('data', chunk => consume('stdout', chunk));
    child.stderr.on('data', chunk => consume('stderr', chunk));
    child.on('error', error => finish(error));
    child.on('close', code => finish(null, code));
    child.stdin.on('error', () => {});
    child.stdin.end(input || '');
  });
}

function sshArguments(host) {
  if (typeof host !== 'string' || !SAFE_ALIAS.test(host)) throw new Error('SSH host must be a saved SSH alias, using letters, numbers, dots, hyphens or underscores.');
  return ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=7', '-o', 'StrictHostKeyChecking=yes', '-o', 'ClearAllForwardings=yes', '-o', 'RequestTTY=no', '--', host, 'sh -s'];
}

async function sshExecute(config, input, options = {}) {
  const result = await (options.runProcess || runProcess)('ssh', sshArguments(config.host), { input, timeoutMs: options.timeoutMs || 15000, maxOutput: MAX_RESPONSE });
  if (result.code !== 0) throw new Error(`SSH command failed (${result.code}): ${redact(result.stderr).slice(0, 1000)}`);
  return result.stdout;
}

async function createMcpClient(config, options = {}) {
  if (options.mcpFactory) return options.mcpFactory(config, options);
  const [{ Client }, { StreamableHTTPClientTransport }, { StdioClientTransport, getDefaultEnvironment }, { SSEClientTransport }] = await Promise.all([
    import('@modelcontextprotocol/sdk/client/index.js'), import('@modelcontextprotocol/sdk/client/streamableHttp.js'), import('@modelcontextprotocol/sdk/client/stdio.js'), import('@modelcontextprotocol/sdk/client/sse.js'),
  ]);
  const environment = options.environment || process.env;
  let transport;
  if (config.url) {
    if (config.authMode === 'oauth' && !options.authProvider?.hasTokens()) throw new Error('MCP OAuth authorization required. Reconnect this provider; tokens are kept only until the application exits.');
    if (config.transport && !['streamable-http', 'sse'].includes(config.transport)) throw new Error('MCP transport must be streamable-http or sse.');
    const transportOptions = {
      authProvider: options.authProvider,
      requestInit: { headers: authHeaders(config, environment), redirect: 'error' },
      fetch: (url, init) => (options.fetchImpl || fetch)(url, { ...init, redirect: 'error' }),
    };
    transport = config.transport === 'sse'
      ? new SSEClientTransport(endpointUrl(config.url), transportOptions)
      : new StreamableHTTPClientTransport(endpointUrl(config.url), { ...transportOptions, reconnectionOptions: { maxReconnectionDelay: 1000, initialReconnectionDelay: 500, reconnectionDelayGrowFactor: 1, maxRetries: 0 } });
  } else if (config.command) {
    const command = requiredText(config.command, 'MCP executable', 1024);
    if (/\r|\n/.test(command) || /\.(?:cmd|bat|ps1)$/i.test(command)) throw new Error('Use an executable, node, or python directly, not a shell script launcher.');
    const args = config.args || [];
    if (!Array.isArray(args) || args.length > 64 || args.some(arg => typeof arg !== 'string' || arg.length > 4096 || arg.includes('\0'))) throw new Error('MCP args must be an array of at most 64 bounded strings.');
    const env = getDefaultEnvironment();
    for (const [target, reference] of Object.entries(config.envRefs || {})) {
      if (!ENV_NAME.test(target)) throw new Error('Invalid connector environment name.');
      env[target] = envValue(reference, environment);
    }
    transport = new StdioClientTransport({ command, args, env, stderr: 'pipe', maxBufferSize: MAX_RESPONSE });
    transport.stderr?.on('data', () => {}); // Never echo a connector's stderr or credentials into the server log.
  } else throw new Error('Configure an MCP HTTPS URL or an explicit executable and args.');
  const client = new Client({ name: 'science-workbench', version: '0.1.0' }, { capabilities: {} });
  const timeoutMs = options.timeoutMs || 10000;
  let timer;
  try {
    await Promise.race([
      client.connect(transport, { timeout: timeoutMs }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('MCP connection timed out.')), timeoutMs); }),
    ]);
    return client;
  } catch (error) { await client.close().catch(() => {}); throw error; }
  finally { clearTimeout(timer); }
}

async function listMcpTools(client, timeoutMs = 10000) {
  const tools = [];
  let cursor;
  const seen = new Set();
  const deadline = Date.now() + timeoutMs;
  let pages = 0;
  do {
    if (++pages > 20 || Date.now() >= deadline) throw new Error('MCP tool discovery exceeded its pagination/time limit.');
    const result = await client.listTools(cursor ? { cursor } : {}, { timeout: Math.max(1, deadline - Date.now()) });
    tools.push(...(result.tools || []));
    if (tools.length > 1000) throw new Error('MCP server advertises more than the 1000-tool limit.');
    cursor = result.nextCursor;
    if (cursor && seen.has(cursor)) throw new Error('MCP server repeated a pagination cursor.');
    seen.add(cursor);
  } while (cursor);
  return tools;
}

export async function callMcpTool(connection, request, options = {}) {
  if (connection?.type !== 'mcp') throw new Error('This connection is not MCP.');
  const name = requiredText(request?.name, 'Tool name', 128);
  const args = request.arguments ?? {};
  if (!args || typeof args !== 'object' || Array.isArray(args) || Buffer.byteLength(JSON.stringify(args)) > 256 * 1024) throw new Error('Tool arguments must be a JSON object of at most 256 KiB.');
  let client;
  try {
    client = await createMcpClient(connection.config || {}, options);
    const tools = await listMcpTools(client, options.timeoutMs);
    const advertised = tools.find(tool => tool.name === name);
    if (!advertised) throw new Error('Tool is not advertised by this configured MCP server.');
    if (request.requireReadOnly === true && advertised.annotations?.readOnlyHint !== true) throw new Error('This operation requires a tool advertised as read-only by the connected MCP server.');
    const result = await client.callTool({ name, arguments: args }, undefined, { timeout: options.timeoutMs || 30000 });
    return safeJson(result, integrationSecrets(connection.config, options));
  } catch (error) { throw new Error(redact(error.message, integrationSecrets(connection.config, options))); }
  finally { await client?.close().catch(() => {}); }
}

async function storageAdapter(connection, options = {}) {
  if (options.storageFactory) return options.storageFactory(connection);
  const config = connection.config || {}, environment = options.environment || process.env;
  const bucketName = requiredText(config.bucket || config.container, 'Bucket or container', 255);
  if (connection.type === 's3') {
    const { S3Client, HeadBucketCommand, ListObjectsV2Command, GetObjectCommand, PutObjectCommand } = await import('@aws-sdk/client-s3');
    const client = new S3Client({ region: config.region || 'us-east-1', endpoint: config.endpoint ? endpointUrl(config.endpoint).href : undefined,
      forcePathStyle: Boolean(config.forcePathStyle || config.endpoint), maxAttempts: 1,
      credentials: { accessKeyId: envValue(config.accessKeyIdEnv, environment), secretAccessKey: envValue(config.secretAccessKeyEnv, environment), sessionToken: envValue(config.sessionTokenEnv, environment, false) } });
    return {
      test: () => client.send(new HeadBucketCommand({ Bucket: bucketName }), { abortSignal: AbortSignal.timeout(10000) }),
      list: async (prefix, limit) => {
        const data = await client.send(new ListObjectsV2Command({ Bucket: bucketName, Prefix: prefix, MaxKeys: limit }), { abortSignal: AbortSignal.timeout(10000) });
        return { objects: (data.Contents || []).map(item => ({ key: item.Key, size: item.Size, modifiedAt: item.LastModified?.toISOString() })), truncated: Boolean(data.IsTruncated) };
      },
      download: async (key, destination) => { const result = await client.send(new GetObjectCommand({ Bucket: bucketName, Key: key }), { abortSignal: AbortSignal.timeout(120000) }); await pipeline(result.Body, createWriteStream(destination, { flags: 'wx' })); },
      upload: async (key, file) => client.send(new PutObjectCommand({ Bucket: bucketName, Key: key, Body: createReadStream(file), ContentLength: (await fs.stat(file)).size }), { abortSignal: AbortSignal.timeout(120000) }),
      close: () => client.destroy(),
    };
  }
  if (connection.type === 'gcs') {
    const { Storage } = await import('@google-cloud/storage');
    let credentials;
    try { credentials = JSON.parse(envValue(config.credentialsJsonEnv, environment)); } catch { throw new Error('Set credentialsJsonEnv to an environment variable containing service-account JSON.'); }
    if (!credentials.client_email || !credentials.private_key) throw new Error('GCS service-account JSON needs client_email and private_key.');
    const client = new Storage({ projectId: config.projectId || credentials.project_id, credentials, retryOptions: { autoRetry: false }, timeout: 10000 });
    const bucket = client.bucket(bucketName);
    return {
      test: () => bucket.getMetadata(),
      list: async (prefix, limit) => {
        const [files, next] = await bucket.getFiles({ prefix, maxResults: limit, autoPaginate: false });
        return { objects: files.map(file => ({ key: file.name, size: Number(file.metadata.size || 0), modifiedAt: file.metadata.updated })), truncated: Boolean(next) };
      },
      download: (key, destination) => bucket.file(key).download({ destination }),
      upload: (key, file) => bucket.upload(file, { destination: key, resumable: false, timeout: 120000 }),
      close: () => {},
    };
  }
  if (connection.type === 'azure') {
    const { BlobServiceClient, ContainerClient, StorageSharedKeyCredential } = await import('@azure/storage-blob');
    let container;
    const pipelineOptions = { retryOptions: { maxTries: 1, tryTimeoutInMs: 10000 } };
    if (config.connectionStringEnv) container = BlobServiceClient.fromConnectionString(envValue(config.connectionStringEnv, environment), pipelineOptions).getContainerClient(bucketName);
    else if (config.sasTokenEnv) {
      const base = endpointUrl(config.accountUrl).href.replace(/\/$/, '');
      const sas = envValue(config.sasTokenEnv, environment).replace(/^\?/, '');
      container = new ContainerClient(`${base}/${encodeURIComponent(bucketName)}?${sas}`, pipelineOptions);
    } else {
      const base = endpointUrl(config.accountUrl).href;
      const credential = new StorageSharedKeyCredential(requiredText(config.accountName, 'Azure account name', 100), envValue(config.accountKeyEnv, environment));
      container = new BlobServiceClient(base, credential, pipelineOptions).getContainerClient(bucketName);
    }
    return {
      test: () => container.getProperties({ abortSignal: AbortSignal.timeout(10000) }),
      list: async (prefix, limit) => {
        const page = await container.listBlobsFlat({ prefix }).byPage({ maxPageSize: limit }).next();
        return { objects: (page.value?.segment?.blobItems || []).map(item => ({ key: item.name, size: item.properties.contentLength, modifiedAt: item.properties.lastModified?.toISOString() })), truncated: Boolean(page.value?.continuationToken) };
      },
      download: (key, destination) => container.getBlobClient(key).downloadToFile(destination, 0, undefined, { abortSignal: AbortSignal.timeout(120000) }),
      upload: (key, file) => container.getBlockBlobClient(key).uploadFile(file, { abortSignal: AbortSignal.timeout(120000) }),
      close: () => {},
    };
  }
  throw new Error('Choose an S3, GCS, or Azure storage connection.');
}

async function withStorage(connection, options, operation) {
  const secrets = referencedSecrets(connection.config, options.environment);
  let adapter;
  try { adapter = await storageAdapter(connection, options); return await operation(adapter); }
  catch (error) { throw new Error(redact(error.code === 'ERR_MODULE_NOT_FOUND' ? 'Storage provider SDK is not installed in this application.' : error.message, secrets)); }
  finally { adapter?.close?.(); }
}

export async function storageList(connection, { prefix = '', limit = 100, ...options } = {}) {
  if (typeof prefix !== 'string' || prefix.length > 1024 || prefix.includes('\0')) throw new Error('Invalid object prefix.');
  limit = boundedInteger(limit, 100, 1, 1000);
  const result = await withStorage(connection, options, adapter => adapter.list(prefix, limit));
  return { ...result, items: result.objects || result.items || [] };
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function checkedProjectPath(projectRoot, candidate, { existing = false } = {}) {
  const root = await fs.realpath(requiredText(projectRoot, 'Registered project root', 4096));
  const resolved = path.resolve(root, requiredText(candidate, 'Project file path', 4096));
  if (!inside(root, resolved) || resolved === root) throw new Error('File must stay inside the registered project root.');
  let current = root;
  for (const part of path.relative(root, resolved).split(path.sep)) {
    current = path.join(current, part);
    try { const stat = await fs.lstat(current); if (stat.isSymbolicLink()) throw new Error('Symlink paths are not allowed for integration files.'); }
    catch (error) { if (error.code !== 'ENOENT' || existing) throw error; }
  }
  return resolved;
}

function objectKey(key) { return requiredText(key, 'Object key', 1024); }

export async function storageDownload(connection, { key, destination, projectRoot, ...options }) {
  key = objectKey(key);
  const target = await checkedProjectPath(projectRoot, destination);
  try { await fs.lstat(target); throw new Error('Destination already exists. Choose a new filename.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.download`;
  try {
    await withStorage(connection, options, adapter => adapter.download(key, temporary));
    // link() is atomic and refuses to overwrite a concurrently created target.
    await fs.link(temporary, target);
    await fs.unlink(temporary);
    return { key, path: target, size: (await fs.stat(target)).size };
  } finally { await fs.unlink(temporary).catch(() => {}); }
}

export async function storageUpload(connection, { key, path: file, projectRoot, ...options }) {
  key = objectKey(key);
  const source = await checkedProjectPath(projectRoot, file, { existing: true });
  const stat = await fs.stat(source);
  if (!stat.isFile()) throw new Error('Upload source must be a regular file.');
  await withStorage(connection, options, adapter => adapter.upload(key, source));
  return { key, size: stat.size, uploaded: true };
}

export async function testConnection(connection, options = {}) {
  const config = connection?.config || {}, secrets = referencedSecrets(config, options.environment);
  const checkedAt = new Date().toISOString();
  try {
    if (connection?.type === 'ssh') {
      const output = await sshExecute(config, "printf 'SCIENCE_SSH_OK\\n'\nuname -s\nprintf 'CPUS:'; getconf _NPROCESSORS_ONLN 2>/dev/null || true\nif [ -r /proc/meminfo ]; then awk '/^MemTotal:/ {printf \"MEMORY_KIB:%s\\n\", $2}' /proc/meminfo; fi\nif command -v nvidia-smi >/dev/null 2>&1; then nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -n 16 | sed 's/^/GPU:/'; fi\nfor tool in sbatch conda apptainer; do if command -v \"$tool\" >/dev/null 2>&1; then printf 'TOOL:%s\\n' \"$tool\"; fi; done\n", options);
      if (!output.includes('SCIENCE_SSH_OK')) throw new Error('SSH probe did not return its expected marker.');
      return { ok: true, available: true, status: 'connected', checkedAt, message: 'SSH key authentication and read-only host probe succeeded.', platform: output.split('\n')[1]?.trim(),
        cpus: Number(output.match(/^CPUS:(\d+)/m)?.[1]) || null, memoryKiB: Number(output.match(/^MEMORY_KIB:(\d+)/m)?.[1]) || null,
        gpuNames: [...output.matchAll(/^GPU:([^\r\n]+)/gm)].map(match => match[1]), tools: [...output.matchAll(/^TOOL:([^\r\n]+)/gm)].map(match => match[1]) };
    }
    if (connection?.type === 'mcp') {
      let client;
      try {
        client = await createMcpClient(config, options);
        const capabilities = client.getServerCapabilities?.() || {};
        const tools = capabilities.tools ? await listMcpTools(client, options.timeoutMs) : [];
        return safeJson({ ok: true, available: true, status: 'connected', checkedAt, message: `MCP handshake succeeded; ${tools.length} tools available.`, capabilities, tools }, integrationSecrets(config, options));
      } finally { await client?.close().catch(() => {}); }
    }
    if (['s3', 'gcs', 'azure'].includes(connection?.type)) {
      await withStorage(connection, options, adapter => adapter.test());
      return { ok: true, available: true, status: 'connected', checkedAt, message: 'Storage bucket/container metadata read succeeded; write access was not tested.' };
    }
    if (connection?.type === 'model') {
      const url = endpointUrl(config.healthUrl || config.url || config.endpoint);
      const response = await (options.fetchImpl || fetch)(url, { method: 'GET', redirect: 'error', headers: authHeaders(config, options.environment || process.env), signal: AbortSignal.timeout(options.timeoutMs || 10000) });
      await response.body?.cancel();
      if (!response.ok) throw new Error(`Model endpoint returned HTTP ${response.status}. Configure a read-only health or models URL; inference was not attempted.`);
      return { ok: true, available: true, status: 'reachable', checkedAt, message: 'Read-only HTTP probe succeeded. Model inference capability has not been tested.' };
    }
    if (connection?.type === 'modal') {
      const command = config.command || 'modal';
      const cli = await (options.runProcess || runProcess)(command, ['--version'], { timeoutMs: 5000 });
      if (cli.code !== 0) throw new Error('Modal CLI is unavailable.');
      const result = await (options.runProcess || runProcess)(command, ['app', 'list', '--json', ...modalEnvironmentArgs(config)], { timeoutMs: 15000, environment: modalEnvironment(config, options.environment) });
      if (result.code !== 0) throw new Error(`Modal account check failed: ${result.stderr}`);
      JSON.parse(result.stdout);
      return { ok: true, available: true, status: 'connected', checkedAt, message: 'Modal CLI authenticated and listed apps. No compute was started.' };
    }
    throw new Error('Unknown connection type. Supported: ssh, mcp, s3, gcs, azure, model, modal.');
  } catch (error) {
    const needsAuthorization = connection?.type === 'mcp' && (error.name === 'UnauthorizedError' || /OAuth authorization required/.test(error.message));
    return { ok: false, available: false, status: needsAuthorization ? 'authorization_required' : 'unavailable', checkedAt,
      message: redact(error.message, [...secrets, ...integrationSecrets(config, options)]).slice(0, 1500) };
  }
}

function mcpAuthFingerprint(config) {
  return createHash('sha256').update(JSON.stringify({ url: config.url, transport: config.transport || 'streamable-http', clientId: config.clientId, clientSecretEnv: config.clientSecretEnv, scope: config.scope })).digest('hex');
}

/** SDK OAuth provider. Tokens, client secrets and PKCE verifiers never leave memory. */
class MemoryMcpOAuthProvider {
  #redirect; #state; #client; #tokens; #verifier; #discovery; #authorizationUrl; #expiresAt; #scope;
  constructor({ redirectUrl, state, config, environment }) {
    const redirect = endpointUrl(redirectUrl);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(redirect.hostname) || redirect.pathname !== '/oauth/callback') throw new Error('MCP OAuth callback must be this application’s loopback /oauth/callback URL.');
    this.#redirect = redirect.href; this.#state = state;
    this.#scope = config.scope ? requiredText(config.scope, 'OAuth scope', 1000) : undefined;
    if (config.clientId) this.#client = { client_id: requiredText(config.clientId, 'OAuth client ID', 512), ...(config.clientSecretEnv ? { client_secret: envValue(config.clientSecretEnv, environment) } : {}) };
    else if (config.clientSecretEnv) throw new Error('OAuth clientSecretEnv requires a registered clientId.');
  }
  get redirectUrl() { return this.#redirect; }
  get clientMetadata() {
    return { client_name: 'ChatGPT Science', redirect_uris: [this.#redirect], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: this.#client?.client_secret ? 'client_secret_post' : 'none', ...(this.#scope ? { scope: this.#scope } : {}) };
  }
  state() { return this.#state; }
  clientInformation() { return this.#client; }
  saveClientInformation(value) { this.#client = value; }
  tokens() { return this.#tokens; }
  saveTokens(value) { this.#tokens = value; this.#expiresAt = value.expires_in ? Date.now() + value.expires_in * 1000 : undefined; }
  hasTokens() { return Boolean(this.#tokens?.access_token); }
  authorizationUrl() { return this.#authorizationUrl; }
  redirectToAuthorization(url) {
    const validated = endpointUrl(String(url), { allowQuery: true });
    if (validated.searchParams.get('state') !== this.#state || validated.searchParams.get('code_challenge_method') !== 'S256' || !validated.searchParams.get('code_challenge')) throw new Error('OAuth provider did not generate the expected state and PKCE S256 challenge.');
    this.#authorizationUrl = validated.href;
  }
  saveCodeVerifier(value) { this.#verifier = value; }
  codeVerifier() { if (!this.#verifier) throw new Error('OAuth verifier unavailable; restart the provider connection.'); return this.#verifier; }
  saveDiscoveryState(value) { this.#discovery = value; }
  discoveryState() { return this.#discovery; }
  invalidateCredentials(scope) {
    if (scope === 'all' || scope === 'client') this.#client = undefined;
    if (scope === 'all' || scope === 'tokens') { this.#tokens = undefined; this.#expiresAt = undefined; }
    if (scope === 'all' || scope === 'verifier') this.#verifier = undefined;
    if (scope === 'all' || scope === 'discovery') this.#discovery = undefined;
  }
  secretValues() { return [this.#tokens?.access_token, this.#tokens?.refresh_token, this.#client?.client_secret, this.#verifier].filter(Boolean); }
  publicStatus() { return { ...(this.#expiresAt ? { expiresAt: new Date(this.#expiresAt).toISOString() } : {}) }; }
}

async function performMcpOAuth(provider, parameters, options) {
  const auth = options.oauthAuth || (await import('@modelcontextprotocol/sdk/client/auth.js')).auth;
  const deadline = AbortSignal.timeout(options.oauthTimeoutMs || 20000);
  const fetchFn = async (input, init = {}) => {
    const url = endpointUrl(String(input), { allowQuery: true });
    const response = await (options.fetchImpl || fetch)(url, { ...init, redirect: 'error', signal: init.signal ? AbortSignal.any([init.signal, deadline]) : deadline });
    // OAuth discovery/registration/token responses are bounded JSON, never SSE streams.
    const body = await limitedBody(response, 1024 * 1024);
    return new Response([204, 205, 304].includes(response.status) ? null : body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
  return auth(provider, { ...parameters, fetchFn });
}

function safeOAuthError(error, stage) {
  const kind = /^[A-Za-z0-9_]{1,80}$/.test(error?.name || '') ? error.name : 'ProviderError';
  // Never echo an OAuth server's response body: it may contain tokens, client secrets or a code.
  return new Error(`MCP OAuth ${stage} failed (${kind}). Check the provider settings; a server without dynamic registration requires its registered clientId. Start a new connection attempt.`);
}

export async function discoverSkills(roots = [], { maxDepth = 3, limit = 1000 } = {}) {
  if (!Array.isArray(roots)) throw new Error('Skill roots must be an explicit array.');
  const results = [], visited = new Set();
  async function visit(directory, root, depth) {
    if (depth > maxDepth || results.length >= limit) return;
    let entries;
    try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch { return; }
    const skill = entries.find(entry => entry.isFile() && entry.name === 'SKILL.md');
    if (skill) {
      const file = path.join(directory, skill.name);
      const stat = await fs.stat(file);
      if (stat.size <= 128 * 1024) {
        const content = await fs.readFile(file, 'utf8');
        const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
        const field = name => frontmatter?.[1].match(new RegExp(`^${name}:\\s*(.*)$`, 'm'))?.[1]?.trim().replace(/^["']|["']$/g, '');
        results.push({ name: (field('name') || path.basename(directory)).slice(0, 120), description: (field('description') || '').slice(0, 1000), path: file, root });
      }
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || ['node_modules', 'work', 'outputs'].includes(entry.name)) continue;
      await visit(path.join(directory, entry.name), root, depth + 1);
    }
  }
  for (const input of roots) {
    let root;
    try {
      if (typeof input !== 'string' || !path.isAbsolute(input)) continue;
      const stat = await fs.lstat(input);
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
      root = await fs.realpath(input);
      if (visited.has(root)) continue;
      visited.add(root);
      await visit(root, root, 0);
    } catch { /* Missing explicit roots are not errors; never expand to a parent directory. */ }
  }
  return results;
}

export async function createSkill({ name, description = '', instructions }, appSkillsRoot) {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name || '')) throw new Error('Skill name must contain lowercase letters, digits and hyphens, at most 64 characters.');
  instructions = requiredText(instructions, 'Skill instructions', 128 * 1024);
  if (typeof description !== 'string' || description.length > 1000) throw new Error('Skill description must be at most 1000 characters.');
  // The caller supplies the server-owned app-local root, never a root from request JSON.
  if (!path.isAbsolute(appSkillsRoot || '')) throw new Error('An absolute app-local skill root is required.');
  await fs.mkdir(appSkillsRoot, { recursive: true });
  if ((await fs.lstat(appSkillsRoot)).isSymbolicLink()) throw new Error('Skill root must not be a symlink.');
  const target = await checkedProjectPath(appSkillsRoot, path.join(name, 'SKILL.md'));
  await fs.mkdir(path.dirname(target), { recursive: false });
  await fs.writeFile(target, `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n---\n\n${instructions}\n`, { flag: 'wx' });
  return { name, description, path: target, root: appSkillsRoot };
}

function modalEnvironment(config, source = process.env) {
  const environment = { ...source };
  if (config.tokenIdEnv || config.tokenSecretEnv) {
    environment.MODAL_TOKEN_ID = envValue(config.tokenIdEnv, source);
    environment.MODAL_TOKEN_SECRET = envValue(config.tokenSecretEnv, source);
  }
  return environment;
}

function modalEnvironmentArgs(config) {
  if (!config.environment) return [];
  if (!SAFE_ALIAS.test(config.environment)) throw new Error('Invalid Modal environment name.');
  return ['--env', config.environment];
}

export class IntegrationManager {
  #oauthProviders = new Map();
  #pendingOAuth = new Map();
  constructor({ projectRoots = {}, connections = [], ...options } = {}) {
    this.projectSource = typeof projectRoots === 'function' ? projectRoots : null;
    this.connectionSource = typeof connections === 'function' ? connections : Array.isArray(connections) ? () => connections : null;
    this.projectRoots = projectRoots instanceof Map ? projectRoots : new Map(typeof projectRoots === 'function' ? [] : Object.entries(projectRoots));
    this.connections = connections instanceof Map ? connections : new Map();
    this.options = options;
    this.jobs = new Map();
  }
  registerProject(id, root) { this.projectRoots.set(id, root); }
  registerConnection(connection) { if (!connection?.id) throw new Error('Connection ID required.'); this.connections.set(connection.id, connection); }
  removeConnection(id) { this.connections.delete(id); this.disconnectMcpOAuth(id); }
  connection(id, type) {
    const source = this.connectionSource?.();
    const connection = this.connections.get(id) || (source instanceof Map ? source.get(id) : source?.find(item => item.id === id));
    if (!connection || (type && connection.type !== type)) throw new Error('Unknown or incompatible saved connection.');
    return connection;
  }
  root(projectId) {
    const root = this.projectEntries().get(projectId);
    if (!root) throw new Error('Unknown registered project.');
    return root;
  }
  projectEntries() {
    const source = this.projectSource?.();
    return new Map([...(source instanceof Map ? source : Object.entries(source || {})), ...this.projectRoots]);
  }
  async jobFile(job, filename, existing = false) {
    this.root(job.projectId);
    const base = this.options.jobsRoot || this.root(job.projectId);
    if (this.options.jobsRoot) await fs.mkdir(base, { recursive: true });
    const relative = this.options.jobsRoot ? path.join(job.id, filename) : path.join('jobs', job.id, filename);
    return checkedProjectPath(base, relative, { existing });
  }
  mcpOptions(id) {
    const connection = this.connection(id), record = this.#oauthProviders.get(id);
    if (record && record.fingerprint !== mcpAuthFingerprint(connection.config || {})) this.disconnectMcpOAuth(id);
    return { ...this.options, authProvider: this.#oauthProviders.get(id)?.provider };
  }
  async testConnection(id) { return testConnection(this.connection(id), this.mcpOptions(id)); }
  async callMcpTool(id, request) { return callMcpTool(this.connection(id, 'mcp'), request, this.mcpOptions(id)); }
  getMcpOAuthStatus(id) {
    this.mcpOptions(id);
    const record = this.#oauthProviders.get(id);
    const pending = [...this.#pendingOAuth.values()].some(item => item.connectionId === id && item.expiresAt > Date.now());
    return { status: record?.provider.hasTokens() ? 'authorized' : pending ? 'pending' : 'disconnected', tokenStorage: 'memory', reconnectOnRestart: true, ...(record?.provider.publicStatus() || {}) };
  }
  disconnectMcpOAuth(id) {
    this.#oauthProviders.get(id)?.provider.invalidateCredentials('all');
    this.#oauthProviders.delete(id);
    for (const [state, pending] of this.#pendingOAuth) if (pending.connectionId === id) this.#pendingOAuth.delete(state);
    return { ok: true, connectionId: id };
  }
  async beginMcpOAuth(id, { redirectUrl }) {
    const connection = this.connection(id, 'mcp'), config = connection.config || {};
    const serverUrl = endpointUrl(config.url);
    if (config.command) throw new Error('OAuth is supported for remote MCP URLs; local commands use explicit environment references.');
    if (config.tokenEnv || config.apiKeyEnv || Object.keys(config.headersEnv || {}).some(name => /^authorization$/i.test(name))) throw new Error('Choose OAuth or an explicit token/API-key environment reference, not both.');
    const state = randomBytes(32).toString('hex');
    const provider = new MemoryMcpOAuthProvider({ redirectUrl, state, config, environment: this.options.environment || process.env });
    for (const [key, pending] of this.#pendingOAuth) if (pending.expiresAt <= Date.now()) this.#pendingOAuth.delete(key);
    this.disconnectMcpOAuth(id);
    const fingerprint = mcpAuthFingerprint(config);
    this.#oauthProviders.set(id, { provider, fingerprint });
    this.#pendingOAuth.set(state, { connectionId: id, fingerprint, expiresAt: Date.now() + 10 * 60 * 1000 });
    try {
      const result = await performMcpOAuth(provider, { serverUrl, scope: config.scope }, this.options);
      if (result !== 'REDIRECT' || !provider.authorizationUrl()) throw new Error('Provider did not return an authorization URL.');
      return { authUrl: provider.authorizationUrl() };
    } catch (error) { this.disconnectMcpOAuth(id); throw safeOAuthError(error, 'initialization'); }
  }
  async completeMcpOAuth({ code, state }) {
    if (typeof state !== 'string' || !/^[a-f0-9]{64}$/.test(state)) throw new Error('Invalid or expired MCP OAuth state.');
    const pending = this.#pendingOAuth.get(state);
    if (!pending || pending.expiresAt <= Date.now()) { this.#pendingOAuth.delete(state); throw new Error('Invalid or expired MCP OAuth state.'); }
    code = requiredText(code, 'OAuth authorization code', 4096);
    this.#pendingOAuth.delete(state); // Single-use even if token exchange fails or the callback is replayed.
    const connection = this.connection(pending.connectionId, 'mcp');
    const record = this.#oauthProviders.get(pending.connectionId);
    if (!record || record.fingerprint !== pending.fingerprint || record.fingerprint !== mcpAuthFingerprint(connection.config || {})) {
      this.disconnectMcpOAuth(pending.connectionId);
      throw new Error('MCP connection settings changed during authorization. Start a new connection attempt.');
    }
    try {
      const result = await performMcpOAuth(record.provider, { serverUrl: endpointUrl(connection.config.url), authorizationCode: code, scope: connection.config.scope }, this.options);
      if (result !== 'AUTHORIZED' || !record.provider.hasTokens()) throw new Error('Provider did not return usable credentials.');
      record.provider.invalidateCredentials('verifier');
      return { ok: true, connectionId: pending.connectionId };
    } catch (error) { this.disconnectMcpOAuth(pending.connectionId); throw safeOAuthError(error, 'token exchange'); }
  }
  async storageList(id, request = {}) { return storageList(this.connection(id), { ...request, ...this.options }); }
  async storageDownload(id, { projectId, ...request }) { return storageDownload(this.connection(id), { ...request, ...this.options, projectRoot: this.root(projectId) }); }
  async storageUpload(id, { projectId, ...request }) { return storageUpload(this.connection(id), { ...request, ...this.options, projectRoot: this.root(projectId) }); }
  async saveJob(job) {
    const file = await this.jobFile(job, 'job.json');
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(job, null, 2), { flag: 'wx' });
    await fs.rename(temporary, file);
    this.jobs.set(job.id, job);
    this.options.onUpdate?.({ type: 'integration-job', job: { ...job } });
    return { ...job };
  }
  async getJob(id) {
    if (!UUID.test(id || '')) throw new Error('Invalid job ID.');
    if (this.jobs.has(id)) return this.jobs.get(id);
    if (this.options.jobsRoot) {
      const file = await checkedProjectPath(this.options.jobsRoot, path.join(id, 'job.json'), { existing: true });
      const job = JSON.parse(await fs.readFile(file, 'utf8'));
      if (job.id !== id || !this.projectEntries().has(job.projectId)) throw new Error('Job refers to an unknown registered project.');
      this.jobs.set(id, job);
      return job;
    }
    for (const [projectId, root] of this.projectEntries()) {
      try {
        const file = await checkedProjectPath(root, path.join('jobs', id, 'job.json'), { existing: true });
        const job = JSON.parse(await fs.readFile(file, 'utf8'));
        if (job.id !== id || job.projectId !== projectId) continue;
        this.jobs.set(id, job);
        return job;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    throw new Error('Unknown job.');
  }
  async listJobs(projectId) {
    if (!projectId && !this.options.jobsRoot) return (await Promise.all([...this.projectEntries().keys()].map(id => this.listJobs(id)))).flat();
    const directory = this.options.jobsRoot || path.join(this.root(projectId), 'jobs');
    let entries;
    try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const jobs = [];
    for (const entry of entries) if (entry.isDirectory() && UUID.test(entry.name)) {
      const job = await this.getJob(entry.name);
      if (!projectId || job.projectId === projectId) jobs.push({ ...job });
    }
    return jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async submitSshJob(connectionId, { projectId, script, timeoutSeconds = 1800, scheduler: requestedScheduler }) {
    const connection = this.connection(connectionId, 'ssh'), config = connection.config || {};
    sshArguments(config.host);
    this.root(projectId);
    script = requiredText(script, 'Job script', 1024 * 1024);
    timeoutSeconds = boundedInteger(timeoutSeconds, 1800, 1, 86400);
    const scheduler = requestedScheduler === 'ssh' ? 'process' : requestedScheduler || config.scheduler || 'process';
    if (!['process', 'slurm'].includes(scheduler)) throw new Error('SSH scheduler must be process or slurm.');
    const slurmFlags = [];
    for (const [key, flag] of [['partition', '--partition'], ['account', '--account'], ['qos', '--qos']]) {
      if (config[key]) { if (!SAFE_ALIAS.test(config[key])) throw new Error(`Invalid Slurm ${key}.`); slurmFlags.push(`${flag}=${config[key]}`); }
    }
    if (config.cpus !== undefined) slurmFlags.push(`--cpus-per-task=${boundedInteger(config.cpus, 1, 1, 4096)}`);
    if (config.memoryMB !== undefined) slurmFlags.push(`--mem=${boundedInteger(config.memoryMB, 1024, 128, 1000000000)}M`);
    if (config.gpus !== undefined) slurmFlags.push(`--gpus=${boundedInteger(config.gpus, 1, 1, 1024)}`);
    const id = randomUUID(), createdAt = new Date().toISOString();
    const job = { id, projectId, connectionId, provider: 'ssh', host: config.host, scheduler, status: 'submitting', timeoutSeconds, createdAt };
    await this.saveJob(job);
    const localScript = await this.jobFile(job, 'task.sh');
    await fs.writeFile(localScript, script, { flag: 'wx' });
    const encoded = Buffer.from(script).toString('base64');
    const runner = '#!/bin/sh\ncd "$1" || exit 125\ntimeout --signal=TERM --kill-after=10s ' + timeoutSeconds + 's sh ./task.sh >stdout.log 2>stderr.log\nresult=$?\nprintf "%s\\n" "$result" >exit.code\nexit "$result"\n';
    const runner64 = Buffer.from(runner).toString('base64');
    const launch = scheduler === 'slurm'
      ? `command -v sbatch >/dev/null || exit 125\nremote_id=$(sbatch --parsable --job-name=science-${id} --time=${Math.ceil(timeoutSeconds / 60)} ${slurmFlags.join(' ')} --output="$job_dir/slurm.log" --error="$job_dir/slurm.err" "$job_dir/runner.sh" "$job_dir") || exit $?\nprintf '%s\\n' "$remote_id" > "$job_dir/scheduler.id"\nprintf 'SCIENCE_JOB:%s\\n' "$remote_id"\n`
      : `command -v setsid >/dev/null || exit 125\nnohup setsid sh "$job_dir/runner.sh" "$job_dir" </dev/null >"$job_dir/launch.log" 2>&1 &\nremote_id=$!\nprintf '%s\\n' "$remote_id" > "$job_dir/process.id"\nprintf 'SCIENCE_JOB:%s\\n' "$remote_id"\n`;
    const input = `set -eu\numask 077\ncommand -v timeout >/dev/null || exit 125\njob_dir="$HOME/.science-workbench/jobs/${id}"\nmkdir -p "$job_dir"\nprintf '%s' '${encoded}' | base64 -d > "$job_dir/task.sh"\nprintf '%s' '${runner64}' | base64 -d > "$job_dir/runner.sh"\n${launch}`;
    try {
      const output = await sshExecute(config, input, this.options);
      const remoteId = output.match(/^SCIENCE_JOB:(\d+)(?:;[^\r\n]+)?$/m)?.[1];
      if (!remoteId) throw new Error('Remote submission returned no verifiable job identifier.');
      job.remoteId = remoteId;
      job.status = 'submitted';
      return this.saveJob(job);
    } catch (error) {
      job.status = 'unknown'; // An interrupted submission may already have started remote work; never auto-retry.
      job.error = redact(error.message, referencedSecrets(config, this.options.environment));
      await this.saveJob(job);
      throw new Error(`Job ${id} submission could not be confirmed. Inspect the job before retrying: ${job.error}`);
    }
  }
  async statusSshJob(id) {
    const job = await this.getJob(id);
    if (job.provider !== 'ssh') throw new Error('Not an SSH job.');
    const connection = this.connection(job.connectionId, 'ssh');
    if (connection.config.host !== job.host) throw new Error('Saved connection host changed; restore the original host to inspect this job.');
    if (job.remoteId && !/^\d{1,20}$/.test(job.remoteId)) throw new Error('Invalid saved remote job identifier.');
    const check = job.scheduler === 'slurm'
      ? `if [ -f "$job_dir/scheduler.id" ]; then remote_id=$(cut -d';' -f1 "$job_dir/scheduler.id"); case "$remote_id" in ''|*[!0-9]*) exit 125;; esac; printf 'REMOTE:%s\\n' "$remote_id"; state=$(squeue -h -j "$remote_id" -o %T 2>/dev/null | head -n 1 || true); printf 'STATE:%s\\n' "$state"; fi`
      : `if [ -f "$job_dir/process.id" ]; then remote_id=$(cat "$job_dir/process.id"); case "$remote_id" in ''|*[!0-9]*) exit 125;; esac; printf 'REMOTE:%s\\n' "$remote_id"; if [ -r "/proc/$remote_id/cmdline" ] && tr '\\0' ' ' < "/proc/$remote_id/cmdline" | grep -F -- "$job_dir/runner.sh" >/dev/null; then printf 'STATE:RUNNING\\n'; fi; fi`;
    const input = `set -eu\njob_dir="$HOME/.science-workbench/jobs/${job.id}"\nif [ ! -d "$job_dir" ]; then printf 'STATE:MISSING\\n'; exit 0; fi\n${check}\nif [ -f "$job_dir/exit.code" ]; then printf 'EXIT:%s\\n' "$(cat "$job_dir/exit.code")"; fi\nif [ -f "$job_dir/cancel.requested" ]; then printf 'CANCEL:1\\n'; fi\nfor file in stdout stderr; do printf 'LOG_%s:' "$file"; if [ -f "$job_dir/$file.log" ]; then tail -c ${MAX_LOG} "$job_dir/$file.log" | base64 | tr -d '\\n'; fi; printf '\\n'; done\n`;
    const output = await sshExecute(connection.config, input, this.options);
    const remoteId = output.match(/^REMOTE:(\d+)$/m)?.[1];
    if (remoteId) job.remoteId = remoteId;
    const exit = output.match(/^EXIT:(\d+)$/m)?.[1], state = output.match(/^STATE:([^\r\n]*)$/m)?.[1];
    const cancellation = /^CANCEL:1$/m.test(output);
    if (exit !== undefined) {
      job.exitCode = Number(exit);
      job.status = cancellation ? 'cancelled' : Number(exit) === 0 ? 'completed' : [124, 137].includes(Number(exit)) ? 'timed_out' : 'failed';
      job.endedAt ||= new Date().toISOString();
    } else if (state === 'RUNNING' || state === 'COMPLETING') job.status = cancellation ? 'cancelling' : 'running';
    else if (['PENDING', 'CONFIGURING', 'SUSPENDED'].includes(state)) job.status = cancellation ? 'cancelling' : 'queued';
    else if (cancellation) { job.status = 'cancelled'; job.endedAt ||= new Date().toISOString(); }
    else if (!TERMINAL.has(job.status)) job.status = 'unknown';
    const secrets = referencedSecrets(connection.config, this.options.environment);
    for (const stream of ['stdout', 'stderr']) {
      const encoded = output.match(new RegExp(`^LOG_${stream}:([A-Za-z0-9+/=]*)$`, 'm'))?.[1] || '';
      const text = redact(Buffer.from(encoded, 'base64').toString('utf8'), secrets);
      job[stream] = text;
      const file = await this.jobFile(job, `${stream}.log`);
      await fs.writeFile(file, text);
    }
    job.checkedAt = new Date().toISOString();
    return this.saveJob(job);
  }
  async cancelSshJob(id) {
    const job = await this.getJob(id);
    if (job.provider !== 'ssh') throw new Error('Not an SSH job.');
    if (TERMINAL.has(job.status)) return { ...job };
    const connection = this.connection(job.connectionId, 'ssh');
    if (connection.config.host !== job.host) throw new Error('Saved connection host changed.');
    // IDs are read from this app's UUID-scoped remote directory, never from caller-supplied text.
    const cancel = job.scheduler === 'slurm'
      ? `remote_id=$(cut -d';' -f1 "$job_dir/scheduler.id"); case "$remote_id" in ''|*[!0-9]*) exit 125;; esac; name=$(squeue -h -j "$remote_id" -o %j); if [ "$name" != "science-${job.id}" ]; then printf 'Job ownership could not be verified' >&2; exit 125; fi; scancel "$remote_id"`
      : 'remote_id=$(cat "$job_dir/process.id"); case "$remote_id" in \'\'|*[!0-9]*) exit 125;; esac; if [ -r "/proc/$remote_id/cmdline" ] && tr \'\\0\' \' \' < "/proc/$remote_id/cmdline" | grep -F -- "$job_dir/runner.sh" >/dev/null; then /bin/kill -TERM -- "-$remote_id"; else printf \'Job process ownership could not be verified\' >&2; exit 125; fi';
    await sshExecute(connection.config, `set -eu\njob_dir="$HOME/.science-workbench/jobs/${job.id}"\nif [ -f "$job_dir/exit.code" ]; then exit 0; fi\n${cancel}\nprintf 'requested\\n' > "$job_dir/cancel.requested"\n`, this.options);
    job.status = 'cancelling';
    await this.saveJob(job);
    return this.statusSshJob(id);
  }
  async submitModalJob(connectionId, { projectId, script, functionName, timeoutSeconds = 1800 }) {
    const connection = this.connection(connectionId, 'modal'), config = connection.config || {};
    script = requiredText(script, 'Modal Python script', 1024 * 1024);
    if (functionName && !/^[A-Za-z_][A-Za-z0-9_.]{0,127}$/.test(functionName)) throw new Error('Invalid Modal function reference.');
    timeoutSeconds = boundedInteger(timeoutSeconds, 1800, 1, 86400);
    const id = randomUUID(), job = { id, projectId, connectionId, provider: 'modal', name: `science-${id}`, status: 'submitting', timeoutSeconds, createdAt: new Date().toISOString(), stdout: '', stderr: '' };
    const environment = modalEnvironment(config, this.options.environment);
    await this.saveJob(job);
    const file = await this.jobFile(job, 'task.py');
    await fs.writeFile(file, script, { flag: 'wx' });
    const secrets = referencedSecrets(config, this.options.environment);
    const args = ['run', '--detach', '--name', job.name, ...modalEnvironmentArgs(config), `${file}${functionName ? `::${functionName}` : ''}`];
    // The user's supplied Python is executed only after this explicit submit call. --detach means local timeout does not prove remote termination.
    const promise = (this.options.runProcess || runProcess)(config.command || 'modal', args, {
      cwd: path.dirname(file), environment, timeoutMs: timeoutSeconds * 1000,
      onOutput: (stream, text) => { job[stream] = (job[stream] + redact(text, secrets)).slice(-MAX_LOG); const app = text.match(/\bap-[A-Za-z0-9]+\b/); if (app) job.remoteId = app[0]; },
    });
    job.status = 'submitted';
    await this.saveJob(job);
    promise.then(async result => {
      job.stdout = redact(result.stdout, secrets).slice(-MAX_LOG); job.stderr = redact(result.stderr, secrets).slice(-MAX_LOG);
      job.remoteId ||= `${result.stdout}\n${result.stderr}`.match(/\bap-[A-Za-z0-9]+\b/)?.[0];
      job.exitCode = result.code;
      if (job.cancelRequested) job.status = 'cancelling';
      else job.status = result.code === 0 ? 'completed' : 'unknown';
      if (job.status === 'completed') job.endedAt = new Date().toISOString();
      await this.saveJob(job);
    }).catch(async error => { if (!job.cancelRequested) job.status = 'unknown'; job.error = redact(error.message, secrets); await this.saveJob(job); }).catch(() => {});
    return { ...job };
  }
  async statusModalJob(id) {
    const job = await this.getJob(id);
    if (job.provider !== 'modal') throw new Error('Not a Modal job.');
    const connection = this.connection(job.connectionId, 'modal'), config = connection.config || {};
    const result = await (this.options.runProcess || runProcess)(config.command || 'modal', ['app', 'list', '--json', ...modalEnvironmentArgs(config)], { timeoutMs: 15000, environment: modalEnvironment(config, this.options.environment) });
    if (result.code !== 0) throw new Error(redact(result.stderr || 'Modal app listing failed.', referencedSecrets(config, this.options.environment)));
    const list = JSON.parse(result.stdout);
    if (!Array.isArray(list)) throw new Error('Modal returned an unexpected app list.');
    const app = list.find(item => (item.name || item.description || item.Description) === job.name || (job.remoteId && (item.app_id || item['App ID'] || item.id) === job.remoteId));
    if (app) {
      const appId = app.app_id || app['App ID'] || app.id;
      if (/^ap-[A-Za-z0-9]+$/.test(appId || '')) job.remoteId = appId;
      const state = String(app.state || app.State || '').toLowerCase();
      job.remoteState = state;
      if (/running|ephemeral|initializ/.test(state)) job.status = 'running';
      else if (/stopped|stopping/.test(state) && job.cancelRequested) job.status = state === 'stopping' ? 'cancelling' : 'cancelled';
      else if (!TERMINAL.has(job.status)) job.status = 'unknown'; // stopped does not prove scientific success.
    } else if (!TERMINAL.has(job.status)) job.status = 'unknown';
    job.checkedAt = new Date().toISOString();
    return this.saveJob(job);
  }
  async cancelModalJob(id) {
    let job = await this.getJob(id);
    if (job.provider !== 'modal') throw new Error('Not a Modal job.');
    if (TERMINAL.has(job.status)) return { ...job };
    if (!job.remoteId) job = await this.statusModalJob(id);
    if (!/^ap-[A-Za-z0-9]+$/.test(job.remoteId || '')) throw new Error('Modal app ID is not yet known. Inspect status before cancellation.');
    const connection = this.connection(job.connectionId, 'modal'), config = connection.config || {};
    const result = await (this.options.runProcess || runProcess)(config.command || 'modal', ['app', 'stop', '--yes', ...modalEnvironmentArgs(config), job.remoteId], { timeoutMs: 15000, environment: modalEnvironment(config, this.options.environment) });
    if (result.code !== 0) throw new Error(redact(result.stderr || 'Modal cancellation failed.', referencedSecrets(config, this.options.environment)));
    job.cancelRequested = true; job.status = 'cancelling';
    return this.saveJob(job);
  }
}
