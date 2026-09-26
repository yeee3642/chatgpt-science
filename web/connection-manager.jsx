import React, { useState } from 'react';
import { Plugs, Plus, Trash, PencilSimple, SignIn } from '@phosphor-icons/react';
import { post, patch, remove } from './api';
import { Empty, Modal, Field, ErrorNotice, IconButton, ExternalLink } from './ui';
import { McpTools, Storage } from './connections';

const typeNames = { ssh: 'SSH / Slurm', mcp: 'MCP 研究工具', s3: 'Amazon S3', gcs: 'Google Cloud Storage', azure: 'Azure Blob', modal: 'Modal', model: '模型服務健康檢查' };
const defaults = {
  ssh: { host: '', scheduler: 'process', agentAccess: 'ask' },
  mcp: { url: '', transport: 'streamable-http', authMode: 'oauth', agentAccess: 'ask' },
  s3: { bucket: '', region: 'us-east-1', accessKeyIdEnv: '', secretAccessKeyEnv: '', agentAccess: 'ask' },
  gcs: { bucket: '', projectId: '', credentialsJsonEnv: '', agentAccess: 'ask' },
  azure: { container: '', connectionStringEnv: '', agentAccess: 'ask' },
  modal: { command: 'modal', environment: '', agentAccess: 'ask' },
  model: { healthUrl: '', agentAccess: 'read' },
};
const fields = {
  ssh: [['host', 'SSH 主機別名', '例如研究叢集在 SSH 設定檔中的 Host 名稱', true]],
  mcp: [['url', 'MCP 服務網址', 'https://…/mcp', true], ['clientId', 'OAuth Client ID（選填）', '服務要求預先註冊應用程式時填寫'], ['scope', 'OAuth 權限範圍（選填）', '由研究工具提供的 scope']],
  s3: [['bucket', 'Bucket 名稱', '', true], ['region', '區域', 'us-east-1'], ['accessKeyIdEnv', 'Access key ID 的環境變數名稱', 'AWS_ACCESS_KEY_ID', true], ['secretAccessKeyEnv', 'Secret key 的環境變數名稱', 'AWS_SECRET_ACCESS_KEY', true], ['endpoint', '相容 S3 的端點（選填）', 'https://…']],
  gcs: [['bucket', 'Bucket 名稱', '', true], ['projectId', 'Google Cloud 專案 ID（選填）', ''], ['credentialsJsonEnv', 'Service account JSON 的環境變數名稱', 'GOOGLE_SERVICE_ACCOUNT_JSON', true]],
  azure: [['container', '容器名稱', '', true], ['connectionStringEnv', '連線字串的環境變數名稱', 'AZURE_STORAGE_CONNECTION_STRING', true]],
  modal: [['command', 'Modal 執行檔', 'modal'], ['environment', '環境名稱（選填）', ''], ['tokenIdEnv', 'Token ID 的環境變數名稱（選填）', 'MODAL_TOKEN_ID'], ['tokenSecretEnv', 'Token secret 的環境變數名稱（選填）', 'MODAL_TOKEN_SECRET']],
  model: [['healthUrl', '唯讀健康檢查網址', 'https://…/health', true], ['tokenEnv', 'Token 的環境變數名稱（選填）', '']],
};

