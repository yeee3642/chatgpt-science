import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Adapter } from './adapter.mjs';

const equal=(a,b)=>{const x=Buffer.from(a||''),y=Buffer.from(b||'');return x.length===y.length&&crypto.timingSafeEqual(x,y);};
const errorBody=(message,type='invalid_request_error')=>({type:'error',error:{type,message}});
export async function startGateway({port=0,secret,adapter,dataRoot,maxBodyBytes=32*1024*1024}={}){
  if(typeof secret!=='string'||!/^[a-f0-9]{64}$/.test(secret))throw new Error('A per-launch 256-bit gateway secret is required.');
  const root=path.resolve(dataRoot||path.join(path.dirname(fileURLToPath(import.meta.url)),'state'));
  fs.mkdirSync(root,{recursive:true});
  const engine=adapter||new Adapter({cwd:root,model:process.env.SCIENCE_CHATGPT_MODEL||undefined,maxContexts:8,contextTtlMs:15*60*1000,requestTimeoutMs:15*60*1000});
  let origin='',ready=false,readinessError='Starting ChatGPT connection';
  const startup=engine.models().then(()=>{ready=true;readinessError=null;}).catch(error=>{readinessError=error.message;});
  const server=http.createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
    const send=(status,value)=>{if(!res.headersSent){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));}};
    let pathname;
    try{
      const host=req.headers.host||'';
      if(!/^127\.0\.0\.1:\d+$/.test(host)||req.headers.origin||req.headers.referer){send(403,errorBody('Only the authorized local application may connect.'));return;}
      const url=new URL(req.url,origin);pathname=url.pathname;
      if(pathname==='/health'&&req.method==='GET'){send(ready?200:503,{ok:ready,product:'Claude Science ChatGPT Bridge',version:'0.1.0',error:readinessError});return;}
      const parts=pathname.split('/');
      if(!equal(parts[1],secret)){send(403,errorBody('Invalid gateway launch token.','authentication_error'));return;}
      pathname='/'+parts.slice(2).join('/');
      if(req.method==='GET'&&pathname==='/_ready'){send(ready?200:503,{ok:ready,product:'Codex Science',pid:process.pid});return;}
      if(req.method==='POST'&&pathname==='/_shutdown'){send(200,{ok:true});setImmediate(()=>{void engine.close().finally(()=>{server.closeAllConnections?.();server.close();});});return;}
      if(req.method==='GET'&&pathname==='/v1/models'){send(200,await engine.models());return;}
      if(req.method==='GET'&&pathname.startsWith('/v1/models/')){const model=(await engine.models()).data.find(x=>x.id===decodeURIComponent(pathname.slice(11)));send(model?200:404,model||errorBody('Model is unavailable.','not_found_error'));return;}
      if(req.method!=='POST'||!['/v1/messages','/v1/messages/count_tokens'].includes(pathname)){send(404,errorBody('This compatibility gateway only implements Messages and Models.','not_found_error'));return;}
      if(!String(req.headers['content-type']||'').toLowerCase().includes('application/json')){send(415,errorBody('Content-Type must be application/json.'));return;}
      const chunks=[];let length=0;
      for await(const chunk of req){length+=chunk.length;if(length>maxBodyBytes){send(413,errorBody('Request exceeds the local gateway size limit.'));return;}chunks.push(chunk);}
      let body;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{send(400,errorBody('Invalid JSON.'));return;}
      if(pathname.endsWith('/count_tokens')){send(200,await engine.countTokens(body));return;}
      const controller=new AbortController();res.once('close',()=>{if(!res.writableEnded)controller.abort();});
      if(body.stream){
        res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Connection':'keep-alive','X-Accel-Buffering':'no'});res.flushHeaders();
        const heartbeat=setInterval(()=>{if(!res.writableEnded)res.write('event: ping\ndata: {"type":"ping"}\n\n');},15000);
        try{await engine.messages(body,{signal:controller.signal,onEvent:event=>{if(!res.writableEnded)res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);}});}catch(error){if(!res.writableEnded)res.write(`event: error\ndata: ${JSON.stringify(errorBody(error.message,'api_error'))}\n\n`);}
        finally{clearInterval(heartbeat);res.end();}
      }else{send(200,await engine.messages(body,{signal:controller.signal}));}
    }catch(error){send(error.status||400,errorBody(error.message));}
  });
  server.requestTimeout=16*60*1000;server.headersTimeout=30000;server.maxHeadersCount=60;
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  origin=`http://127.0.0.1:${server.address().port}`;
  return{origin,server,startup,async close(){await engine.close();server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));}};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const service=await startGateway({port:Number(process.env.SCIENCE_BRIDGE_PORT||0),secret:process.env.SCIENCE_BRIDGE_TOKEN,dataRoot:process.env.SCIENCE_BRIDGE_DATA});
  console.log(JSON.stringify({type:'codex-science-listening',origin:service.origin,pid:process.pid}));
  process.once('SIGTERM',()=>void service.close().finally(()=>process.exit(0)));process.once('SIGINT',()=>void service.close().finally(()=>process.exit(0)));
}
