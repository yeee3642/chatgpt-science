import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mountReferenceChat, createReferenceChatEvents, frameDTO, projectDTO, messageDTO, pendingInputDTOs } from '../server/reference-chat.mjs';

function fixture() {
  const routes = new Map();
  const router = Object.fromEntries(['get','post','patch','put','delete'].map(method => [method, (path, handler) => routes.set(`${method.toUpperCase()} ${path}`, handler)]));
  const data = { projects: [{ id:'p1', name:'Research', description:'Question', createdAt:'2026-09-20T00:00:00.000Z', archived:false }], sessions: [{ id:'s1', projectId:'p1', title:'Experiment', createdAt:'2026-09-20T00:00:00.000Z', status:'completed', messages:[{id:'m1',role:'user',text:'Question',createdAt:'2026-09-20T00:01:00.000Z'},{id:'m2',role:'assistant',text:'Observed answer',createdAt:'2026-09-20T00:02:00.000Z'}] }], artifacts:[], runs:[], approvals:[] };
  const calls = []; let nextSession = 1;
  const ctx = { store:{data,save(){}},events:new EventEmitter(),async call(method,path,body){calls.push({method,path,body});if(method==='POST'&&path==='/api/sessions'){const s={id:`s${++nextSession}`,projectId:body.projectId,title:body.title,status:'idle',createdAt:'2026-09-20T01:00:00.000Z',messages:[]};data.sessions.push(s);return s;}const id=path.split('/')[3];const session=data.sessions.find(s=>s.id===id);if(method==='POST'&&path.endsWith('/message')){session.messages.push({id:`m${session.messages.length+1}`,role:'user',text:body.text});session.status='running';return{ok:true};}if(method==='POST'&&path.endsWith('/interrupt')){session.status='interrupted';return{ok:true};}if(method==='PATCH'&&path.startsWith('/api/projects/')){Object.assign(data.projects.find(p=>p.id===id),body);return data.projects.find(p=>p.id===id);}throw new Error(`Unexpected test call ${method} ${path}`);} };
  mountReferenceChat(router,ctx);
  const invoke=async(method,path,req={})=>{let result;await routes.get(`${method} ${path}`)({params:{},query:{},body:{},...req},{json(value){result=value;return this;}});return result;};
  return{ctx,data,calls,invoke};
}

test('frame DTO carries actual message text and required nullable schema fields',()=>{
  const {data}=fixture();const dto=frameDTO(data.sessions[0],data);
  assert.equal(dto.root_frame_id,'s1');assert.equal(dto.agent_name,'ChatGPT');assert.equal(dto.status,'completed');
  assert.equal(dto.context_data._messages[1].content[0].text,'Observed answer');assert.equal(dto.message_count,2);
  assert.equal(dto.total_cost,null);assert.equal(dto.input_tokens,null);assert.deepEqual(dto.children,[]);
  assert.deepEqual(messageDTO({id:'m',role:'user',text:'x',referenceIntentId:'i'}),{role:'user',content:[{type:'text',text:'x'}],_uuid:'m',_intent_id:'i'});
});

test('project list and dashboard use distinct confirmed envelopes',async()=>{
  const {invoke,data}=fixture();const list=await invoke('GET','/projects');assert.equal(list.total,1);assert.equal(list.projects[0].project_id,'p1');
  const dashboard=await invoke('GET','/projects/dashboard');assert.equal(dashboard.total_projects,1);assert.equal(dashboard.projects[0].processing_count,0);
  assert.equal(projectDTO(data.projects[0],data).conversation_count,1);
});

test('message pagination and shallow trace are direct renderer DTOs',async()=>{
  const {invoke}=fixture();const page=await invoke('GET','/frames/:id/messages',{params:{id:'s1'},query:{from:'1',limit:'1'}});
  assert.equal(page.from,1);assert.equal(page.total,2);assert.equal(page.messages[0]._uuid,'m2');
  const trace=await invoke('GET','/frames/:id/trace-shallow',{params:{id:'s1'},query:{include_messages:'false'}});
  assert.equal(trace.id,'s1');assert.deepEqual(trace.children,[]);assert.equal(trace.context_data._messages,undefined);
});

