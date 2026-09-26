import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { startServer } from '../server/index.mjs';

function cleanTemporaryRoot(root){
  const parent=path.resolve(os.tmpdir()),resolved=path.resolve(root),relative=path.relative(parent,resolved);
  assert.ok(!relative.startsWith('..')&&!path.isAbsolute(relative)&&path.basename(root).startsWith('science-server-test-'));
  fs.rmSync(resolved,{recursive:true,force:true});
}
test('authenticated project, artifact versions and kernel execution flow', {timeout:90000}, async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'science-server-test-'));
  const svc=await startServer({dataRoot:root,initialize:false});
  t.after(async()=>{await svc.close();cleanTemporaryRoot(root);});
  assert.equal((await fetch(svc.origin+'/api/state')).status,401);
  const launch=await fetch(svc.launchUrl,{redirect:'manual'});
  assert.equal(launch.status,302);
  const cookie=launch.headers.get('set-cookie').split(';')[0];
  const call=async(url,body,method=body?'POST':'GET')=>{
    const res=await fetch(svc.origin+url,{method,headers:{Cookie:cookie,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
    const out=await res.json();assert.ok(res.ok,JSON.stringify(out));return out;
  };
  const p=await call('/api/projects',{name:'Integration evidence'});
  const s=await call('/api/sessions',{projectId:p.id,title:'Persistent kernel'});
  const denied=await fetch(svc.origin+'/api/kernels',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({projectId:p.id})});
  assert.equal(denied.status,403);
  await call('/api/projects/'+p.id,{allowHostExecution:true},'PATCH');
  const k=await call('/api/kernels',{projectId:p.id,sessionId:s.id,language:'python'});
  const r=await call('/api/kernels/'+k.id+'/execute',{code:'answer = 6 * 7\nprint(answer)',timeout:10});
  let result;
  for(let i=0;i<150;i++){result=await call('/api/runs/'+r.id);if(result.status!=='running')break;await new Promise(r=>setTimeout(r,200));}
  assert.equal(result.status,'completed');assert.match(JSON.stringify(result.outputs),/42/);
  const form=new FormData();form.append('projectId',p.id);form.append('files',new Blob(['metric,value\naccuracy,0.7\n'],{type:'text/csv'}),'results.csv');
  const up=await fetch(svc.origin+'/api/artifacts/upload',{method:'POST',headers:{Cookie:cookie},body:form});assert.equal(up.status,200);
  const [a]=await up.json();const preview=await call('/api/artifacts/'+a.id+'/content');assert.deepEqual(preview.columns,['metric','value']);
  await call('/api/artifacts/'+a.id+'/version',{text:'metric,value\naccuracy,0.8\n'});
  const versioned=await call('/api/artifacts/'+a.id);assert.equal(versioned.versions.length,2);
  const originDenied=await fetch(svc.origin+'/api/projects',{method:'POST',headers:{Cookie:cookie,Origin:'https://untrusted.example','Content-Type':'application/json'},body:'{"name":"bad"}'});assert.equal(originDenied.status,403);
  await call('/api/kernels/'+k.id,undefined,'DELETE');
});