export function Connections({ state, project, onUpdate, onArtifact, notify }) {
  const [editing, setEditing] = useState(null);
  const [selectedId, setSelectedId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [diagnostic, setDiagnostic] = useState(null);
  const [oauth, setOauth] = useState(null);
  const selected = state.connections?.find(c => c.id === selectedId);
  const act = async action => { setBusy(true); setError(''); try { const result = await action(); await onUpdate(); return result; } catch (e) { setError(e.message); } finally { setBusy(false); } };
  return <div><div className="section-heading"><div><h2>工具與資料連線</h2><p className="muted">連接研究工具、運算叢集與雲端儲存。</p></div><button onClick={() => setEditing({})}><Plus size={16} />新增連線</button></div><ErrorNotice error={error} />
    <div className="connection-list">{state.connections?.length ? state.connections.map(c => <div className={`connection-row ${selectedId === c.id ? 'selected' : ''}`} key={c.id}><Plugs size={23} weight="light" /><div className="connection-copy"><strong>{c.name}</strong><small>{typeNames[c.type] || c.type} · {({ ask: '逐次詢問', read: '允許唯讀', allow: '允許工具', block: '禁止代理' })[c.config?.agentAccess || 'ask']}</small></div><div className="connection-actions"><button disabled={busy} onClick={() => act(async () => { const result = await post(`/connections/${c.id}/test`); setDiagnostic({ name: c.name, result }); })}>測試</button>{c.type === 'mcp' && c.config?.authMode === 'oauth' && <button disabled={busy} onClick={() => act(async () => { const result = await post(`/connections/${c.id}/oauth/start`); setOauth({ ...result, name: c.name }); if (result.authUrl && /^https:\/\//i.test(result.authUrl)) window.open(result.authUrl, '_blank', 'noopener,noreferrer'); })}><SignIn size={14} />連接帳號</button>}{['s3', 'gcs', 'azure', 'mcp'].includes(c.type) && <button onClick={() => setSelectedId(selectedId === c.id ? '' : c.id)}>{c.type === 'mcp' ? '工具' : '瀏覽'}</button>}<IconButton icon={PencilSimple} label={`編輯 ${c.name}`} onClick={() => setEditing(c)} /><IconButton icon={Trash} label={`刪除 ${c.name} 連線`} disabled={busy} onClick={() => { if (window.confirm(`刪除「${c.name}」連線設定？遠端資料不會刪除。`)) act(async () => { await remove(`/connections/${c.id}`); if (selectedId === c.id) setSelectedId(''); }); }} /></div></div>) : <Empty icon={Plugs} title="尚未設定連線">新增一個研究工具或儲存空間以開始。</Empty>}</div>
    {oauth && <div className="notice"><strong>{oauth.name} · {oauth.status === 'authorized' ? '已授權' : '請完成工具的官方授權'}</strong>{oauth.authUrl && <p><ExternalLink href={oauth.authUrl}>開啟授權頁面</ExternalLink></p>}<p>此工具的登入權杖只保存在記憶體，關閉工作台後需重新連接。工具執行仍依你設定的代理權限處理。</p><button onClick={onUpdate}>刷新連線狀態</button></div>}
    {diagnostic && <section className="settings-section"><h3>{diagnostic.name} · 連線診斷</h3><pre className="diagnostic-output">{JSON.stringify(diagnostic.result, null, 2)}</pre></section>}
    {selected && (selected.type === 'mcp' ? <McpTools key={selected.id} connection={selected} notify={notify} /> : <Storage key={selected.id} connection={selected} project={project} artifacts={state.artifacts || []} onUpdate={onUpdate} onArtifact={onArtifact} notify={notify} />)}
    {editing && <ConnectionEditor connection={editing} onClose={() => setEditing(null)} onSave={async data => { if (editing.id) await patch(`/connections/${editing.id}`, data); else await post('/connections', data); await onUpdate(); setEditing(null); notify('已儲存連線設定'); }} />}
  </div>;
}

function ConnectionEditor({ connection, onClose, onSave }) {
  const [name, setName] = useState(connection.name || '');
  const [type, setType] = useState(connection.type || 'ssh');
  const [config, setConfig] = useState({ ...defaults[connection.type || 'ssh'], ...connection.config });
  const [raw, setRaw] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const update = (key, value) => setConfig(c => ({ ...c, [key]: value }));
  const save = async () => {
    setBusy(true); setError('');
    try {
      const data = advanced ? JSON.parse(raw) : config;
      for (const [key, label, , required] of fields[type]) if (required && !data[key]?.trim()) throw new Error(`請填寫「${label}」。`);
      await onSave({ name: name.trim(), type, config: data });
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };
  return <Modal title={connection.id ? '編輯研究連線' : '新增研究連線'} onClose={onClose} wide><div className="form-row"><Field label="連線名稱"><input value={name} onChange={e => setName(e.target.value)} placeholder="讓你容易辨識的名稱" autoFocus /></Field><Field label="服務類型"><select value={type} disabled={!!connection.id} onChange={e => { setType(e.target.value); setConfig(defaults[e.target.value]); setAdvanced(false); }}>{Object.entries(typeNames).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></Field></div>
    {!advanced && <>{fields[type].map(([key, label, placeholder]) => type === 'mcp' && config.authMode !== 'oauth' && ['clientId', 'scope'].includes(key) ? null : <Field key={key} label={label}><input value={config[key] || ''} onChange={e => update(key, e.target.value)} placeholder={placeholder} /></Field>)}
      {type === 'mcp' && <div className="form-row"><Field label="傳輸方式"><select value={config.transport || 'streamable-http'} onChange={e => update('transport', e.target.value)}><option value="streamable-http">Streamable HTTP</option><option value="sse">SSE</option></select></Field><Field label="工具授權方式"><select value={config.authMode || 'oauth'} onChange={e => setConfig(c => { const next = { ...c, authMode: e.target.value }; if (e.target.value === 'oauth') { delete next.tokenEnv; delete next.apiKeyEnv; delete next.headersEnv; } return next; })}><option value="oauth">工具提供者 OAuth</option><option value="token">環境變數 Token / 無驗證</option></select></Field></div>}
      {type === 'mcp' && config.authMode === 'token' && <Field label="Token 的環境變數名稱（選填）"><input value={config.tokenEnv || ''} onChange={e => update('tokenEnv', e.target.value)} placeholder="例如 MY_MCP_TOKEN；沒有驗證需求可留白" /></Field>}
      {type === 'ssh' && <p className="muted connection-hint">使用已設定的 SSH Host 別名。主機、使用者、金鑰及連接埠由本機 SSH 設定管理。</p>}
      {type === 'model' && <p className="muted connection-hint">此連線只檢查模型服務狀態；研究對話仍使用 ChatGPT 帳號提供的模型。</p>}
      <Field label="研究代理可使用此連線的範圍"><select value={config.agentAccess || 'ask'} onChange={e => update('agentAccess', e.target.value)}><option value="ask">每次工具呼叫先詢問我</option><option value="read">允許唯讀工具，其他操作先詢問</option><option value="allow">允許代理使用此連線的工具</option><option value="block">不提供給研究代理</option></select></Field>
    </>}
    <button className="text-button" onClick={() => { if (!advanced) setRaw(JSON.stringify(config, null, 2)); else { try { setConfig(JSON.parse(raw)); } catch { setError('JSON 格式有誤，請先修正。'); return; } } setAdvanced(!advanced); }}>{advanced ? '回到表單' : '進階 JSON 設定'}</button>
    {advanced && <Field label="完整設定 (JSON)" hint="可設定本機 MCP command / args、headersEnv、OAuth scope、Slurm 資源與雲端進階選項。"><textarea className="code-editor config-editor" value={raw} onChange={e => setRaw(e.target.value)} spellCheck={false} /></Field>}
    <p className="muted connection-hint">需要憑證時填寫已設定的環境變數名稱，請勿將權杖或密碼直接放入設定。</p><ErrorNotice error={error} /><div className="modal-actions"><button onClick={onClose}>取消</button><button className="primary" disabled={!name.trim() || busy} onClick={save}>{busy ? '儲存中…' : '儲存連線'}</button></div></Modal>;
}
