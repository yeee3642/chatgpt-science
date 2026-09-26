import React, { useState } from 'react';
import { ShieldCheck, ChatCircleText } from '@phosphor-icons/react';
import { post } from './api';
import { Field, ErrorNotice } from './ui';

export function Approval({ approval, onUpdate, notify }) {
  const [busy, setBusy] = useState(false);
  const [answers, setAnswers] = useState({});
  const [error, setError] = useState('');
  const questions = approval.params?.questions || [];
  const isQuestion = questions.length > 0;
  const decide = async body => {
    setBusy(true); setError('');
    try { await post(`/approvals/${approval.id}`, body); await onUpdate(); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };
  if (isQuestion) return <div className="approval user-question"><ChatCircleText size={21} /><div><strong>研究助手需要補充資訊</strong>{questions.map(q => <div className="agent-question" key={q.id}><p>{q.question}</p>{q.options?.length > 0 && <div className="question-options">{q.options.map((o, i) => { const label = typeof o === 'string' ? o : o.label; return <button title={o.description || ''} key={i} className={answers[q.id] === label ? 'selected' : ''} onClick={() => setAnswers(a => ({ ...a, [q.id]: label }))}>{label}{o.description && <small>{o.description}</small>}</button>; })}</div>}<input aria-label={q.question} placeholder="或填寫你的回答…" type={q.isSecret ? 'password' : 'text'} value={answers[q.id] || ''} onChange={e => setAnswers(a => ({ ...a, [q.id]: e.target.value }))} /></div>)}<ErrorNotice error={error} /><div className="question-actions"><button disabled={busy} onClick={() => decide({ decision: 'decline' })}>略過問題</button><button className="primary" disabled={busy || questions.some(q => !answers[q.id]?.trim())} onClick={() => decide({ answers: Object.fromEntries(questions.map(q => [q.id, { answers: [answers[q.id]] }])) })}>送出回答</button></div></div></div>;
  return <div className="approval"><ShieldCheck size={21} /><div><strong>{approval.title || '研究助手需要你的核准'}</strong><p>{approval.reason || approval.description || approval.params?.reason || '請檢查以下動作，再決定是否執行。'}</p><details><summary>查看動作詳情</summary><pre>{JSON.stringify(approval.params || approval.request || approval.details || approval, null, 2)}</pre></details><ErrorNotice error={error} /></div><button disabled={busy} onClick={() => decide({ decision: 'decline' })}>拒絕</button><button className="primary" disabled={busy} onClick={() => decide({ decision: 'accept' })}>允許本次</button></div>;
}

export function ResearchActivity({ session }) {
  if (!session?.activity?.length && !session?.plan?.length && !session?.error) return null;
  return <section className="research-activity"><ErrorNotice error={session.error} />{session.plan?.length > 0 && <details open={session.status === 'running'} className="research-plan"><summary>研究計畫 <small>{session.plan.filter(p => p.status === 'completed').length} / {session.plan.length}</small></summary>{session.explanation && <p>{session.explanation}</p>}<ol>{session.plan.map((p, i) => <li className={`plan-${p.status}`} key={i}><span className="plan-marker">{p.status === 'completed' ? '✓' : i + 1}</span><span>{p.step}</span></li>)}</ol></details>}{session.activity?.length > 0 && <details className="activity-history"><summary>工具與代理活動 <small>{session.activity.length}</small></summary>{session.activity.slice(-30).map((a, i) => <details key={a.id || i} className="activity-item"><summary><span>{a.title || a.name || activityLabel(a.type)}</span><small>{a.status || ''}</small></summary>{a.command && <pre>{Array.isArray(a.command) ? a.command.join(' ') : a.command}</pre>}{a.output && <pre>{typeof a.output === 'string' ? a.output : JSON.stringify(a.output, null, 2)}</pre>}{!a.command && !a.output && <p>此活動沒有額外輸出。</p>}</details>)}</details>}</section>;
}

function activityLabel(type) {
  return { commandExecution: '執行程式', fileChange: '更新研究檔案', mcpToolCall: '研究工具', dynamicToolCall: '研究工具', reasoning: '研究分析', webSearch: '搜尋資料', collabAgentToolCall: '多代理研究', plan: '更新計畫' }[type] || type || '研究活動';
}