const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
async function until(predicate,message='condition',timeout=2500){
  const end=Date.now()+timeout;
  while(Date.now()<end){if(await predicate())return;await new Promise(resolve=>setTimeout(resolve,10));}
  assert.fail('Timed out waiting for '+message);
}
class FixtureBridge extends EventEmitter{
  constructor(options){super();this.options=options;this.starts=[];this.resumes=[];this.sends=[];this.interrupts=[];this.identity={type:'chatgpt',email:'fixture@example.test',planType:'test'};this.turn=0;}
  async account(){return {account:this.identity,requiresOpenaiAuth:true};}
  async models(){return [{id:'fixture-model',displayName:'Fixture model'}];}
  async request(){return {rateLimits:null};}
  async login(){return {type:'chatgpt',loginId:'fixture-login',authUrl:'https://auth.example.test/login'};}
  async cancelLogin(id){this.cancelledLogin=id;return {status:'cancelled'};}
  async startThread(options){this.starts.push(options);this.emit('status',{state:'ready'});return {thread:{id:randomUUID()}};}
  async resumeThread(threadId,options){this.resumes.push({threadId,options});return {thread:{id:threadId}};}
  async send(threadId,text,options){const turnId='turn-'+(++this.turn);this.sends.push({threadId,text,options,turnId});this.emit('notification',{method:'turn/started',params:{threadId,turn:{id:turnId,status:'inProgress'}}});return {turn:{id:turnId,status:'inProgress'}};}
  async interrupt(threadId,turnId){this.interrupts.push({threadId,turnId});return {interrupted:true};}
  async respondApproval(id,decision){this.approvalResponse={id,decision};return {ok:true};}
  async close(){this.closeCalls=(this.closeCalls||0)+1;}
  async reconnect(){this.reconnectCalls=(this.reconnectCalls||0)+1;}
}
class FixtureKernel extends EventEmitter{
  constructor(){super();this.requests=[];this.created=[];this.items=[];}
  async probe(){return {python:{available:true},r:{available:false},executionMode:'host'};}
  async list(){return this.items;}
  async create(params){this.created.push(params);const k={...params,id:randomUUID(),status:'idle'};this.items.push(k);return k;}
  async request(method,params){this.requests.push({method,params});if(method==='environments/list')return [{id:'default',language:'python',managed:true},{id:'r-default',language:'r',managed:true}];return {id:'created',ok:true,...params};}
  async close({kernelId}){this.items=this.items.filter(k=>k.id!==kernelId);return {ok:true};}
  async shutdown(){}
}
async function fixture(t,extra={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'science-server-test-'));
  const kernel=new FixtureKernel();let bridge;
  const svc=await startServer({dataRoot:root,initialize:false,bridgeFactory:options=>(bridge=new FixtureBridge(options)),kernelFactory:()=>kernel,...extra});
  t.after(async()=>{await svc.close();cleanTemporaryRoot(root);});
  const cookie='science_session='+svc.token;
  const request=(url,body,method=body===undefined?'GET':'POST',headers={})=>fetch(svc.origin+url,{method,headers:{Cookie:cookie,...(body!==undefined?{'Content-Type':'application/json'}:{}),...headers},body:body===undefined?undefined:JSON.stringify(body)});
  const call=async(url,body,method)=>{const response=await request(url,body,method);const data=await response.json();assert.ok(response.ok,JSON.stringify(data));return data;};
  const project=await call('/api/projects',{name:'Test project'});
  return {svc,bridge,kernel,request,call,project,root};
}

test('stop during thread setup, resume or send cannot dispatch or revive a cancelled turn',async t=>{
  for(const phase of ['start','resume','send'])await t.test(phase,async sub=>{
    const f=await fixture(sub),s=await f.call('/api/sessions',{projectId:f.project.id}),hold=deferred();
    let attempted=0;
    if(phase==='start')f.bridge.startThread=async()=>{attempted++;return hold.promise;};
    if(phase==='resume'){f.svc.store.data.sessions[0].threadId='existing-thread';f.bridge.resumeThread=async()=>{attempted++;return hold.promise;};}
    if(phase==='send')f.bridge.send=async()=>{attempted++;return hold.promise;};
    await f.call('/api/sessions/'+s.id+'/message',{text:'first request'});
    await until(()=>attempted===1,'pending '+phase);
    await f.call('/api/sessions/'+s.id+'/interrupt',{});
    const retry=await f.request('/api/sessions/'+s.id+'/message',{text:'too early'});
    assert.equal(retry.status,409);
    hold.resolve(phase==='send'?{turn:{id:'cancelled-turn'}}:{thread:{id:'cancelled-thread'}});
    await new Promise(resolve=>setTimeout(resolve,30));
    const after=await f.call('/api/sessions/'+s.id);
    assert.equal(after.status,'interrupted');
    assert.equal(f.bridge.sends.length,0);
    if(phase==='send')assert.ok(f.bridge.interrupts.some(x=>x.turnId==='cancelled-turn'));
  });
});

test('late events from a cancelled turn cannot overwrite the next session turn',async t=>{
  const f=await fixture(t),s=await f.call('/api/sessions',{projectId:f.project.id});
  await f.call('/api/sessions/'+s.id+'/message',{text:'first'});
  await until(()=>f.bridge.sends.length===1);
  const first=f.bridge.sends[0];
  await f.call('/api/sessions/'+s.id+'/interrupt',{});
  await f.call('/api/sessions/'+s.id+'/message',{text:'second'});
  await until(()=>f.bridge.sends.length===2);
  f.bridge.emit('notification',{method:'turn/completed',params:{threadId:first.threadId,turn:{id:first.turnId,status:'completed'}}});
  const current=await f.call('/api/sessions/'+s.id);
  assert.equal(current.status,'running');
  assert.equal(current.turnId,f.bridge.sends[1].turnId);
});