test('project requests invoke only own ChatGPT service and persist intent identity',async()=>{
  const {invoke,calls,data}=fixture();const result=await invoke('POST','/projects/:pid/request',{params:{pid:'p1'},body:{input_data:{request:'Real question'},model:'gpt-test',intent_id:'intent-1'}});
  assert.equal(result.frame_id,'s2');assert.equal(result.status,'processing');assert.equal(calls.at(-1).path,'/api/sessions/s2/message');assert.equal(calls.at(-1).body.text,'Real question');
  assert.equal(data.sessions[1].messages[0].referenceIntentId,'intent-1');
  const again=await invoke('POST','/request',{body:{root_frame_id:'s2',input_data:{request:'Real question'},intent_id:'intent-1'}});assert.equal(again.status,'already_delivered');assert.equal(calls.filter(c=>c.path.endsWith('/message')).length,1);
});

test('frame access and cross-project send fail instead of inventing records',async()=>{
  const {invoke}=fixture();await assert.rejects(invoke('GET','/frames/:id',{params:{id:'absent'}}),e=>e.status===404);
  await assert.rejects(invoke('POST','/request',{body:{root_frame_id:'s1',project_id:'other',input_data:{request:'x'}}}),e=>e.status===403);
});

test('websocket projection replaces changed message tail without inventing tokens',async()=>{
  const {ctx,data}=fixture();const adapter=createReferenceChatEvents(ctx);const first=await adapter.updates({type:'session/updated',sessionId:'s1'});
  assert.equal(first[0].type,'frame_messages_delta');assert.equal(first[0].appended[1].content[0].text,'Observed answer');assert.equal(first[1].status,'completed');
  assert.deepEqual(await adapter.updates({type:'message/delta',sessionId:'s1'}),[]);
  data.sessions[0].status='running';data.sessions[0].messages[1].text+=' updated';const delta=await adapter.updates({type:'message/delta',sessionId:'s1'});
  assert.equal(delta[0].base_idx,0);assert.equal(delta[0].appended[1].content[0].text,'Observed answer updated');assert.equal(delta[1].status,'processing');
});

test('deletion retains evidence and refuses running sessions',async()=>{
  const {invoke,data}=fixture();data.sessions[0].status='running';await assert.rejects(invoke('DELETE','/frames/:id',{params:{id:'s1'}}),e=>e.status===409);
  data.sessions[0].status='completed';await invoke('DELETE','/frames/:id',{params:{id:'s1'}});assert.equal(data.sessions[0].referenceDeleted,true);assert.equal(data.sessions[0].messages.length,2);assert.deepEqual(await invoke('GET','/frames'),[]);
});

function withApprovals(f) {
  f.data.sessions[0].threadId='thread-1';
  const original=f.ctx.call;
  f.ctx.call=async(method,path,body)=>{
    if(method==='POST'&&path.startsWith('/api/approvals/')){
      f.calls.push({method,path,body});const id=decodeURIComponent(path.split('/').at(-1));
      f.data.approvals=f.data.approvals.filter(approval=>String(approval.id)!==id);return{ok:true};
    }
    return original(method,path,body);
  };
  return f;
}

test('real connector approval renders one-time question and resolves only exact consent',async()=>{
  const f=withApprovals(fixture());
  f.data.approvals.push({id:'a1',method:'science/connectorApproval',status:'pending',createdAt:'2026-09-20T00:03:00.000Z',params:{threadId:'thread-1',connectionName:'Research MCP',toolName:'read_dataset',arguments:{name:'owned-data'}}});
  const frame=frameDTO(f.data.sessions[0],f.data);assert.equal(frame.status,'awaiting_user_response');
  const req=frame.output_data.pending_input_requests[0];assert.equal(req.kind,'ask');assert.equal(req.questions[0].options[0].label,'允許這一次');
  await assert.rejects(f.invoke('POST','/frames/:id/resolve-input',{params:{id:'s1'},body:{responses:[{requestId:req.requestId,approved:true,answers:{[req.questions[0].question]:'Let the agent decide'}}]}}),e=>e.status===422);
  assert.equal(f.data.approvals.length,1);
  const result=await f.invoke('POST','/frames/:id/resolve-input',{params:{id:'s1'},body:{responses:[{requestId:req.requestId,approved:true,action:'answer',answers:{[req.questions[0].question]:'允許這一次'}}]}});
  assert.equal(result.status,'resolved');assert.equal(f.calls.at(-1).body.decision,'accept');
});

