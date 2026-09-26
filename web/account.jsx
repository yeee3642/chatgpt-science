import React, { useState, useEffect, useRef } from 'react';
import { CheckCircle, SignIn, CircleNotch, ArrowClockwise, ShieldCheck, WarningCircle, ArrowSquareOut } from '@phosphor-icons/react';
import { api, post, accountReady, accountIdentity, available, capabilityReason } from './api';
import { Status, ErrorNotice, ExternalLink } from './ui';

export function AccountPanel({ state, onUpdate }) {
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(null);
  const [error, setError] = useState('');
  const [localAccount, setLocalAccount] = useState(null);
  const mounted = useRef(true);
  const account = localAccount || state.account || {};
  const identity = accountIdentity(account);
  const ready = accountReady(account);
  const loginState = account.login || state.account?.login;
  const status = loginState?.status || attempt?.status || (ready ? 'completed' : 'disconnected');
  const pending = status === 'pending';
  const failed = status === 'failed';
  const cancelled = status === 'cancelled';
  const url = attempt?.authUrl;

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { setLocalAccount(null); }, [state.account]);

  const refreshAccount = async () => {
    const current = await api('/account');
    if (mounted.current) setLocalAccount(current);
    await onUpdate();
    return current;
  };

  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(() => { refreshAccount().catch(e => { if (mounted.current) setError(e.message); }); }, 3500);
    return () => clearInterval(timer);
  }, [pending]);

  const beginLogin = async () => {
    setBusy(true); setError('');
    try {
      const response = await post('/account/login');
      const authUrl = response.authUrl;
      if (!authUrl || !/^https:\/\//i.test(authUrl)) {
        const current = await refreshAccount();
        if (!accountReady(current)) throw new Error('登入服務沒有回傳有效的官方登入網址。請確認帳號服務正常後重試。');
        setAttempt({ status: 'completed' });
        return;
      }
      setLocalAccount(null);
      setAttempt({ ...response, authUrl, status: 'pending' });
      window.open(authUrl, '_blank', 'noopener,noreferrer');
      await onUpdate();
    } catch (e) {
      setError(e.message);
      setAttempt(a => ({ ...a, status: 'failed' }));
    } finally { if (mounted.current) setBusy(false); }
  };

  const cancelLogin = async () => {
    setBusy(true); setError('');
    try {
      await post('/account/login/cancel', { loginId: loginState?.loginId || attempt?.loginId });
      setAttempt(a => ({ ...a, status: 'cancelled' }));
      await refreshAccount();
    } catch (e) { setError(e.message); }
    finally { if (mounted.current) setBusy(false); }
  };

  const shownError = error || loginState?.error || account.error;
  return <div className="account-settings">
    <div className="section-heading"><div><h2>ChatGPT 帳號</h2><p className="muted">使用你的 ChatGPT 帳號，連接獨立研究工作台。</p></div><Status value={pending ? 'running' : ready ? 'connected' : 'idle'}>{pending ? '等待登入' : ready ? '已連線' : '尚未登入'}</Status></div>
    <div className="account-card"><div className="account-avatar">{pending ? <CircleNotch size={25} className="spin" /> : ready ? <CheckCircle size={25} /> : <SignIn size={25} />}</div><div><strong>{ready ? identity.email || 'ChatGPT 帳號已連線' : '以 ChatGPT 登入'}</strong><p>{ready && identity.planType ? `${identity.planType} 方案` : '在系統瀏覽器完成 OpenAI 官方授權。'}</p></div><button className={ready ? '' : 'primary'} disabled={busy || pending} onClick={beginLogin}><SignIn size={17} />{busy ? '處理中…' : ready ? '切換 ChatGPT 帳號' : '登入 ChatGPT'}</button></div>
    <ErrorNotice error={shownError} />
    {pending && <div className="notice account-pending"><strong>請在瀏覽器完成登入</strong><p>授權完成後，這裡會重新讀取真實帳號狀態。若瀏覽器沒有開啟，可使用下方連結。</p><div className="form-row">{url && <ExternalLink href={url}>開啟官方登入頁面</ExternalLink>}<button disabled={busy} onClick={async () => { setBusy(true); try { await refreshAccount(); } catch (e) { setError(e.message); } finally { setBusy(false); } }}><ArrowClockwise size={14} />刷新登入狀態</button><button disabled={busy} onClick={cancelLogin}>取消這次登入</button></div></div>}
    {failed && !pending && <p className="login-state-message"><WarningCircle size={16} />登入未完成，可重新開始官方授權流程。</p>}
    {cancelled && !pending && <p className="login-state-message">這次登入已取消。{ready ? '目前仍使用原本已連線的帳號。' : '尚未建立 ChatGPT 帳號連線。'}</p>}
    {identity?.type && identity.type !== 'chatgpt' && <div className="notice">目前偵測到的登入類型不是 ChatGPT 帳號。此工作台只使用 ChatGPT 登入，請透過上方按鈕連接。</div>}
    <p className="account-disclosure"><ShieldCheck size={15} /><span>此工作台由獨立實作提供；ChatGPT 登入由官方 Codex 服務處理。帳號連線狀態與可用模型以服務實際回傳為準。</span></p>
    <div className="settings-section"><h3>可用模型</h3>{ready && state.models?.length ? <div className="models-list">{state.models.map(m => <div key={m.id || m.model}><strong>{m.displayName || m.id || m.model}</strong><code>{m.id || m.model}</code>{m.description && <small>{m.description}</small>}</div>)}</div> : <p className="muted">完成 ChatGPT 登入後，這裡會列出帳號實際可用的模型。</p>}</div>
    <div className="settings-section"><h3>方案使用量</h3><Usage data={account.rateLimits || state.rateLimits} /></div>
    <div className="settings-section"><h3>本機能力</h3><div className="capability-list">{Object.entries(state.capabilities || {}).filter(([key]) => ['python', 'r', 'codex', 'ssh'].includes(key)).map(([key, cap]) => <div key={key}><strong>{key === 'codex' ? 'ChatGPT 服務' : key.toUpperCase()}</strong><Status value={available(cap) ? 'ready' : 'unavailable'} /><small>{available(cap) ? cap?.version || cap?.path || '' : capabilityReason(cap)}</small></div>)}</div></div>
  </div>;
}

function Usage({ data }) {
  const rateLimits = data?.rateLimitsByLimitId || (data?.rateLimits ? { default: data.rateLimits } : null);
  const items = rateLimits ? Object.entries(rateLimits).flatMap(([key, limit]) => ['primary', 'secondary'].filter(name => limit?.[name]).map(name => ({ key: `${key}:${name}`, limit: limit[name], name: limit.limitName || key }))) : [];
  if (!items.length) return <p className="muted">目前服務未提供可顯示的使用量資料。</p>;
  return <div className="usage-grid">{items.map(({ key, limit, name }) => <div className="usage-item" key={key}><strong>{limit.windowDurationMins ? `${limit.windowDurationMins / 60} 小時額度` : name}</strong><b>{typeof limit.usedPercent === 'number' ? `${Math.max(0, Math.min(100, 100 - limit.usedPercent)).toFixed(0)}%` : '未知'}</b><small>{typeof limit.usedPercent === 'number' ? '剩餘額度' : '服務未回傳使用百分比'}{limit.resetsAt ? ` · ${new Date(limit.resetsAt * 1000).toLocaleString('zh-TW')} 重設` : ''}</small></div>)}</div>;
}