test('review persists a version snapshot and reads its original text after a new version is saved',async t=>{
  const f=await fixture(t);
  const artifact=await f.svc.artifacts.createText({projectId:f.project.id,name:'evidence.md',text:'Measured value 7.'});
  const originalVersion=artifact.currentVersionId;
  const review=await f.call('/api/artifacts/'+artifact.id+'/review',{});
  await until(()=>f.bridge.sends.length===1);
  assert.equal(f.bridge.starts[0].readOnly,true);
  await f.svc.artifacts.addVersion(artifact.id,{text:'Changed value 99.'});
  const s=await f.call('/api/sessions/'+review.sessionId);
  const content=await f.bridge.options.toolHandler('science_read_artifact',{artifactId:artifact.id},{threadId:s.threadId});
  assert.match(JSON.stringify(content),/Measured value 7/);
  assert.doesNotMatch(JSON.stringify(content),/Changed value 99/);
  await assert.rejects(f.bridge.options.toolHandler('science_read_artifact',{artifactId:artifact.id,versionId:f.svc.artifacts.get(artifact.id).currentVersionId},{threadId:s.threadId}),/固定版本/);
  await assert.rejects(f.bridge.options.toolHandler('science_execute',{code:'print(1)'},{threadId:s.threadId}),/只能讀取/);
  f.bridge.emit('notification',{method:'turn/completed',params:{threadId:s.threadId,turn:{id:s.turnId,status:'completed'}}});
  const saved=await f.call('/api/artifacts/'+artifact.id);
  assert.equal(saved.reviews.length,1);
  assert.equal(saved.reviews[0].versionId,originalVersion);
  assert.equal(saved.reviews[0].status,'stale');
  assert.equal(saved.reviews[0].executionStatus,'completed');
});

test('account state follows real account type and hosted login notifications',async t=>{
  const f=await fixture(t);
  f.bridge.identity=null;
  assert.equal((await f.call('/api/account')).authenticated,false);
  await f.call('/api/account/login',{});
  assert.equal((await f.call('/api/state')).account.login.status,'pending');
  f.bridge.identity={type:'chatgpt',email:'fixture@example.test',planType:'plus'};
  f.bridge.emit('notification',{method:'account/login/completed',params:{loginId:'fixture-login',success:true}});
  await until(()=>f.svc.store&&f.bridge.identity!==null);
  await new Promise(resolve=>setTimeout(resolve,20));
  const signedIn=await f.call('/api/account');
  assert.equal(signedIn.account.type,'chatgpt');
  assert.equal(signedIn.authenticated,true);
  assert.equal(signedIn.login.status,'completed');
  f.bridge.identity={type:'apiKey'};
  f.bridge.emit('notification',{method:'account/updated',params:{authMode:'apiKey'}});
  await new Promise(resolve=>setTimeout(resolve,20));
  const unsupported=await f.call('/api/account');
  assert.equal(unsupported.authenticated,false);
  assert.deepEqual((await f.call('/api/state')).models,[]);
  await f.call('/api/account/login',{});
  await f.call('/api/account/login/cancel',{loginId:'fixture-login'});
  assert.equal(f.bridge.cancelledLogin,'fixture-login');
  assert.equal((await f.call('/api/state')).account.login.status,'cancelled');
});

test('app disconnect persists, blocks research and reconnects without signing out the shared account',async t=>{
  const f=await fixture(t),s=await f.call('/api/sessions',{projectId:f.project.id});
  assert.equal((await f.call('/api/account')).authenticated,true);
  const result=await f.call('/api/account/disconnect',{});
  assert.equal(result.sharedAccountSignedOut,false);
  assert.equal(f.bridge.closeCalls,1);
  assert.equal(f.bridge.identity.type,'chatgpt');
  assert.equal(f.svc.store.data.settings.chatgptDisconnected,true);
  assert.equal((await f.call('/api/account')).authenticated,false);
  assert.equal((await f.call('/api/account/refresh',{})).status,'disconnected');
  assert.equal((await f.request('/api/sessions/'+s.id+'/message',{text:'denied'})).status,401);
  assert.equal(f.bridge.sends.length,0);
  const reconnected=await f.call('/api/account/reconnect',{});
  assert.equal(reconnected.authenticated,true);
  assert.equal(f.bridge.reconnectCalls,1);
  assert.equal(f.svc.store.data.settings.chatgptDisconnected,false);
});

