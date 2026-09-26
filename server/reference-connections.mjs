import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const text = (value, label, max = 10000, empty = false) => {
  if (typeof value !== 'string' || value.length > max || value.includes('\0') || (!empty && !value.trim())) throw fail(`${label} is invalid.`);
  return value;
};
const boolean = (value, label) => { if (typeof value !== 'boolean') throw fail(`${label} must be a boolean.`); return value; };
const own = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);
const encode = encodeURIComponent;
const stamp = () => new Date().toISOString();
const settings = store => store.data.settings.referenceConnections || {};
const categories = store => settings(store).memoryCategories || [];
const memoryEntity = item => item.entity || (item.projectId ? `project:${item.projectId}` : 'profile');

/** Policy consumed by the model tool dispatcher; never infer permission from OAuth. */
export function referenceConnectorPolicy(connection, toolName, agentName = 'ChatGPT') {
  const reference = connection.reference || {}, base = connection.config?.agentAccess || 'ask';
  if (reference.enabled === false || base === 'block') return 'block';
  if (Array.isArray(reference.attachedAgents) && !reference.attachedAgents.includes(agentName) && !reference.attachedAgents.includes('*')) return 'block';
  const excluded = reference.excludedTools?.[agentName] || [];
  if (excluded.includes(toolName) || excluded.includes(`mcp_${connection.name}_${toolName}`)) return 'block';
  const decision = reference.toolGrants?.[toolName];
  if (decision === 'deny') return 'block';
  if (base === 'read') return 'read';
  return decision === 'allow' ? 'allow' : decision === 'ask' ? 'ask' : base;
}

/** Records actually eligible for model recall, scoped to the owned project/session. */
export function referenceMemoryContext(store, projectId, sessionId) {
  if (settings(store).memoryEnabled === false) return [];
  const byCategory = new Map(categories(store).map(item => [item.id, item]));
  return store.data.memories.filter(item => {
    const entity = memoryEntity(item), category = byCategory.get(item.categoryId);
    if (category?.auto_recall === false) return false;
    if (entity === 'profile') return true;
    if (entity === `project:${projectId}`) return true;
    if (sessionId && entity === `session:${sessionId}`) return true;
    if (entity.startsWith('artifact:')) return store.data.artifacts.some(a => a.id === entity.slice(9) && a.projectId === projectId);
    return false;
  });
}

function publicMemory(item) {
  const entity = memoryEntity(item);
  return { id: item.id, body: item.text, text: item.text, entity, categoryId: item.categoryId || null,
    evidence: item.evidence || '', origin: item.origin || 'user', createdAt: item.createdAt, updatedAt: item.updatedAt || item.createdAt,
    subjectProjectId: entity.startsWith('project:') ? entity.slice(8) : null,
    subjectArtifactId: entity.startsWith('artifact:') ? entity.slice(9) : null,
    subjectFrameId: entity.startsWith('session:') ? entity.slice(8) : null };
}

