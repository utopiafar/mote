import {constants} from 'node:fs';
import {lstat,open,readdir,realpath} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join,basename,dirname,relative,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import type {SourceOptions,SourceScan,ScannedItem} from './source-types';
import {redactSourceText} from './source-types';

export type CodingProvider='claude'|'codex'|'kimi';
export const codingProviders={claude:'Claude Code',codex:'Codex',kimi:'Kimi Code'} as const;
const hash=(s:string|Buffer)=>createHash('sha256').update(s).digest('hex');
export function codingRoot(provider:CodingProvider,home=homedir()):string {
  return join(home,provider==='claude'?'.claude/projects':provider==='codex'?'.codex/sessions':'.kimi/sessions');
}
export async function discoverCodingAgents(home=homedir()) {
  return Promise.all((Object.keys(codingProviders) as CodingProvider[]).map(async provider=>({provider,name:codingProviders[provider],path:codingRoot(provider,home),available:await lstat(codingRoot(provider,home)).then(s=>s.isDirectory()&&!s.isSymbolicLink(),()=>false)})));
}
type Context={sessionId:string;cwd?:string;parentSessionId?:string;callId?:string};
type Cursor={offset:number;anchor:string;ino:number;generation:number;context:Context};
export type CodingCheckpoint={version:1;files:Record<string,Cursor>;initialized:boolean};
type Event={role:'user'|'assistant'|'tool_call'|'tool_result'|'assistant_delta'|'tool_call_delta';text:string;callId?:string;at?:string};
const time=(v:unknown)=>{const ms=typeof v==='number'?v*1000:typeof v==='string'?Date.parse(v):NaN;return Number.isFinite(ms)?new Date(ms).toISOString():undefined;};
const textParts=(content:any):string=>typeof content==='string'?content:Array.isArray(content)?content.flatMap(p=>p?.type==='text'||p?.type==='input_text'||p?.type==='output_text'?[String(p.text??'')]:p?.type==='image'||p?.type==='input_image'||p?.type==='image_url'?['[image attachment omitted]']:[]).join('\n'):'';
/** Decode syntax only; no keywords select topics, intent or memory value. Reasoning and host instructions are not conversation evidence. */
export function decodeCodingEvent(provider:CodingProvider,row:any,context:Context,wire=false):Event[] {
  if(!row||typeof row!=='object')throw Error('Invalid transcript event');
  const at=time(row.timestamp),events:Event[]=[];
  const add=(role:Event['role'],text:string,callId?:string)=>{if(text)events.push({role,text,callId,at});};
  if(provider==='codex'){
    const p=row.payload;
    if(row.type==='session_meta'&&p){context.sessionId=String(p.id??p.session_id??context.sessionId);context.cwd=typeof p.cwd==='string'?p.cwd:context.cwd;context.parentSessionId=p.parent_thread_id;}
    if(row.type!=='response_item'||!p)return [];
    if(p.type==='message'&&['user','assistant'].includes(p.role))add(p.role,textParts(p.content));
    if(['function_call','custom_tool_call'].includes(p.type))add('tool_call',JSON.stringify({name:p.name,arguments:p.arguments??p.input}),p.call_id);
    if(['function_call_output','custom_tool_call_output'].includes(p.type))add('tool_result',typeof p.output==='string'?p.output:Array.isArray(p.output)?textParts(p.output)||JSON.stringify(p.output):JSON.stringify(p.output??''),p.call_id);
  }else if(provider==='claude'){
    if(typeof row.cwd==='string')context.cwd=row.cwd;
    if(typeof row.sessionId==='string')context.sessionId=row.sessionId;
    if(!['user','assistant'].includes(row.type)||!row.message||row.isMeta)return [];
    const m=row.message;add(row.type,textParts(m.content));
    if(Array.isArray(m.content))for(const part of m.content){
      if(part.type==='tool_use')add('tool_call',JSON.stringify({name:part.name,arguments:part.input}),part.id);
      if(part.type==='tool_result')add('tool_result',textParts(part.content),part.tool_use_id);
    }
  }else if(wire){
    const m=row.message,p=m?.payload;
    if(!m||!p)return [];
    if(m.type==='TurnBegin')add('user',textParts(p.user_input));
    if(m.type==='ContentPart'&&p.type==='text')add('assistant_delta',String(p.text??''));
    if(m.type==='ToolCall'){context.callId=p.id;add('tool_call',JSON.stringify({name:p.function?.name,arguments:p.function?.arguments}),p.id);}
    if(m.type==='ToolCallPart')add('tool_call_delta',String(p.arguments_part??''),context.callId);
    if(m.type==='ToolResult')add('tool_result',typeof p.return_value==='string'?p.return_value:JSON.stringify(p.return_value??''),p.tool_call_id);
  }else {
    if(['user','assistant','tool'].includes(row.role))add(row.role==='tool'?'tool_result':row.role,textParts(row.content),row.tool_call_id);
    if(row.role==='assistant')for(const call of row.tool_calls??[])add('tool_call',JSON.stringify(call.function),call.id);
  }
  return events;
}