test('review honors an explicitly selected historical version and rejects unknown versions before creating a session',async t=>{
  const f=await fixture(t);
  const a=await f.svc.artifacts.createText({projectId:f.project.id,name:'history.txt',text:'Historical observation'});
  await f.svc.artifacts.addVersion(a.id,{text:'Current observation'});
  const rejected=await f.request('/api/artifacts/'+a.id+'/review',{versionId:'unknown-version'});
  assert.equal(rejected.status,404);
  assert.equal(f.svc.store.data.sessions.length,0);
  const review=await f.call('/api/artifacts/'+a.id+'/review',{versionId:a.currentVersionId});
  await until(()=>f.bridge.sends.length===1);
  const s=await f.call('/api/sessions/'+review.sessionId);
  assert.equal(s.reviewTargets[a.id],a.currentVersionId);
  assert.equal(f.svc.artifacts.get(a.id).reviews[0].versionId,a.currentVersionId);
  assert.match(f.bridge.sends[0].text,new RegExp(a.currentVersionId));
});

test('environment mutations require the named project permission and discard caller filesystem overrides',async t=>{
  const f=await fixture(t);
  const other=await f.call('/api/projects',{name:'Allowed project'});
  await f.call('/api/projects/'+other.id,{allowHostExecution:true},'PATCH');
  assert.equal((await f.request('/api/environments',{projectId:f.project.id,name:'Denied'})).status,403);
  assert.equal((await f.request('/api/environments/install',{projectId:f.project.id,packages:['numpy']})).status,403);
  assert.equal(f.kernel.requests.length,0);
  await f.call('/api/environments',{projectId:other.id,name:'Owned env',path:'C:\\outside',root:'C:\\outside',pythonPath:'C:\\outside.exe'});
  assert.deepEqual(f.kernel.requests[0],{method:'environments/create',params:{name:'Owned env',language:'python'}});
  assert.equal((await f.request('/api/environments/install',{projectId:other.id,manager:'r',environmentId:'default',packages:['jsonlite']})).status,400);
  await f.call('/api/environments/install',{projectId:other.id,manager:'r',packages:['jsonlite']});
  assert.equal(f.kernel.requests.at(-1).params.environmentId,'r-default');
});

test('settings and permission changes are validated atomically',async t=>{
  const f=await fixture(t),before={...f.svc.store.data.settings};
  for(const input of [{maxConcurrentRuns:0},{maxConcurrentRuns:17},{maxRuntimeSeconds:0},{maxRetries:11},{theme:'not-a-theme'},{pythonPath:{command:'anything'}}]){
    assert.equal((await f.request('/api/settings',input,'PATCH')).status,400);
    assert.deepEqual(f.svc.store.data.settings,before);
  }
  assert.equal((await f.request('/api/settings',{theme:'dark',maxRetries:-1},'PATCH')).status,400);
  assert.deepEqual(f.svc.store.data.settings,before);
  assert.equal((await f.request('/api/projects/'+f.project.id,{allowHostExecution:'false'},'PATCH')).status,400);
  assert.equal(f.svc.store.data.projects[0].allowHostExecution,false);
  assert.equal((await f.request('/api/projects/'+f.project.id,{name:'   '},'PATCH')).status,400);
});

test('HTML interactive preview has an opaque sandbox and the ordinary file stays inert',async t=>{
  const f=await fixture(t),artifact=await f.svc.artifacts.createText({projectId:f.project.id,name:'interactive.html',text:'<script>document.body.dataset.test=\"yes\"</script>'});
  const preview=await f.request('/api/artifacts/'+artifact.id+'/preview');
  assert.equal(preview.status,200);
  const csp=preview.headers.get('content-security-policy');
  assert.match(csp,/sandbox allow-scripts/);
  assert.doesNotMatch(csp,/allow-same-origin/);
  assert.match(csp,/connect-src 'none'/);
  const file=await f.request('/api/artifacts/'+artifact.id+'/file');
  assert.match(file.headers.get('content-security-policy'),/^sandbox;/);
  const plain=await f.svc.artifacts.createText({projectId:f.project.id,name:'plain.txt',text:'text'});
  assert.equal((await f.request('/api/artifacts/'+plain.id+'/preview')).status,415);
  assert.equal((await fetch(f.svc.origin+'/api/artifacts/'+artifact.id+'/preview')).status,401);
});

