import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { WebSocketServer } from 'ws';
import { mountReferenceChat, createReferenceChatEvents } from './reference-chat.mjs';

const isObject=value=>value&&typeof value==='object'&&!Array.isArray(value);
const same=(a,b)=>{if(typeof a!=='string'||typeof b!=='string')return false;const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&crypto.timingSafeEqual(x,y);};
const cookieMap=header=>Object.fromEntries(String(header||'').split(';').map(part=>{const index=part.indexOf('=');return index<0?[part.trim(),'']:[part.slice(0,index).trim(),part.slice(index+1)];}));
const originOf=ctx=>typeof ctx.origin==='function'?ctx.origin():ctx.origin;
const missing=(res,detail,status=501)=>res.status(status).json({error:'not_implemented',detail});

/**
 * Compatibility presentation for copied reference UI assets. Authentication,
 * storage and execution remain the independent workbench's own services.
 * No original engine, original credentials or vendor entitlements are used.
 */
export async function attachReferenceUi(app,ctx){
  if(!app||typeof ctx?.call!=='function'||!ctx.store||typeof ctx.token!=='string')throw new Error('Reference UI requires the owned workbench service context.');
  const router=express.Router(),apiRoot=ctx.apiRoot||'/reference/api';
  const csrf=crypto.randomBytes(24).toString('hex');
  const protocol='operon-csrf.'+csrf;
  let closed=false,accountPending=null,server=null,heartbeat=null,computeModule=null;
  const optionalRouters=[];
  const prefs=()=>isObject(ctx.store.data.settings.referenceUi)?ctx.store.data.settings.referenceUi:{};
  const persist=changes=>{
    ctx.store.update(data=>{data.settings.referenceUi={...(data.settings.referenceUi||{}),...changes};});
    ctx.notify?.('reference/preferences');
  };
  const account=()=>{
    if(!accountPending)accountPending=Promise.resolve(ctx.call('GET','/api/account')).finally(()=>{accountPending=null;});
    return accountPending;
  };
  const identity=async()=>{const result=await account();return {result,principal:result?.account?.type==='chatgpt'?result.account:null};};
  const localUserId=()=>{
    if(!prefs().userId)persist({userId:crypto.randomUUID()});
    return prefs().userId;
  };
  router.use((req,res,next)=>{
    res.setHeader('Cache-Control','no-store');
    const cookies=cookieMap(req.headers.cookie);
    if(!same(cookies.science_session,ctx.token))return res.status(401).json({error:'workbench_session_required',detail:'Open this independent workbench through its own launcher.'});
    if(!same(cookies.operon_csrf,csrf))res.cookie('operon_csrf',csrf,{httpOnly:false,sameSite:'strict',path:'/'});
    if(!['GET','HEAD','OPTIONS'].includes(req.method)&&!same(req.get('x-csrf-token')||req.get('x-operon-csrf'),csrf)){
      return res.status(403).json({error:'csrf_mismatch',detail:'Reload the independent workbench before retrying this request.'});
    }
    next();
  });
  router.get('/health',async(_req,res)=>{
    const status=await ctx.call('GET','/api/status');
    res.json({status:status.ready?'ok':'starting',ok:status.ok===true,ready:status.ready===true,sandbox_volstamp:null,sandbox_volstamp_available:false,sandbox_env_census:null,db_corruption:null});
  });
  router.get('/auth/status',async(_req,res)=>{
    const {result,principal}=await identity();
    res.json({authenticated:!!principal,provider:'chatgpt',restart_pending:false,oauth_stale:false,...(result.error?{auth_error:result.error}:{})});
  });
  router.get('/me',async(_req,res)=>{
    const {principal}=await identity();
    if(!principal)return res.status(401).json({error:'chatgpt_sign_in_required',detail:'Sign in with ChatGPT.'});
    res.json({user_id:localUserId(),email:principal.email||null,provider:'chatgpt',has_api_key:false,shared_api_key:false,auth_mode:'chatgpt'});
  });
  router.get('/auth/organizations',(_req,res)=>res.json({organizations:[]}));
  router.get('/org-policy',(_req,res)=>res.status(404).json({error:'not_applicable',detail:'This independent local workbench has no vendor organization policy.'}));
  router.all(['/auth/login','/auth/exchange','/auth/logout'],(_req,res)=>missing(res,'Use the independent ChatGPT sign-in controls. Vendor login, code exchange and logout are not provided.'));
  router.get('/account',async(_req,res)=>res.json(await ctx.call('GET','/api/account')));
  for(const route of ['/account/login','/account/login/cancel','/account/disconnect','/account/reconnect']){
    router.post(route,async(req,res)=>res.json(await ctx.call('POST','/api'+route,req.body||{})));
  }
  router.get('/models',async(_req,res)=>{
    const {principal,result}=await identity();
    if(!principal)return res.json({models:{chatgpt:[]},default_model_id:null,auth_error:result.error||'ChatGPT sign-in required'});
    try{
      const raw=await ctx.call('GET','/api/models');
      const models=(Array.isArray(raw)?raw:raw?.data||[]).map(model=>({...model,provider:'chatgpt',name:model.displayName||model.name||model.id,display_name:model.displayName||model.name||model.id}));
      const preferred=models.find(model=>model.isDefault||model.default)||models[0];
      res.json({models:{chatgpt:models},default_model_id:preferred?.id||null});
    }catch(error){res.json({models:{chatgpt:[]},default_model_id:null,fetch_error:error.message});}
  });
  router.get('/settings/data-dir',(_req,res)=>res.json({resolved:ctx.store.dataRoot,current:ctx.store.dataRoot}));
  router.get('/preferences/first-run-onboarding',(_req,res)=>res.json({complete:prefs().onboardingComplete===true}));
  router.post('/preferences/first-run-onboarding/complete',(_req,res)=>{persist({onboardingComplete:true});res.json({complete:true});});
  router.get('/preferences/use-intent',(_req,res)=>res.json({intent:prefs().useIntent||''}));
  router.put('/preferences/use-intent',(req,res)=>{if(typeof req.body?.intent!=='string'||req.body.intent.length>100)return res.status(400).json({detail:'Use intent must be a string of at most 100 characters.'});persist({useIntent:req.body.intent});res.json({intent:req.body.intent});});
  router.get('/preferences/reviewer-model',(_req,res)=>res.json({model:null,source:'default'}));
  router.put('/preferences/reviewer-model',(req,res)=>req.body?.model===null?res.json({model:null,source:'default'}):missing(res,'Selecting a separate reviewer model is not supported by the research service.'));
  for(const route of ['/preferences/auto-mode','/preferences/auto-switch-on-flag']){
    router.get(route,(_req,res)=>res.json({enabled:false}));
    router.put(route,(req,res)=>req.body?.enabled===false?res.json({enabled:false}):missing(res,'This workbench has no automatic approval classifier or reviewer-switch workflow.'));
  }
  router.all(['/preferences/builtin-allowlist','/preferences/builtin-allowlist/disabled','/preferences/builtin-allowlist/disabled-groups'],(_req,res)=>missing(res,'The compute service runs with host-user permissions. An operating-system network sandbox and domain allowlist are not implemented.'));
  router.get('/memory/enabled',(_req,res)=>res.json({enabled:true}));
  router.post('/memory/enabled',(req,res)=>req.body?.enabled===true?res.json({enabled:true}):missing(res,'Disabling injected project memory is not implemented by the research service.'));
  router.put('/memory/enabled',(req,res)=>req.body?.enabled===true?res.json({enabled:true}):missing(res,'Disabling injected project memory is not implemented by the research service.'));
  router.post('/analytics/track',(_req,res)=>res.json({accepted:false,disabled:true}));
  router.get('/settings',async(_req,res)=>res.json((await ctx.call('GET','/api/state')).settings));
  router.patch('/settings',async(req,res)=>res.json(await ctx.call('PATCH','/api/settings',req.body||{})));
  // These are the independent service routes. Reference-specific aliases are
  // added only when their request/response contracts have been verified.
  router.get('/connections',async(_req,res)=>res.json({connections:(await ctx.call('GET','/api/state')).connections}));
  router.post('/connections',async(req,res)=>res.json(await ctx.call('POST','/api/connections',req.body)));
  router.patch('/connections/:id',async(req,res)=>res.json(await ctx.call('PATCH','/api/connections/'+encodeURIComponent(req.params.id),req.body)));
  router.delete('/connections/:id',async(req,res)=>res.json(await ctx.call('DELETE','/api/connections/'+encodeURIComponent(req.params.id))));
  for(const suffix of ['test','mcp/tools','mcp/call','oauth/start','oauth/disconnect']){
    router.post('/connections/:id/'+suffix,async(req,res)=>res.json(await ctx.call('POST','/api/connections/'+encodeURIComponent(req.params.id)+'/'+suffix,req.body||{})));
  }
  router.get('/connections/:id/oauth',async(req,res)=>res.json(await ctx.call('GET','/api/connections/'+encodeURIComponent(req.params.id)+'/oauth')));
  router.get('/memories',async(req,res)=>{const all=(await ctx.call('GET','/api/state')).memories;res.json({memories:req.query.project_id?all.filter(item=>item.projectId===req.query.project_id):all});});
  router.post('/memories',async(req,res)=>res.json(await ctx.call('POST','/api/memories',req.body)));
  router.delete('/memories/:id',async(req,res)=>res.json(await ctx.call('DELETE','/api/memories/'+encodeURIComponent(req.params.id))));
  router.get('/skills',async(_req,res)=>res.json({skills:await ctx.call('GET','/api/skills')}));
  router.post('/skills',async(req,res)=>res.json(await ctx.call('POST','/api/skills',req.body)));

  mountReferenceChat(router,ctx);
  for(const [file,name] of [['./reference-artifacts.mjs','mountReferenceArtifacts'],['./reference-compute.mjs','mountReferenceCompute']]){
    const url=new URL(file,import.meta.url);
    if(fs.existsSync(url)){
      const module=await import(url.href);
      if(typeof module[name]!=='function')throw new Error('Invalid reference UI module export: '+name);
      const mounted=await module[name](router,ctx);if(mounted)optionalRouters.push(mounted);
      if(name==='mountReferenceCompute')computeModule=mounted;
    }
  }
  router.use((req,res)=>missing(res,'This reference UI command is not implemented by the independent research service: '+req.method+' '+req.path));
  app.use(apiRoot,router);

  const chatEvents=createReferenceChatEvents(ctx);
  const clients=new Set();
  const wss=new WebSocketServer({noServer:true,maxPayload:64*1024,handleProtocols:protocols=>protocols.has(protocol)?protocol:false});
  const send=(socket,event)=>{if(socket.readyState===1)socket.send(JSON.stringify(event));};
  const eventsFor=async event=>{
    const mapped=await chatEvents.updates(event);
    const compute=typeof computeModule?.mapEvent==='function'?await computeModule.mapEvent(event):[];
    return [...(Array.isArray(mapped)?mapped:[]),...(Array.isArray(compute)?compute:[])];
  };
  let queue=Promise.resolve();
  const onUpdate=event=>{
    queue=queue.then(async()=>{
      if(closed)return;
      for(const mapped of await eventsFor(event)){
        for(const socket of clients)if(!mapped.root_frame_id||socket.referenceViews.has(mapped.root_frame_id))send(socket,mapped);
      }
    }).catch(error=>{for(const socket of clients)send(socket,{type:'error',message:error.message});});
  };
  ctx.events?.on('update',onUpdate);
  wss.on('connection',socket=>{
    socket.referenceViews=new Set();socket.referenceAlive=true;clients.add(socket);
    socket.on('pong',()=>{socket.referenceAlive=true;});
    socket.on('message',async raw=>{
      try{
        const message=JSON.parse(raw.toString('utf8'));
        if(message.type==='ping'){send(socket,{type:'pong'});return;}
        if(message.type==='pong'){socket.referenceAlive=true;return;}
        if(message.type==='kernel_user_exec'||message.type==='kernel_user_interrupt'){
          try{
            if(!computeModule)throw new Error('The independent compute adapter is not available.');
            const result=message.type==='kernel_user_exec'
              ?await computeModule.executeCell(message.frame_id,{language:message.language,environment:message.environment,code:message.code})
              :await computeModule.interruptCell(message.frame_id,message.exec_id);
            send(socket,{type:'kernel_terminal_ack',request_id:message.request_id,...result});
          }catch(error){send(socket,{type:'kernel_terminal_ack',request_id:message.request_id,ok:false,error:error.message});}
          return;
        }
        if(!['view_session','unview_session'].includes(message.type))return;
        const id=message.root_frame_id;
        if(typeof id!=='string'||id.length>100||!ctx.store.data.sessions.some(session=>session.id===id))return;
        if(message.type==='unview_session'){socket.referenceViews.delete(id);return;}
        socket.referenceViews.add(id);
        for(const event of await eventsFor({type:'session/updated',sessionId:id}))send(socket,event);
      }catch{send(socket,{type:'error',message:'Invalid reference UI websocket message.'});}
    });
    socket.on('close',()=>clients.delete(socket));
    socket.on('error',()=>clients.delete(socket));
  });
  const rejectUpgrade=(socket,status)=>{socket.write('HTTP/1.1 '+status+' Forbidden\r\nConnection: close\r\n\r\n');socket.destroy();};
  const upgrade=(req,socket,head)=>{
    let url,origin;
    try{origin=originOf(ctx);url=new URL(req.url,origin);}catch{return rejectUpgrade(socket,400);}
    if(url.pathname!==apiRoot+'/ws')return;
    const cookies=cookieMap(req.headers.cookie),offered=String(req.headers['sec-websocket-protocol']||'').split(',').map(value=>value.trim());
    if(closed||req.headers.host!==new URL(origin).host||(req.headers.origin&&req.headers.origin!==origin)||!same(cookies.science_session,ctx.token)||!same(cookies.operon_csrf,csrf)||!offered.includes(protocol))return rejectUpgrade(socket,403);
    wss.handleUpgrade(req,socket,head,client=>wss.emit('connection',client,req));
  };
  return{
    csrfToken:csrf,
    attachServer(httpServer){
      if(server===httpServer)return;if(server)throw new Error('Reference UI is already attached to another server.');
      server=httpServer;server.on('upgrade',upgrade);
      heartbeat=setInterval(()=>{for(const socket of clients){if(!socket.referenceAlive){socket.terminate();continue;}socket.referenceAlive=false;socket.ping();}},30000);heartbeat.unref();
    },
    async close(){
      if(closed)return;closed=true;clearInterval(heartbeat);ctx.events?.off('update',onUpdate);server?.off('upgrade',upgrade);
      for(const socket of clients)socket.terminate();clients.clear();
      await Promise.allSettled(optionalRouters.map(module=>module.close?.()));
      await new Promise(resolve=>wss.close(resolve));
    },
  };
}
