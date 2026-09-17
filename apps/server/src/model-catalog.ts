import { moteText } from './i18n.js';
import {spawn} from 'node:child_process';
import {tmpdir} from 'node:os';
import type {ModelSettings} from '@mote/shared/models';
import {StoreError} from './store.js';
export interface CatalogModel {id:string;name:string;reasoningEfforts?:string[]}
export class ModelCatalogError extends StoreError {constructor(){super(moteText("无法读取模型列表。请检查节点上的服务、凭据及目录接口；仍可手动填写模型 ID。"),502);}}
const failure=()=>new ModelCatalogError();

/** Read-only JSON-RPC: initializes the local server and calls model/list, never starts a thread. */
export async function codexModels(launch:typeof spawn=spawn,options:{executable?:string;home?:string}={}):Promise<{items:CatalogModel[]}> {
  const child=launch(options.executable??process.env.MOTE_CODEX_BIN??'codex',['app-server'],{cwd:tmpdir(),...(options.home?{env:{...process.env,CODEX_HOME:options.home}}:{}),stdio:['pipe','pipe','pipe']});
  const items:CatalogModel[]=[];
  let buffer='',bytes=0,nextId=1;
  return new Promise((resolve,reject)=>{
    let settled=false;
    const finish=(error?:unknown)=>{
      if(settled)return;settled=true;clearTimeout(deadline);
      child.stdin?.end();child.kill('SIGTERM');
      const kill=setTimeout(()=>child.kill('SIGKILL'),1000);kill.unref();child.once('close',()=>clearTimeout(kill));
      if(error)reject(failure());else resolve({items});
    };
    const deadline=setTimeout(()=>finish(failure()),20000);
    const send=(method:string,params:unknown,id?:number)=>child.stdin?.write(JSON.stringify({...(id!==undefined?{id}:{}),method,params})+'\n');
    child.on('error',finish);child.on('exit',()=>{if(!settled)finish(failure());});child.stdin?.on('error',finish);
    child.stderr?.on('data',()=>{});
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data',(chunk:string)=>{
      bytes+=Buffer.byteLength(chunk);if(bytes>2*1024*1024){finish(failure());return;}
      buffer+=chunk;
      let at:number;
      while((at=buffer.indexOf('\n'))>=0&&!settled){
        const line=buffer.slice(0,at);buffer=buffer.slice(at+1);if(!line.trim())continue;
        try{
          const message=JSON.parse(line);if(message.error){finish(failure());return;}
          if(message.id===0){send('initialized',{});send('model/list',{limit:100,includeHidden:false},nextId);}
          else if(message.id===nextId&&message.result){
            if(!Array.isArray(message.result.data))throw Error();
            for(const model of message.result.data){if(typeof model.model==='string'&&model.model.length<=512&&!items.some(i=>i.id===model.model))items.push({id:model.model,name:typeof model.displayName==='string'?model.displayName.slice(0,512):model.model,reasoningEfforts:Array.isArray(model.supportedReasoningEfforts)?model.supportedReasoningEfforts.map((e:{reasoningEffort:string})=>e.reasoningEffort):[]});}
            if(message.result.nextCursor&&nextId<20){nextId++;send('model/list',{limit:100,includeHidden:false,cursor:message.result.nextCursor},nextId);}else if(message.result.nextCursor)finish(failure());else finish();
          }
        }catch{finish(failure());}
      }
    });
    send('initialize',{clientInfo:{name:'mote-model-catalog',version:'1.0.0'},capabilities:{}},0);
  });
}

export async function providerModels(settings:ModelSettings,transport:typeof fetch=fetch):Promise<{items:CatalogModel[]}> {
  const base=settings.baseUrl.replace(/\/+$/,''),headers=new Headers(settings.headers);
  if(settings.protocol==='anthropic-messages'){
    if(!headers.has('x-api-key'))headers.set('x-api-key',settings.apiKey);
    if(!headers.has('anthropic-version'))headers.set('anthropic-version','2023-06-01');
  }else if(settings.protocol==='google-generative-ai'){
    if(!headers.has('x-goog-api-key'))headers.set('x-goog-api-key',settings.apiKey);
  }else if(settings.provider==='azure-openai'){
    if(!headers.has('api-key'))headers.set('api-key',settings.apiKey);
  }else if(settings.apiKey&&!headers.has('authorization'))headers.set('authorization',`Bearer ${settings.apiKey}`);
  const path=settings.protocol==='anthropic-messages'&&!base.endsWith('/v1')?'/v1/models':'/models';
  const items:CatalogModel[]=[];let cursor:string|undefined;
  const signal=AbortSignal.timeout(20000);
  try{
    for(let page=0;page<20;page++){
      const url=new URL(base+path);
      if(cursor)url.searchParams.set(settings.protocol==='google-generative-ai'?'pageToken':'after_id',cursor);
      const response=await transport(url,{headers,signal,redirect:'error'});
      if(!response.ok){await response.body?.cancel();throw Error();}
      const reader=response.body?.getReader();if(!reader)throw Error();
      const chunks:Uint8Array[]=[];let size=0;
      try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>2*1024*1024)throw Error();chunks.push(value);}}finally{await reader.cancel();}
      const data=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const models=settings.protocol==='google-generative-ai'?data.models:data.data;
      if(!Array.isArray(models))throw Error();
      for(const model of models){
        if(settings.protocol==='google-generative-ai'&&Array.isArray(model.supportedGenerationMethods)&&!model.supportedGenerationMethods.includes('generateContent'))continue;
        const id=settings.protocol==='google-generative-ai'?model.name?.replace(/^models\//,''):model.id;
        if(typeof id==='string'&&id.length&&id.length<=512&&!items.some(m=>m.id===id))items.push({id,name:String(model.display_name??model.displayName??id).slice(0,512)});
      }
      cursor=settings.protocol==='google-generative-ai'?data.nextPageToken:data.has_more?data.last_id:undefined;
      if(!cursor)return {items:items.sort((a,b)=>a.id.localeCompare(b.id))};
    }
    throw Error();
  }catch{throw failure();}
}
