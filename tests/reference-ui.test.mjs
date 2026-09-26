import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { EventEmitter, once } from 'node:events';
import { WebSocket } from 'ws';
import { attachReferenceUi } from '../server/reference-ui.mjs';

async function fixture(t){
  const app=express();app.use(express.json());
  const token='owned-reference-session',events=new EventEmitter(),calls=[];
  const data={
    settings:{},projects:[{id:'p1',name:'Research',createdAt:'2026-09-20T00:00:00Z'}],
    sessions:[{id:'s1',projectId:'p1',title:'Research session',status:'completed',messages:[{id:'m1',role:'assistant',text:'Recorded answer'}]}],
    artifacts:[],runs:[],approvals:[],connections:[],memories:[],
  };
  const store={data,dataRoot:'C:\\Owned\\Research',update(fn){return fn(data);},save(){}};
  const ctx={store,events,token,apiRoot:'/reference/api',artifacts:{},identity:null,get origin(){return origin;},notify(type,extra){events.emit('update',{type,...extra});},async call(method,route,body){
    calls.push({method,route,body});
    if(route==='/api/account')return {account:ctx.identity,authenticated:ctx.identity?.type==='chatgpt',requiresOpenaiAuth:true};
    if(route==='/api/status')return {ok:true,ready:true};
    if(route==='/api/models')return [{id:'gpt-fixture',displayName:'Fixture GPT',isDefault:true}];
    if(route==='/api/state')return data;
    if(route==='/api/account/login')return {type:'chatgpt',loginId:'owned-login',authUrl:'https://auth.openai.com/fixture'};
    if(route==='/api/sessions/s1')return data.sessions[0];
    throw Object.assign(new Error('Unimplemented fixture route: '+route),{status:501});
  }};
  const reference=await attachReferenceUi(app,ctx);
  app.use((error,_req,res,_next)=>res.status(error.status||500).json({error:error.message}));
  let origin='';
  const server=await new Promise(resolve=>{const server=app.listen(0,'127.0.0.1',()=>resolve(server));});
  origin='http://127.0.0.1:'+server.address().port;reference.attachServer(server);
  t.after(async()=>{await reference.close();await new Promise(resolve=>{server.close(resolve);server.closeAllConnections?.();});});
  const initial=await fetch(origin+'/reference/api/health',{headers:{Cookie:'science_session='+token}});
  assert.equal(initial.status,200);
  assert.match(initial.headers.get('set-cookie'),/Path=\/;/);
  const csrf=initial.headers.get('set-cookie').match(/operon_csrf=([^;]+)/)[1];
  const cookie='science_session='+token+'; operon_csrf='+csrf;
  const request=(route,body,method=body===undefined?'GET':'POST',headers={})=>fetch(origin+'/reference/api'+route,{method,headers:{Cookie:cookie,...(body!==undefined?{'Content-Type':'application/json','X-CSRF-Token':csrf}:{}),...headers},body:body===undefined?undefined:JSON.stringify(body)});
  const call=async(route,body,method)=>{const response=await request(route,body,method);const value=await response.json();assert.ok(response.ok,JSON.stringify(value));return value;};
  return {ctx,store,data,calls,origin,token,csrf,cookie,request,call};
}

test('startup authentication reports only the real ChatGPT account and never fabricates an email or vendor organization',async t=>{
  const f=await fixture(t);
  assert.equal((await fetch(f.origin+'/reference/api/auth/status')).status,401);
  assert.equal((await fetch(f.origin+'/reference/api/projects')).status,401);
  assert.deepEqual(await f.call('/auth/status'),{authenticated:false,provider:'chatgpt',restart_pending:false,oauth_stale:false});
  assert.equal((await f.request('/me')).status,401);
  f.ctx.identity={type:'apiKey',email:'not-chatgpt@example.test'};
  assert.equal((await f.call('/auth/status')).authenticated,false);
  f.ctx.identity={type:'chatgpt',email:null};
  const user=await f.call('/me');
  assert.equal(user.provider,'chatgpt');
  assert.equal(user.email,null);
  assert.match(user.user_id,/^[0-9a-f-]{36}$/);
  assert.equal((await f.call('/me')).user_id,user.user_id);
  assert.equal(user.has_api_key,false);
  assert.deepEqual(await f.call('/auth/organizations'),{organizations:[]});
  assert.equal((await f.request('/org-policy')).status,404);
});

