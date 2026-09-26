export async function api(path, options = {}) {
  const headers = { ...options.headers };
  if (options.body && !(options.body instanceof FormData)) headers['Content-Type'] = 'application/json';
  const response = await fetch(`/api${path}`, {
    credentials: 'same-origin', ...options, headers,
    body: options.body && !(options.body instanceof FormData) ? JSON.stringify(options.body) : options.body,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `請求失敗 (${response.status})`);
  return data;
}
export const post = (path, body = {}) => api(path, { method: 'POST', body });
export const patch = (path, body) => api(path, { method: 'PATCH', body });
export const remove = path => api(path, { method: 'DELETE' });
export const fileUrl = (id, version, download = false) => `/api/artifacts/${encodeURIComponent(id)}/file?${new URLSearchParams({ ...(version ? { version } : {}), ...(download ? { download: '1' } : {}) })}`;
export const date = value => value ? new Date(value).toLocaleString('zh-TW', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '尚未執行';
export const bytes = value => value < 1024 ? `${value || 0} B` : value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KB` : `${(value / 1024 / 1024).toFixed(1)} MB`;
export function available(cap) { return cap === true || !!(cap && (cap.available === true || cap.ready === true || cap.status === 'ready')); }
export function capabilityReason(cap) { return typeof cap === 'string' ? cap : cap?.reason || cap?.error || cap?.message || '尚未偵測到可用環境'; }
export function accountIdentity(envelope) {
  let candidate = envelope;
  for (let depth = 0; depth < 3 && candidate; depth++) {
    if (typeof candidate.type === 'string') return candidate;
    candidate = candidate.account;
  }
  return null;
}
export function accountReady(envelope) { return accountIdentity(envelope)?.type === 'chatgpt'; }
