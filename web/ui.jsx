import React, { useEffect, useRef, useMemo } from 'react';
import { X, CircleNotch, WarningCircle, CheckCircle, ArrowSquareOut } from '@phosphor-icons/react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import katex from 'katex';
import 'katex/dist/katex.min.css';

marked.use({ gfm: true, breaks: false, extensions: [
  { name: 'mathBlock', level: 'block', start: text => text.indexOf('$$'), tokenizer(text) { const m = /^\$\$\s*([\s\S]+?)\s*\$\$(?:\n|$)/.exec(text); if (m) return { type: 'mathBlock', raw: m[0], text: m[1] }; }, renderer: token => `<span data-science-math="${encodeURIComponent(token.text)}" data-display="true"></span>` },
  { name: 'mathInline', level: 'inline', start: text => text.indexOf('$'), tokenizer(text) { const m = /^\$([^$\n]+?)\$/.exec(text); if (m) return { type: 'mathInline', raw: m[0], text: m[1] }; }, renderer: token => `<span data-science-math="${encodeURIComponent(token.text)}"></span>` },
] });

export function Markdown({ text = '', className = '' }) {
  const html = useMemo(() => {
    const safe = DOMPurify.sanitize(marked.parse(String(text)), { ADD_ATTR: ['target'], FORBID_TAGS: ['style', 'iframe', 'form'], FORBID_ATTR: ['style'] });
    const root = document.createElement('div'); root.innerHTML = safe;
    for (const node of root.querySelectorAll('[data-science-math]')) {
      try { node.innerHTML = katex.renderToString(decodeURIComponent(node.dataset.scienceMath), { displayMode: node.dataset.display === 'true', throwOnError: false, trust: false, maxExpand: 1000 }); }
      catch { node.textContent = '無法顯示公式'; }
      node.removeAttribute('data-science-math');
    }
    return root.innerHTML;
  }, [text]);
  return <div className={`markdown ${className}`} dangerouslySetInnerHTML={{ __html: html }} onClick={event => { const a = event.target.closest('a'); if (a && /^https?:/.test(a.href)) { event.preventDefault(); window.open(a.href, '_blank', 'noopener,noreferrer'); } }} />;
}
export function IconButton({ icon: Icon, label, className = '', ...props }) { return <button className={`icon-button ${className}`} title={label} aria-label={label} {...props}><Icon size={18} /></button>; }
export function Empty({ icon: Icon, title, children, compact = false }) { return <div className={`empty ${compact ? 'compact' : ''}`}>{Icon && <Icon size={28} weight="light" />}<h3>{title}</h3>{children && <div className="muted">{children}</div>}</div>; }
export function Loading({ label = '載入中…' }) { return <div className="loading"><CircleNotch className="spin" size={18} />{label}</div>; }
export function ErrorNotice({ error, retry }) { return error ? <div className="error-notice" role="alert"><WarningCircle size={18} /><span>{String(error)}</span>{retry && <button onClick={retry}>重試</button>}</div> : null; }
export function Status({ value, children }) { const label = { ready: '已就緒', idle: '待命', running: '執行中', busy: '執行中', completed: '完成', success: '完成', error: '發生錯誤', failed: '失敗', interrupted: '已中斷', stopped: '已停止', starting: '啟動中', queued: '排程中', connected: '已連線', unavailable: '不可用' }[value] || value || '待命'; return <span className={`status status-${value || 'idle'}`}><i />{children || label}</span>; }
export function Modal({ title, children, onClose, wide = false }) {
  const ref = useRef();
  useEffect(() => { const previous = document.activeElement; ref.current?.focus(); const handler = e => { if (e.key === 'Escape') onClose(); if (e.key === 'Tab') { const controls = Array.from(ref.current?.querySelectorAll('button, input, select, textarea, a[href], [tabindex="0"]') || []).filter(x => !x.disabled); if (!controls.length) return; if (e.shiftKey && document.activeElement === controls[0]) { e.preventDefault(); controls.at(-1).focus(); } else if (!e.shiftKey && document.activeElement === controls.at(-1)) { e.preventDefault(); controls[0].focus(); } } }; document.addEventListener('keydown', handler); return () => { document.removeEventListener('keydown', handler); previous?.focus(); }; }, [onClose]);
  return <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}><section className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={ref}><header><h2>{title}</h2><IconButton icon={X} label="關閉視窗" onClick={onClose} /></header>{children}</section></div>;
}
export function Toast({ toast, close }) { useEffect(() => { if (!toast) return; const timer = setTimeout(close, 6500); return () => clearTimeout(timer); }, [toast, close]); return toast ? <div className={`toast ${toast.error ? 'toast-error' : ''}`} role={toast.error ? 'alert' : 'status'}>{toast.error ? <WarningCircle size={19} /> : <CheckCircle size={19} />}<span>{toast.text}</span><IconButton icon={X} label="關閉通知" onClick={close} /></div> : null; }
export function ExternalLink({ href, children, ...props }) { if (!/^https?:\/\//i.test(href || '')) return <span>{children}</span>; return <a href={href} target="_blank" rel="noopener noreferrer" {...props}>{children}<ArrowSquareOut size={14} /></a>; }
export function Field({ label, children, hint }) { return <label className="field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>; }
export function DataTable({ rows = [], columns }) {
  if (!rows.length) return <p className="muted padded">這個表格沒有資料。</p>;
  const cols = columns || (Array.isArray(rows[0]) ? rows[0].map((_, i) => String(i + 1)) : Object.keys(rows[0]));
  return <div className="table-scroll"><table><thead><tr><th className="row-number">#</th>{cols.map((c, i) => <th key={i}>{typeof c === 'object' ? c.name || c.id : c}</th>)}</tr></thead><tbody>{rows.slice(0, 500).map((r, i) => <tr key={i}><td className="row-number">{i + 1}</td>{cols.map((c, j) => <td key={j}>{String(Array.isArray(r) ? r[j] ?? '' : r[typeof c === 'object' ? c.name || c.id : c] ?? '')}</td>)}</tr>)}</tbody></table>{rows.length > 500 && <p className="muted padded">預覽前 500 列；下載可查看完整內容。</p>}</div>;
}