test('model selector receives actual grouped models without Claude catalog or entitlement flags',async t=>{
  const f=await fixture(t);
  assert.deepEqual((await f.call('/models')).models,{chatgpt:[]});
  f.ctx.identity={type:'chatgpt',email:'user@example.test'};
  const models=await f.call('/models');
  assert.equal(models.models.chatgpt[0].id,'gpt-fixture');
  assert.equal(models.default_model_id,'gpt-fixture');
  assert.equal(models.first_party_catalog,undefined);
  assert.equal(models.model_list_source,undefined);
});

test('compatibility mutations require own CSRF token and login delegates the real hosted flow',async t=>{
  const f=await fixture(t);
  const denied=await f.request('/account/login',{},'POST',{'X-CSRF-Token':''});
  assert.equal(denied.status,403);
  assert.equal(f.calls.some(call=>call.route==='/api/account/login'),false);
  const login=await f.call('/account/login',{});
  assert.equal(login.loginId,'owned-login');
  assert.equal(login.authUrl,'https://auth.openai.com/fixture');
  assert.equal((await f.request('/auth/exchange',{provider:'claude_ai',code:'unused'})).status,501);
  assert.equal((await f.request('/unimplemented')).status,501);
});

test('first-run preference is local persisted state, not an invented completion',async t=>{
  const f=await fixture(t);
  assert.deepEqual(await f.call('/preferences/first-run-onboarding'),{complete:false});
  await f.call('/preferences/first-run-onboarding/complete',{});
  assert.deepEqual(await f.call('/preferences/first-run-onboarding'),{complete:true});
  assert.equal(f.store.data.settings.referenceUi.onboardingComplete,true);
});

test('reference projects delegate the shared store and retain original renderer DTO shape',async t=>{
  const f=await fixture(t);
  const projects=await f.call('/projects');
  assert.equal(projects.total,1);
  assert.equal(projects.projects[0].project_id,'p1');
  const frame=await f.call('/frames/s1');
  assert.equal(frame.id,'s1');
  assert.equal(frame.agent_name,'ChatGPT');
});

test('websocket requires owned cookies and protocol, then streams real session state',async t=>{
  const f=await fixture(t),url=f.origin.replace('http:','ws:')+'/reference/api/ws';
  const denied=new WebSocket(url,'operon-csrf.'+f.csrf,{headers:{Origin:f.origin}});
  await assert.rejects(once(denied,'open'),/403/);
  const socket=new WebSocket(url,'operon-csrf.'+f.csrf,{headers:{Cookie:f.cookie,Origin:f.origin}});
  t.after(()=>socket.terminate());
  await once(socket,'open');
  const first=once(socket,'message');socket.send(JSON.stringify({type:'view_session',root_frame_id:'s1'}));
  const [raw]=await first,event=JSON.parse(raw.toString());
  assert.equal(event.type,'frame_messages_delta');
  assert.equal(event.root_frame_id,'s1');
  assert.equal(event.appended[0].content[0].text,'Recorded answer');
  const pong=new Promise(resolve=>{const listener=raw=>{const event=JSON.parse(raw.toString());if(event.type==='pong'){socket.off('message',listener);resolve(event);}};socket.on('message',listener);});
  socket.send(JSON.stringify({type:'ping'}));
  assert.equal((await pong).type,'pong');
  const update=new Promise(resolve=>{const listener=raw=>{const event=JSON.parse(raw.toString());if(event.type==='frame_messages_delta'&&event.appended[0].content[0].text==='Updated answer'){socket.off('message',listener);resolve(event);}};socket.on('message',listener);});
  f.data.sessions[0].messages[0].text='Updated answer';
  f.ctx.events.emit('update',{type:'message/delta',sessionId:'s1'});
  assert.equal((await update).base_idx,0);
});