test('multi-question responses are collected then sent to original question IDs once complete',async()=>{
  const f=withApprovals(fixture());
  f.data.approvals.push({id:27,params:{threadId:'thread-1',questions:[{id:'q-a',question:'Dataset?',options:[{label:'A'}]},{id:'q-b',question:'Metric?'}]},createdAt:'2026-09-20T00:03:00.000Z'});
  let pending=pendingInputDTOs(f.data.sessions[0],f.data);
  const first=await f.invoke('POST','/frames/:id/resolve-input',{params:{id:'s1'},body:{responses:[{requestId:pending[0].requestId,approved:true,answers:{'Dataset?':'A'}}]}});
  assert.equal(first.status,'partial');assert.equal(f.calls.length,0);
  pending=pendingInputDTOs(f.data.sessions[0],f.data);assert.equal(pending.length,1);assert.equal(pending[0].questions[0].question,'Metric?');
  await f.invoke('POST','/frames/:id/resolve-input',{params:{id:'s1'},body:{responses:[{requestId:pending[0].requestId,approved:true,answers:{'Metric?':'Accuracy'}}]}});
  assert.deepEqual(f.calls.at(-1).body,{answers:{'q-a':{answers:['A']},'q-b':{answers:['Accuracy']}}});assert.equal(f.data.approvals.length,0);
});

test('foreign approval IDs and persistent-scope claims never resolve approvals',async()=>{
  const f=withApprovals(fixture());f.data.approvals.push({id:'foreign',params:{threadId:'other-thread'}});
  await assert.rejects(f.invoke('POST','/frames/:id/resolve-input',{params:{id:'s1'},body:{responses:[{requestId:'approval:foreign',approved:true}]}}),e=>e.status===404);
  assert.equal(f.calls.length,0);
});

test('approval and actual run changes are emitted even when chat text is unchanged',async()=>{
  const f=withApprovals(fixture());const stream=createReferenceChatEvents(f.ctx);await stream.updates({});
  f.data.approvals.push({id:'a',params:{threadId:'thread-1',questions:[{id:'q',question:'Continue?'}]}});
  const pending=await stream.updates({type:'approval/requested'});assert.equal(pending[1].has_pending_input,true);assert.equal(pending[1].pending_input_requests.length,1);
  f.data.approvals=[];f.data.sessions[0].status='running';f.data.runs.push({id:'run1',sessionId:'s1',language:'python',status:'running',startedAt:'2026-09-20T00:04:00.000Z'});
  const running=await stream.updates({type:'run/started'});const activity=running.find(event=>event.type==='frame_activity');assert.equal(activity.phase,'tool_exec');assert.equal(activity.exec_count,1);assert.equal(activity.executions[0].exec_id,'run1');
  assert.deepEqual(frameDTO(f.data.sessions[0],f.data).children,[]);
});

test('unsupported advanced session controls fail, while real goal becomes next prompt context',async()=>{
  const f=fixture();await assert.rejects(f.invoke('POST','/frames/:id/session-config',{params:{id:'s1'},body:{gpu_mode:'on',auto_mode:'on'}}),e=>e.status===501);
  await f.invoke('POST','/frames/:id/session-config',{params:{id:'s1'},body:{goal_text:'Compare reproducible results'}});
  await f.invoke('POST','/frames/:id/message',{params:{id:'s1'},body:{input_data:{request:'Begin'}}});
  assert.match(f.calls.at(-1).body.text,/Compare reproducible results/);assert.equal(messageDTO(f.data.sessions[0].messages.at(-1)).content[0].text,'Begin');
});