test('MCP tool requires scoped approval, preserves read-only policy and redacts authentication fields',async t=>{
  const calls=[],tools=[{name:'inspect',annotations:{readOnlyHint:true}},{name:'change',annotations:{readOnlyHint:false}}];
  const manager={async testConnection(){return {ok:true,tools};},async callMcpTool(id,input){calls.push({id,input});return {authorization:'private-auth',content:[{type:'text',text:'observed'}]};}};
  const f=await fixture(t,{integrationManager:manager});
  const c=await f.call('/api/connections',{name:'Fixture MCP',type:'mcp',config:{url:'http://127.0.0.1:65530/mcp'}});
  await f.call('/api/connections/'+c.id+'/test',{});
  const s=await f.call('/api/sessions',{projectId:f.project.id});
  await f.call('/api/sessions/'+s.id+'/message',{text:'inspect the service'});
  await until(()=>f.bridge.sends.length===1);
  const threadId=f.bridge.sends[0].threadId;
  const resultPromise=f.bridge.options.toolHandler('science_call_connector',{connectionId:c.id,toolName:'inspect',arguments:{query:'one'}},{threadId});
  await until(()=>f.svc.store.data.approvals.length===1);
  assert.equal(calls.length,0);
  const approval=f.svc.store.data.approvals[0];
  assert.equal(approval.method,'science/connectorApproval');
  await f.call('/api/approvals/'+approval.id,{decision:'accept'});
  const result=await resultPromise;
  assert.equal(calls.length,1);
  assert.equal(result.result.authorization,'[redacted]');
  assert.deepEqual(calls[0].input.arguments,{query:'one'});
  await f.call('/api/connections/'+c.id,{config:{url:c.config.url,agentAccess:'read'}},'PATCH');
  await assert.rejects(f.bridge.options.toolHandler('science_call_connector',{connectionId:c.id,toolName:'change'},{threadId}),/唯讀/);
  await f.bridge.options.toolHandler('science_read_connector',{connectionId:c.id,toolName:'inspect'},{threadId});
  assert.equal(calls.at(-1).input.requireReadOnly,true);
});

test('stopping a session rejects pending connector approval without invoking its tool',async t=>{
  const calls=[],manager={async testConnection(){return {ok:true,tools:[{name:'change'}]};},async callMcpTool(...args){calls.push(args);return {};}};
  const f=await fixture(t,{integrationManager:manager});
  const c=await f.call('/api/connections',{name:'Fixture',type:'mcp',config:{}});
  const s=await f.call('/api/sessions',{projectId:f.project.id});
  await f.call('/api/sessions/'+s.id+'/message',{text:'ask'});
  await until(()=>f.bridge.sends.length===1);
  const pending=f.bridge.options.toolHandler('science_call_connector',{connectionId:c.id,toolName:'change'},{threadId:f.bridge.sends[0].threadId}).then(value=>({value}),error=>({error}));
  await until(()=>f.svc.store.data.approvals.length===1);
  await f.call('/api/sessions/'+s.id+'/interrupt',{});
  assert.match((await pending).error.message,/未獲/);
  assert.deepEqual(calls,[]);
  assert.deepEqual(f.svc.store.data.approvals,[]);
});

test('MCP OAuth callback uses server origin, not caller redirect URL, and persists no tokens',async t=>{
  let callback,connectionId;
  const manager={
    async beginMcpOAuth(id,input){connectionId=id;callback=input.redirectUrl;return {authUrl:'https://provider.example.test/authorize'};},
    async completeMcpOAuth(input){assert.deepEqual(input,{code:'test-code',state:'test-state'});return {ok:true,connectionId};},
    getMcpOAuthStatus(){return {status:'authorized',tokenStorage:'memory',reconnectOnRestart:true};},
  };
  const f=await fixture(t,{integrationManager:manager});
  const c=await f.call('/api/connections',{name:'OAuth fixture',type:'mcp',config:{url:'https://provider.example.test/mcp'}});
  await f.call('/api/connections/'+c.id+'/oauth/start',{redirectUrl:'https://untrusted.example/callback'});
  assert.equal(callback,f.svc.origin+'/oauth/callback');
  const response=await fetch(f.svc.origin+'/oauth/callback?code=test-code&state=test-state');
  assert.equal(response.status,200);
  assert.equal(f.svc.store.data.connections[0].config.authMode,'oauth');
  assert.doesNotMatch(fs.readFileSync(f.svc.store.filePath,'utf8'),/access_token|refresh_token/);
});