/** Bounded incremental tailer. Its cursor is committed atomically with SourceSync's durable outbox. */
export async function scanCodingAgent(rootPath:string,provider:CodingProvider,options:SourceOptions,previous?:CodingCheckpoint,signal?:AbortSignal,limits={items:200,bytes:4*1024*1024}):Promise<SourceScan> {
  const selected=await lstat(rootPath);if(!selected.isDirectory()||selected.isSymbolicLink())throw Error('Agent 来源必须是普通目录');
  const root=await realpath(rootPath),checkpoint:CodingCheckpoint=structuredClone(previous??{version:1,files:{},initialized:false});
  const result:SourceScan={items:[],seen:[],complete:true,skipped:0,checkpoint};
  const files:string[]=[];let visited=0,bytes=0;
  async function visit(path:string,depth:number):Promise<void>{
    signal?.throwIfAborted();if(++visited>20000||depth>12){result.complete=false;result.skipped++;return;}
    const rel=relative(root,path).split('\\').join('/');
    if(options.excludedPaths.some(p=>rel===p||rel.startsWith(p+'/')))return;
    const info=await lstat(path);if(info.isSymbolicLink())return;
    if(info.isDirectory()){for(const entry of (await readdir(path)).sort())await visit(join(path,entry),depth+1);}
    else if(info.isFile()&&(provider==='kimi'?['wire.jsonl','context.jsonl'].includes(basename(path)):path.endsWith('.jsonl')))files.push(path);
  }
  await visit(root,0);
  // A wire journal survives context compaction. Never ingest both representations.
  const selectedFiles=files.filter(p=>provider!=='kimi'||basename(p)==='wire.jsonl'||!files.includes(join(dirname(p),'wire.jsonl')));
  for(const path of selectedFiles){
    signal?.throwIfAborted();const rel=relative(root,path),key=hash(rel),old=checkpoint.files[key];
    if(result.items.length>=limits.items||bytes>=limits.bytes){result.complete=false;break;}
    let handle;const itemStart=result.items.length,seenStart=result.seen.length;
    try{
      if(await realpath(path)!==path)throw Error('Source path changed');
      handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);const info=await handle.stat();if(!info.isFile())throw Error('Invalid source');
      const read=async(start:number,length:number)=>{const buffer=Buffer.alloc(length);const {bytesRead}=await handle!.read(buffer,0,length,start);return buffer.subarray(0,bytesRead);};
      let cursor:Cursor=old?structuredClone(old):{offset:0,anchor:hash(''),ino:info.ino,generation:0,context:{sessionId:provider==='kimi'?basename(dirname(path)):basename(path,'.jsonl')}};
      if(old&&(info.ino!==old.ino||info.size<old.offset||hash(await read(Math.max(0,old.offset-256),Math.min(old.offset,256)))!==old.anchor))cursor={offset:0,anchor:hash(''),ino:info.ino,generation:old.generation+1,context:{sessionId:old.context.sessionId}};
      if(!checkpoint.initialized&&!old&&options.initialSync==='new_only'){
        // Baseline only complete lines so a currently partial message is picked up later.
        const header=await read(0,Math.min(info.size,65536));for(const line of header.toString('utf8').split('\n').slice(0,-1)){try{decodeCodingEvent(provider,JSON.parse(line),cursor.context,basename(path)==='wire.jsonl');}catch{break;}}
        const tail=await read(Math.max(0,info.size-4*1024*1024),Math.min(info.size,4*1024*1024));
        const end=tail.lastIndexOf(10);cursor.offset=end<0?0:Math.max(0,info.size-tail.length)+end+1;
      }else if(cursor.offset<info.size){
        // One event may be large; never truncate it or advance over a partial line.
        const buffer=await read(cursor.offset,Math.min(info.size-cursor.offset,4*1024*1024));let start=0;
        while(start<buffer.length){
          signal?.throwIfAborted();const end=buffer.indexOf(10,start);if(end<0){result.complete=false;if(buffer.length===4*1024*1024)result.skipped++;break;}
          const raw=buffer.subarray(start,end),context=structuredClone(cursor.context);
          let events:Event[];
          try{const row=raw.length?JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw)):{};events=decodeCodingEvent(provider,row,context,basename(path)==='wire.jsonl');}
          catch{result.complete=false;result.skipped++;break;}
          const items:ScannedItem[]=[];
          for(const [eventIndex,event] of events.entries()){
            const eventId=hash(`${key}:${cursor.generation}:${cursor.offset}:${eventIndex}`),body=redactSourceText(event.text,options.redactLiterals);
            const pieces:string[]=[];for(let offset=0;offset<body.length;){let end=Math.min(offset+8000,body.length);if(end<body.length&&/[\uD800-\uDBFF]/.test(body[end-1]))end--;pieces.push(body.slice(offset,end));offset=end;}
            const cwd=context.cwd?redactSourceText(context.cwd,options.redactLiterals):undefined;
            for(const [part,text] of pieces.entries())items.push({externalId:`coding:${provider}:${eventId}:${part}`,kind:'message',layer:options.retention,title:`${codingProviders[provider]} · ${redactSourceText(context.sessionId,options.redactLiterals).slice(0,80)} · ${event.role}`,text:options.retention==='reference'?'':text,mimeType:'text/plain',document:{contentRole:'transcript',timeBasis:event.at?'recorded':'unknown',recordedAt:event.at,coding:{version:1,provider,sessionId:redactSourceText(context.sessionId,options.redactLiterals).slice(0,500),projectKey:hash(context.cwd??`${provider}:${context.sessionId}`),cwd,eventId,role:event.role,callId:event.callId?redactSourceText(event.callId,options.redactLiterals).slice(0,500):undefined,parentSessionId:context.parentSessionId?redactSourceText(context.parentSessionId,options.redactLiterals).slice(0,500):undefined,part,parts:pieces.length}}});
          }
          if(result.items.length+items.length>Math.max(limits.items,500)||bytes+raw.length>Math.max(limits.bytes,4*1024*1024)){result.complete=false;break;}
          result.items.push(...items);result.seen.push(...items.map(i=>i.externalId));bytes+=raw.length;
          cursor.context=context;cursor.offset+=end-start+1;start=end+1;
          if(result.items.length>=limits.items||bytes>=limits.bytes){result.complete=false;break;}
        }
      }
      cursor.anchor=hash(await read(Math.max(0,cursor.offset-256),Math.min(cursor.offset,256)));
      if(await realpath(path)!==path)throw Error('Source path changed');
      checkpoint.files[key]=cursor;
    }catch(error){if(signal?.aborted)throw error;result.items.splice(itemStart);result.seen.splice(seenStart);result.complete=false;result.skipped++;}
    finally{await handle?.close();}
  }
  // new_only must not sweep all history again on the second page.
  if(result.complete)checkpoint.initialized=true;
  return result;
}