export function mountReferenceConnections(router, ctx) {
  const { store } = ctx;
  const change = (kind, operation) => { const result = store.update(operation); ctx.notify?.(kind); return result; };
  const preference = patch => change('reference/preferences', data => { data.settings.referenceConnections = { ...settings(store), ...patch }; });
  const connection = id => { const item = store.data.connections.find(c => c.id === id && c.type === 'mcp'); if (!item) throw fail('MCP connector not found.', 404); return item; };
  const call = (method, route, body) => ctx.call(method, route, body);
  const croute = (id, suffix = '') => `/api/connections/${encode(id)}${suffix}`;
  const metadata = (id, patch) => change('connection/updated', () => { const item = connection(id); item.reference = { ...(item.reference || {}), ...patch }; return item; });
  const project = id => { const item = store.data.projects.find(p => p.id === id); if (!item) throw fail('Project not found.', 404); return item; };
  const session = id => { const item = store.data.sessions.find(s => s.id === id); if (!item) throw fail('Conversation not found.', 404); return item; };
  const attachNames = names => {
    if (!Array.isArray(names) || names.length > 100 || names.some(n => typeof n !== 'string' || !n || n.length > 100)) throw fail('Agent names must be a bounded array.');
    return [...new Set(names)];
  };
  const describe = async item => {
    const config = item.config || {}, reference = item.reference || {};
    const oauth = config.authMode === 'oauth' ? await call('GET', croute(item.id, '/oauth')) : null;
    const authorized = oauth?.status === 'authorized', required = config.authMode === 'oauth';
    const tested = item.lastTest?.ok === true, failed = item.lastTest?.ok === false;
    return { id: item.id, name: item.name, displayName: reference.displayName || item.name, description: reference.description || '',
      url: config.url || null, command: config.command || null, args: config.args || [], transport: config.command ? 'stdio' : (config.transport || 'streamable-http'),
      source: config.command ? 'local-stdio' : 'custom', enabled: reference.enabled !== false, attachedAgents: reference.attachedAgents || ['ChatGPT'],
      authState: required ? authorized ? 'authorized' : 'unauthorized' : tested ? 'not-required' : 'unauthorized',
      connectionStatus: required && !authorized ? 'auth_required' : failed ? 'error' : tested ? 'connected' : 'disconnected',
      is_connected: tested && (!required || authorized), health: item.lastTest ? { ok: tested, error: failed ? item.lastTest.error || item.lastTest.message || 'Connection failed.' : null, checkedAt: item.lastTest.at } : null,
      connectionError: failed ? item.lastTest.error || item.lastTest.message || 'Connection failed.' : null, tools: item.lastTest?.tools || [], oauth_server_url: null,
      client_id: config.clientId || null, scopes: config.scope || null, headers_helper: null, created_at: item.createdAt };
  };
  const all = () => store.data.connections.filter(c => c.type === 'mcp');
  const connectorInput = (body, previous = null) => {
    if (!object(body)) throw fail('Connector settings must be an object.');
    if (body.headers_helper || body.headersHelper) throw fail('Header-helper commands are not supported. Configure an explicit environment credential reference in connection settings.', 422);
    if (body.oauth_server_url || body.oauthServerUrl) throw fail('Custom OAuth issuer overrides are not supported; this client uses the MCP server metadata.', 422);
    const config = { ...(previous?.config || {}), agentAccess: previous?.config?.agentAccess || 'ask' };
    if (own(body, 'url')) {
      let url; try { url = new URL(text(body.url, 'MCP URL', 4096)); } catch { throw fail('MCP URL is invalid.'); }
      if (url.username || url.password || url.hash || !(['https:'].includes(url.protocol) || url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw fail('Use HTTPS or a loopback HTTP MCP URL without embedded credentials.');
      config.url = url.href; delete config.command; delete config.args;
    }
    if (own(body, 'transport')) {
      const transport = body.transport === 'http' ? 'streamable-http' : body.transport;
      if (!['streamable-http', 'sse'].includes(transport)) throw fail('Unsupported remote MCP transport.');
      config.transport = transport;
    }
    if (own(body, 'command')) {
      config.command = text(body.command, 'MCP executable', 1024);
      if (/[\r\n]/.test(config.command) || /\.(cmd|bat|ps1)$/i.test(config.command)) throw fail('Use an executable directly, not a shell script.');
      if (!Array.isArray(body.args || []) || (body.args || []).length > 64 || (body.args || []).some(a => typeof a !== 'string' || a.length > 4096 || a.includes('\0'))) throw fail('MCP arguments are invalid.');
      config.args = body.args || []; delete config.url; delete config.transport;
      if (body.env && Object.keys(body.env).length) throw fail('Inline environment secrets are not stored. Use envRefs with existing environment variable names.', 422);
      if (body.envRefs) config.envRefs = body.envRefs;
    }
    for (const [source, dest] of [['client_id', 'clientId'], ['scopes', 'scope']]) if (own(body, source)) { if (body[source]) config[dest] = text(body[source], source, 1000); else delete config[dest]; }
    if (config.clientId || config.scope) config.authMode = 'oauth';
    if (!config.url && !config.command) throw fail('A URL or local executable is required.');
    return { name: own(body, 'name') ? text(body.name, 'Name', 100).trim() : previous?.name, type: 'mcp', config };
  };
  const testConnector = async id => {
    connection(id);
    try { const result = await call('POST', croute(id, '/test'), {}); if (result.ok !== true) throw fail(result.error || result.message || 'MCP connection failed.', result.status === 'authorization_required' ? 401 : 502); return result; }
    catch (error) { change('connection/tested', () => { connection(id).lastTest = { ok: false, error: error.message, at: stamp() }; }); throw error; }
  };
  const authorize = async (id, res, redirect = false) => {
    const item = connection(id);
    if (item.config?.command) { await testConnector(id); return res.json(await describe(connection(id))); }
    if (item.config?.authMode !== 'oauth') {
      try { await testConnector(id); return res.json(await describe(connection(id))); }
      catch (error) { if (error.status !== 401 && !/401|403|unauthori[sz]ed|oauth|auth.*required/i.test(error.message)) throw error; }
    }
    const result = await call('POST', croute(id, '/oauth/start'), {});
    return redirect ? res.redirect(302, result.authUrl) : res.json({ ...result, authorizationUrl: result.authUrl, url: result.authUrl });
  };

  router.get('/mcp-servers/connectors', async (_req, res) => res.json(await Promise.all(all().map(describe))));
  router.get('/mcp-servers/directory-health', (_req, res) => res.json({ directoryHealth: { ok: false, available: false, error: 'No vendor connector directory is configured. Add a custom MCP server.' } }));
  router.get('/mcp-servers/attachment-counts', (_req, res) => {
    const counts = {}; for (const item of all()) for (const agent of item.reference?.attachedAgents || ['ChatGPT']) counts[agent] = (counts[agent] || 0) + 1;
    res.json(counts);
  });
  router.post('/mcp-servers/reconcile', async (_req, res) => res.json({ connectors: await Promise.all(all().map(describe)), reconciled: true }));
  router.get('/mcp-servers', async (_req, res) => res.json(await Promise.all(all().map(describe))));
  const create = async (req, res) => {
    const result = await call('POST', '/api/connections', connectorInput(req.body));
    metadata(result.id, { description: req.body.description ? text(req.body.description, 'Description', 2000) : '', enabled: true, attachedAgents: ['ChatGPT'] });
    res.json(await describe(connection(result.id)));
  };
  router.post('/mcp-servers', create);
  router.post('/mcp-servers/local', create);
  router.post('/mcp-servers/directory', (_req, _res, next) => next(fail('Vendor connector IDs cannot be resolved by this independent app. Add the actual MCP URL as a custom connector.', 422)));
  const remove = async (req, res) => { connection(req.params.id); res.json(await call('DELETE', croute(req.params.id))); };
  router.delete('/mcp-servers/local/:id', remove);
  router.get('/mcp-servers/:id', async (req, res) => res.json(await describe(connection(req.params.id))));
  router.patch('/mcp-servers/:id', async (req, res) => {
    const previous = connection(req.params.id), input = connectorInput(req.body, previous);
    await call('PATCH', croute(previous.id), input);
    if (own(req.body, 'description')) metadata(previous.id, { description: text(req.body.description || '', 'Description', 2000, true) });
    res.json(await describe(connection(previous.id)));
  });
  router.delete('/mcp-servers/:id', remove);
  router.post('/mcp-servers/:id/test', async (req, res) => res.json(await testConnector(req.params.id)));
  router.put('/mcp-servers/connectors/:id/enabled', async (req, res) => { metadata(req.params.id, { enabled: boolean(req.body.enabled, 'Enabled') }); res.json(await describe(connection(req.params.id))); });
  router.get('/mcp-servers/:id/oauth/status', async (req, res) => {
    const item = connection(req.params.id), result = await call('GET', croute(item.id, '/oauth'));
    res.json({ ...result, authorized: result.status === 'authorized', is_authorized: result.status === 'authorized' });
  });
  router.get('/mcp-servers/:id/oauth/authorize', async (req, res) => authorize(req.params.id, res, true));
  router.post('/mcp-servers/connectors/:id/authorize', async (req, res) => authorize(req.params.id, res));
  const disconnect = async (req, res) => { connection(req.params.id); const result = await call('POST', croute(req.params.id, '/oauth/disconnect'), {}); change('connection/updated', () => { delete connection(req.params.id).lastTest; }); res.json(result); };
  router.delete('/mcp-servers/:id/oauth/disconnect', disconnect);
  router.post('/mcp-servers/connectors/:id/disconnect', disconnect);
  router.post('/mcp-servers/:id/attach', async (req, res) => { const item = connection(req.params.id); metadata(item.id, { attachedAgents: attachNames([...(item.reference?.attachedAgents || ['ChatGPT']), ...attachNames(req.body.agent_names)]) }); res.json(await describe(connection(item.id))); });
  router.post('/mcp-servers/:id/attach-all', async (req, res) => { metadata(req.params.id, { attachedAgents: ['*', 'ChatGPT'] }); res.json(await describe(connection(req.params.id))); });
  router.delete('/mcp-servers/:id/detach-all', async (req, res) => { metadata(req.params.id, { attachedAgents: [] }); res.json(await describe(connection(req.params.id))); });
  router.delete('/mcp-servers/:id/agents/:agent', async (req, res) => { const item = connection(req.params.id); metadata(item.id, { attachedAgents: (item.reference?.attachedAgents || ['ChatGPT']).filter(a => a !== req.params.agent && a !== '*') }); res.json(await describe(connection(item.id))); });
  router.get('/agents/:agent/mcp-servers', async (req, res) => res.json(await Promise.all(all().filter(c => referenceConnectorPolicy(c, undefined, req.params.agent) !== 'block').map(describe))));
  router.get('/mcp-servers/:id/tool-grants', (req, res) => res.json(Object.entries(connection(req.params.id).reference?.toolGrants || {}).map(([toolName, decision]) => ({ toolName, decision }))));
  router.get('/mcp-servers/:id/tool-permissions', async (req, res) => {
    const item = connection(req.params.id);
    res.json({ tools: (item.lastTest?.tools || []).map(tool => ({ ...tool, toolName: tool.name, state: item.reference?.toolGrants?.[tool.name] || 'ask' })), skipApprovalsActive: false, discoveryRequired: !item.lastTest?.ok });
  });
  router.post('/mcp-servers/:id/tool-grants', (req, res) => {
    const item = connection(req.params.id), name = text(req.body.toolName, 'Tool name', 200), decision = req.body.decision;
    if (!['allow', 'ask', 'deny'].includes(decision)) throw fail('Tool decision must be allow, ask or deny.');
    if (!(item.lastTest?.tools || []).some(t => t.name === name)) throw fail('Discover this connector tool before granting permission.', 409);
    metadata(item.id, { toolGrants: { ...(item.reference?.toolGrants || {}), [name]: decision } });
    res.json({ toolName: name, decision });
  });

  const validateEntity = entity => {
    if (entity === 'profile') return { entity, projectId: null };
    text(entity, 'Memory entity', 200);
    if (entity.startsWith('project:')) { const p = project(entity.slice(8)); return { entity, projectId: p.id }; }
    if (entity.startsWith('session:')) { const s = session(entity.slice(8)); return { entity, projectId: s.projectId, sessionId: s.id }; }
    if (entity.startsWith('artifact:')) { const a = store.data.artifacts.find(a => a.id === entity.slice(9)); if (!a) throw fail('Artifact not found.', 404); return { entity, projectId: a.projectId, artifactId: a.id }; }
    throw fail('Memory entity must identify the profile, a project, a conversation or an artifact.');
  };
  const categoryId = value => {
    if (!value) return null;
    const item = categories(store).find(c => c.id === value || c.name === value);
    if (!item) throw fail('Memory category not found.', 404);
    return item.id;
  };
  const memory = id => { const item = store.data.memories.find(m => m.id === id); if (!item) throw fail('Memory not found.', 404); return item; };
  router.get('/memory/enabled', (_req, res) => res.json({ enabled: settings(store).memoryEnabled !== false }));
  const setMemoryEnabled = (req, res) => { const enabled = boolean(req.body.enabled, 'Memory enabled'); preference({ memoryEnabled: enabled }); res.json({ enabled }); };
  router.put('/memory/enabled', setMemoryEnabled); router.post('/memory/enabled', setMemoryEnabled);
  router.get('/memory/context', (req, res) => {
    if (req.query.project_id) project(req.query.project_id);
    const rows = store.data.memories.filter(m => !req.query.project_id || !m.projectId || m.projectId === req.query.project_id);
    const groups = new Map([['profile', { entity_key: 'profile', label: 'About you', project_id: null, rows: [] }]]), sessions = new Map();
    for (const item of rows) {
      const entity = memoryEntity(item), row = publicMemory(item);
      if (entity.startsWith('session:')) {
        const s = store.data.sessions.find(s => s.id === entity.slice(8)); if (!s) continue;
        let group = sessions.get(s.id); if (!group) { group = { frame_id: s.id, project_id: s.projectId, label: s.title || 'Conversation', row_count: 0, newest_at: '' }; sessions.set(s.id, group); }
        group.row_count++; group.newest_at = group.newest_at > row.updatedAt ? group.newest_at : row.updatedAt;
      } else {
        let group = groups.get(entity);
        if (!group) { const resource = entity.startsWith('project:') ? store.data.projects.find(p => p.id === entity.slice(8)) : store.data.artifacts.find(a => a.id === entity.slice(9)); group = { entity_key: entity, label: resource?.name || entity, project_id: item.projectId || null, rows: [] }; groups.set(entity, group); }
        group.rows.push(row);
      }
    }
    res.json({ entities: [...groups.values()], sessions: [...sessions.values()], categories: categories(store), total_user_rows: rows.filter(m => !m.origin || m.origin === 'user').length, use_case_tag_programs: [] });
  });
  router.get('/memories', (req, res) => {
    const q = req.query.q === undefined ? '' : text(req.query.q, 'Memory query', 1000, true).toLowerCase();
    res.json(store.data.memories.filter(m => (!req.query.project_id || m.projectId === req.query.project_id) && (!q || `${m.text}\n${m.evidence || ''}`.toLowerCase().includes(q))).map(publicMemory));
  });
  router.post('/memories', (req, res) => {
    const body = req.body || {}, entity = body.entity || (body.projectId ? `project:${body.projectId}` : 'profile');
    const item = { id: randomUUID(), ...validateEntity(entity), text: text(body.text, 'Memory text'), evidence: body.evidence === undefined ? '' : text(body.evidence, 'Memory evidence', 10000, true), categoryId: categoryId(body.category), origin: 'user', createdAt: stamp(), updatedAt: stamp() };
    change('memory/created', data => data.memories.push(item)); res.json(publicMemory(item));
  });
  router.put('/memories/:id', (req, res) => {
    const item = memory(req.params.id), patch = {};
    if (own(req.body, 'text')) patch.text = text(req.body.text, 'Memory text');
    if (own(req.body, 'evidence')) patch.evidence = text(req.body.evidence, 'Memory evidence', 10000, true);
    if (own(req.body, 'category')) patch.categoryId = categoryId(req.body.category);
    change('memory/updated', () => Object.assign(item, patch, { updatedAt: stamp() })); res.json(publicMemory(item));
  });
  router.delete('/memories/:id', (req, res) => { memory(req.params.id); change('memory/deleted', data => { data.memories = data.memories.filter(m => m.id !== req.params.id); }); res.json({ ok: true }); });
  router.delete('/memories', (_req, res) => { const deleted = store.data.memories.length; change('memory/deleted', data => { data.memories = []; }); res.json({ ok: true, deleted }); });
  router.get('/memory/sessions/:id', (req, res) => { session(req.params.id); res.json(store.data.memories.filter(m => memoryEntity(m) === `session:${req.params.id}`).map(publicMemory)); });
  router.delete('/memory/sessions/:id', (req, res) => { session(req.params.id); change('memory/deleted', data => { data.memories = data.memories.filter(m => memoryEntity(m) !== `session:${req.params.id}`); }); res.json({ ok: true }); });
  router.post('/memory/categories', (req, res) => {
    if (categories(store).length >= 10) throw fail('At most 10 memory categories are supported.');
    const item = { id: randomUUID(), name: text(req.body.name, 'Category name', 100).trim(), guidance: text(req.body.guidance, 'Category guidance', 2000), auto_recall: req.body.auto_recall === undefined ? true : boolean(req.body.auto_recall, 'Auto recall') };
    if (categories(store).some(c => c.name.toLowerCase() === item.name.toLowerCase())) throw fail('A category already has that name.', 409);
    preference({ memoryCategories: [...categories(store), item] }); res.json(item);
  });
  router.put('/memory/categories/:id', (req, res) => {
    const found = categories(store).find(c => c.id === req.params.id); if (!found) throw fail('Category not found.', 404);
    const item = { ...found };
    if (own(req.body, 'name')) { item.name = text(req.body.name, 'Category name', 100).trim(); if (categories(store).some(c => c.id !== item.id && c.name.toLowerCase() === item.name.toLowerCase())) throw fail('A category already has that name.', 409); }
    if (own(req.body, 'guidance')) item.guidance = text(req.body.guidance, 'Category guidance', 2000);
    if (own(req.body, 'auto_recall')) item.auto_recall = boolean(req.body.auto_recall, 'Auto recall');
    preference({ memoryCategories: categories(store).map(c => c.id === item.id ? item : c) }); res.json(item);
  });
  router.delete('/memory/categories/:id', (req, res) => {
    if (!categories(store).some(c => c.id === req.params.id)) throw fail('Category not found.', 404);
    if (req.query.delete_facts !== undefined && !['true', 'false'].includes(req.query.delete_facts)) throw fail('delete_facts must be true or false.');
    change('memory/deleted', data => {
      data.settings.referenceConnections = { ...settings(store), memoryCategories: categories(store).filter(c => c.id !== req.params.id) };
      if (req.query.delete_facts === 'true') data.memories = data.memories.filter(m => m.categoryId !== req.params.id);
      else for (const item of data.memories) if (item.categoryId === req.params.id) item.categoryId = null;
    }); res.json({ ok: true });
  });

  const skills = async () => {
    const all = await call('GET', '/api/skills');
    const unique = new Map();
    for (const item of all) {
      const local = path.resolve(item.root) === path.resolve(store.dataRoot, 'skills');
      if (!unique.has(item.name) || local) unique.set(item.name, { ...item, displayName: item.name, source: local ? 'user' : 'local', enabled: true, readOnly: !local, fileCount: 1 });
    }
    return [...unique.values()];
  };
  const skill = async name => { const result = (await skills()).find(s => s.name === name); if (!result) throw fail('Skill not found.', 404); return result; };
  const skillFile = (item, relative = 'SKILL.md') => {
    text(relative, 'Skill file path', 1000);
    if (path.isAbsolute(relative) || relative.split(/[\\/]/).some(p => p === '..' || p.includes(':'))) throw fail('Skill file must remain within this skill folder.');
    const root = path.dirname(item.path), file = path.resolve(root, relative), sub = path.relative(root, file);
    if (sub.startsWith('..') || path.isAbsolute(sub)) throw fail('Skill file escaped its folder.');
    let cursor = root;
    if (fs.lstatSync(root).isSymbolicLink()) throw fail('Skill folder cannot be a symbolic link.');
    for (const part of sub.split(path.sep).filter(Boolean)) { cursor = path.join(cursor, part); if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) throw fail('Symbolic links are not supported for skill files.'); }
    return file;
  };
  router.get('/skills/catalog', async (_req, res) => res.json({ skills: await skills(), degraded: false }));
  router.get('/skills/drafts', (_req, res) => res.json([]));
  router.get('/skills/catalog/:name/files', async (req, res) => {
    const item = await skill(req.params.name), root = path.dirname(item.path), files = [];
    const walk = (relative, depth) => {
      if (depth > 6 || files.length >= 1000) throw fail('Skill exceeds file listing limits.', 413);
      for (const entry of fs.readdirSync(skillFile(item, relative || '.'), { withFileTypes: true })) {
        if (entry.isSymbolicLink()) continue;
        const name = path.posix.join(relative, entry.name), full = skillFile(item, name);
        if (entry.isDirectory()) walk(name, depth + 1); else if (entry.isFile()) files.push({ path: name, size: fs.statSync(full).size });
      }
    };
    walk('', 0); res.json({ files });
  });
  router.get('/skills/catalog/:name/content', async (req, res) => {
    const item = await skill(req.params.name), file = skillFile(item, req.query.path || 'SKILL.md');
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw fail('Skill file not found.', 404);
    if (fs.statSync(file).size > 256 * 1024) throw fail('Skill file exceeds 256 KiB.', 413);
    res.json({ content: fs.readFileSync(file, 'utf8') });
  });
  router.put('/skills/catalog/:name/enabled', async (req, res) => {
    await skill(req.params.name); boolean(req.body.enabled, 'Skill enabled');
    if (typeof ctx.setSkillEnabled !== 'function') throw fail('Skill activation changes are not yet connected to the model skill catalog.', 501);
    await ctx.setSkillEnabled(req.params.name, req.body.enabled); res.json({ name: req.params.name, enabled: req.body.enabled });
  });
  router.post('/skills/:name/edit', async (req, res) => {
    const item = await skill(req.params.name); if (item.readOnly) throw fail('External skills are read-only. Duplicate the skill into this app before editing.', 403);
    const file = skillFile(item, req.body.path || 'SKILL.md'), old = text(req.body.old_string, 'Original text', 256 * 1024), replacement = text(req.body.new_string, 'Replacement text', 256 * 1024, true);
    if (!fs.existsSync(file) || fs.statSync(file).size > 256 * 1024) throw fail('Skill file is missing or too large.');
    const current = fs.readFileSync(file, 'utf8'), first = current.indexOf(old);
    if (first < 0 || current.indexOf(old, first + old.length) >= 0) throw fail('Original text must match exactly once.', 409);
    fs.writeFileSync(file, current.slice(0, first) + replacement + current.slice(first + old.length), 'utf8');
    ctx.notify?.('skill/updated'); res.json({ ok: true, name: item.name, path: req.body.path || 'SKILL.md' });
  });
  router.post('/skills/:name/duplicate', async (req, res) => {
    const source = await skill(text(req.body.sourceName, 'Source skill name', 120)), file = skillFile(source);
    if (fs.statSync(file).size > 128 * 1024) throw fail('Skill exceeds size limit.', 413);
    const content = fs.readFileSync(file, 'utf8'), instructions = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim();
    const result = await call('POST', '/api/skills', { name: req.params.name, description: source.description, instructions });
    ctx.notify?.('skill/created'); res.json(result);
  });
  return { referenceConnectorPolicy, referenceMemoryContext };
}
