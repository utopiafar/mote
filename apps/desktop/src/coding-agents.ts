import type { CodingProvider } from './contracts/sources';
export type { CodingProvider } from './contracts/sources';
import { moteText } from '@mote/shared/i18n';
import {codingHostEnvelope,MAX_CODING_DIALOGUE_MESSAGE_CHARACTERS,type CodingEvidence} from '@mote/shared';
import {constants,lstatSync} from 'node:fs';
import {lstat,open,readdir,realpath} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join,basename,dirname,relative,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import type {SourceOptions,SourceScan,ScannedItem} from './source-types';
import {redactSourceText} from './source-types';
import {repositoryCandidate} from './coding-project';

export const codingProviders={claude:'Claude Code',codex:'Codex',kimi:'Kimi Code',opencode:'OpenCode'} as const;
const hash=(s:string|Buffer)=>createHash('sha256').update(s).digest('hex');
export function openCodeDatabasePath(home=homedir(),env:NodeJS.ProcessEnv=process.env):string {
  if(env.OPENCODE_DB)return resolve(env.OPENCODE_DB);
  const data=env.OPENCODE_DATA_HOME?resolve(env.OPENCODE_DATA_HOME):env.XDG_DATA_HOME?join(resolve(env.XDG_DATA_HOME),'opencode'):join(home,'.local/share/opencode');
  return join(data,'opencode.db');
}
export function codingRoot(provider:CodingProvider,home=homedir(),env:NodeJS.ProcessEnv=process.env):string {
  if(provider==='opencode')return openCodeDatabasePath(home,env);
  if(provider!=='kimi')return join(home,provider==='claude'?'.claude/projects':'.codex/sessions');
  if(env.KIMI_CODE_HOME)return join(resolve(env.KIMI_CODE_HOME),'sessions');
  const current=join(home,'.kimi-code','sessions'),cli=join(home,'.kimi','sessions');
  const directory=(path:string)=>{try{return lstatSync(path).isDirectory();}catch{return false;}};
  return directory(current)||!directory(cli)?current:cli;
}
export async function discoverCodingAgents(home=homedir(),env:NodeJS.ProcessEnv=process.env): Promise<import('./contracts/sources').CodingAgentDiscovery[]> {
  return Promise.all((Object.keys(codingProviders) as CodingProvider[]).map(async provider=>{const path=codingRoot(provider,home,env);return {provider,name:codingProviders[provider],path,available:await lstat(path).then(s=>provider==='opencode'?s.isFile()&&!s.isSymbolicLink():s.isDirectory()&&!s.isSymbolicLink(),()=>false)};}));
}
type Context={sessionId:string;cwd?:string;repositoryKey?:string;branch?:string;parentSessionId?:string;callId?:string;hostSession?:boolean;turnId?:string;finalEmitted?:boolean;kimiText?:string;kimiOverflow?:boolean;kimiAt?:string;kimiToolStep?:boolean;kimiHostTurn?:boolean;kimiCodeTurnId?:string};
type Cursor={offset:number;anchor:string;ino:number;size:number;mtimeMs:number;ctimeMs:number;quickHash:string;generation:number;context:Context;pendingEvent?:{hash:string;nextItem:number}};
export type CodingCatalogEntry={relativePath:string;fileId:string;size:number;mtimeMs:number;ctimeMs:number;quickHash:string;contentHash?:string;lastSeenScan:number;syncState:'pending'|'synced'|'error'};
export type CodingOpenCodeCursor={lastSeq:number;lastUpdated:number;incomplete:string[];continuation?:{id:string;hash:string;nextItem:number}};
export type CodingOpenCodeState={database:{fileId:string};sessions:Record<string,CodingOpenCodeCursor>};
export type CodingCheckpoint={version:3;files:Record<string,Cursor>;initialized:boolean;catalog:Record<string,CodingCatalogEntry>;scanNumber:number;scanStartedAt:string;nextFile?:string;opencode?:CodingOpenCodeState};
type Event={role:'user'|'assistant'|'tool_call'|'tool_result'|'assistant_delta'|'tool_call_delta';text:string;callId?:string;at?:string;channel?:string;nativeId?:string;attribution?:CodingEvidence['attribution']};
const time=(v:unknown)=>{const ms=typeof v==='number'?(v>1e11?v:v*1000):typeof v==='string'?Date.parse(v):NaN;return Number.isFinite(ms)?new Date(ms).toISOString():undefined;};
const textParts=(content:any):string=>typeof content==='string'?content:Array.isArray(content)?content.flatMap(p=>p?.type==='text'||p?.type==='input_text'||p?.type==='output_text'?[String(p.text??'')]:p?.type==='image'||p?.type==='input_image'||p?.type==='image_url'?['[image attachment omitted]']:[]).join('\n'):'';
/** Decode syntax only; no keywords select topics, intent or memory value. Reasoning and host instructions are not conversation evidence. */
export function decodeCodingEvent(provider:CodingProvider,row:any,context:Context,wire=false):Event[] {
  if(!row||typeof row!=='object')throw Error('Invalid transcript event');
  const at=time(row.timestamp??row.time),events:Event[]=[];
  const add=(role:Event['role'],text:string,callId?:string,channel?:unknown)=>{if(text)events.push({role,text,callId,at,
    ...(typeof channel==='string'&&channel.length&&channel.length<=64?{channel}:{}),
    ...(['user','assistant','assistant_delta'].includes(role)?{attribution:context.hostSession?'host':role==='user'?(codingHostEnvelope(provider,text)?'host':'human'):'agent'}:{})});};
  if(provider==='codex'){
    const p=row.payload;
    if(row.type==='session_meta'&&p){context.sessionId=String(p.id??p.session_id??context.sessionId);context.cwd=typeof p.cwd==='string'?p.cwd:context.cwd;context.parentSessionId=p.parent_thread_id;context.hostSession=Boolean(p.source&&typeof p.source==='object'&&p.source.subagent);context.repositoryKey=repositoryCandidate(p.git?.repository_url);context.branch=typeof p.git?.branch==='string'?p.git.branch:undefined;}
    if(context.hostSession)return [];
    if(row.type==='event_msg'&&p?.type==='task_started'){context.turnId=p.turn_id;context.finalEmitted=false;}
    // Older journals omit message phase but provide an explicit turn-completion
    // receipt. Use only its final answer, never the preceding message stream.
    if(row.type==='event_msg'&&p?.type==='task_complete'&&!context.finalEmitted&&typeof p.last_agent_message==='string'){
      add('assistant',p.last_agent_message,undefined,'final');context.finalEmitted=true;
      for(const event of events)event.nativeId=String(p.turn_id??context.turnId??'')||undefined;
      return events;
    }
    if(row.type!=='response_item'||!p)return [];
    if(p.type==='message'&&['user','assistant'].includes(p.role)){
      const channel=p.role==='assistant'?(p.phase==='final_answer'?'final':p.phase??p.channel??'unknown'):p.channel;
      add(p.role,textParts(p.content),undefined,channel);
      if(channel==='final')context.finalEmitted=true;
    }
    if(['function_call','custom_tool_call'].includes(p.type))add('tool_call',JSON.stringify({name:p.name,arguments:p.arguments??p.input}),p.call_id);
    if(['function_call_output','custom_tool_call_output'].includes(p.type))add('tool_result',typeof p.output==='string'?p.output:Array.isArray(p.output)?textParts(p.output)||JSON.stringify(p.output):JSON.stringify(p.output??''),p.call_id);
    for(const event of events)if(typeof p.id==='string'&&p.id)event.nativeId=p.id;
  }else if(provider==='claude'){
    if(typeof row.cwd==='string')context.cwd=row.cwd;
    if(typeof row.sessionId==='string')context.sessionId=row.sessionId;
    if(typeof row.gitBranch==='string')context.branch=row.gitBranch;
    // Sidechain journals repeat the parent's UUIDs. Do not let a process copy
    // replace the canonical human/final message in the upload outbox.
    if(row.isSidechain||row.agentId)return [];
    if(!['user','assistant'].includes(row.type)||!row.message)return [];
    const m=row.message,host=row.isMeta||row.isCompactSummary||row.isVisibleInTranscriptOnly||row.userType==='internal'||row.type==='user'&&Array.isArray(m.content)&&m.content.some((part:any)=>part.type==='tool_result');
    const hasTools=Array.isArray(m.content)&&m.content.some((part:any)=>['tool_use','server_tool_use'].includes(part.type));
    const channel=!host&&!hasTools&&['end_turn','stop_sequence'].includes(m.stop_reason)?'final':'analysis';
    add(row.type,textParts(m.content),undefined,row.type==='assistant'?channel:undefined);
    if(host)for(const event of events)event.attribution='host';
    if(Array.isArray(m.content))for(const part of m.content){
      if(part.type==='tool_use')add('tool_call',JSON.stringify({name:part.name,arguments:part.input}),part.id);
      if(part.type==='tool_result')add('tool_result',textParts(part.content),part.tool_use_id);
    }
    for(const event of events)if(typeof row.uuid==='string'&&row.uuid)event.nativeId=row.uuid;
  }else if(provider==='opencode'){
    const data=row.data;
    if(!data||typeof data!=='object')return [];
    const messageId=typeof row.id==='string'?row.id:'';
    const native=(suffix:string)=>messageId?`${messageId}:${suffix}`:undefined;
    if(['user','system','synthetic'].includes(row.type)&&typeof data.text==='string'){
      add('user',data.text);
      if(events.length){
        events.at(-1)!.nativeId=native('text');
        if(row.type!=='user')events.at(-1)!.attribution='host';
      }
    }
    if(row.type==='assistant'){
      const content=Array.isArray(data.content)?data.content:[],hasTools=content.some((part:any)=>part?.type==='tool');
      for(const [index,part] of content.entries()){
        if(part?.type==='text'&&typeof part.text==='string'&&part.text){
          add('assistant',part.text,undefined,hasTools?'commentary':data.finish==='stop'?'final':'unknown');
          events.at(-1)!.at=time(part.time?.created)??at;events.at(-1)!.nativeId=native(`${index}:text`);
        }
        if(part?.type==='tool'){
          const state=part.state&&typeof part.state==='object'?part.state:{},callId=typeof part.id==='string'?part.id:undefined;
          add('tool_call',JSON.stringify({name:part.name,arguments:state.input}),callId);
          events.at(-1)!.at=time(part.time?.created)??at;events.at(-1)!.nativeId=native(`${index}:call`);
          if(state.status!=='running'){
            const output=textParts(state.content)||(typeof state.error?.message==='string'?state.error.message:state.error?JSON.stringify(state.error):'');
            if(output){
              add('tool_result',output,callId);
              events.at(-1)!.at=time(state.time?.completed??part.time?.completed??part.time?.created)??at;events.at(-1)!.nativeId=native(`${index}:result`);
            }
          }
        }
      }
    }
  }else if(wire&&typeof row.type==='string'){
    // Kimi Code persists prompts and loop events separately. The matching
    // context.append_message is a duplicate, and need not be imported.
    const clearStep=()=>{context.kimiText='';context.kimiOverflow=false;context.kimiAt=undefined;};
    if(row.type==='config.update'&&typeof row.cwd==='string')context.cwd=row.cwd;
    if(row.type==='turn.prompt'||row.type==='turn.steer'){
      // Only explicitly tagged skill and hook parts can be separated from a
      // human prompt. Keep unmarked, ambiguous input in the private archive.
      const origin=row.origin,parts=Array.isArray(row.input)?row.input:[];
      const activations=Array.isArray(origin?.skillActivations)?origin.skillActivations.length:0;
      const tagged=parts.filter((part:any)=>part?.type==='text'&&part?.meta?.source==='skill activation').length;
      const ambiguous=activations>tagged,hostSteer=row.type==='turn.steer'&&context.kimiHostTurn!==false;
      if(row.type==='turn.prompt'){clearStep();context.kimiToolStep=false;context.kimiHostTurn=origin?.kind!=='user'||ambiguous;context.kimiCodeTurnId=row.turnId==null?undefined:String(row.turnId);}
      const userParts=parts.filter((part:any)=>!['skill activation','user prompt submit hook'].includes(part?.meta?.source));
      add('user',textParts(userParts));
      if(origin?.kind!=='user'||hostSteer)for(const event of events)event.attribution='host';
      else if(ambiguous)for(const event of events)event.attribution='unknown';
    }
    if(row.type==='context.append_loop_event'){
      const event=row.event;
      if(event?.type==='step.begin'){clearStep();context.kimiToolStep=false;if(event.turnId!=null)context.kimiCodeTurnId=String(event.turnId);}
      if(event?.type==='content.part'&&event.part?.type==='text'&&typeof event.part.text==='string'){
        const text=event.part.text;add('assistant_delta',text,undefined,'commentary');
        if(context.kimiHostTurn!==false)for(const output of events)output.attribution='host';
        if(!context.kimiToolStep){context.kimiAt??=at;if((context.kimiText?.length??0)+text.length>MAX_CODING_DIALOGUE_MESSAGE_CHARACTERS){context.kimiOverflow=true;context.kimiText='';}else if(!context.kimiOverflow)context.kimiText=(context.kimiText??'')+text;}
      }
      if(event?.type==='tool.call'){clearStep();context.kimiToolStep=true;add('tool_call',JSON.stringify({name:event.name,arguments:event.args}),event.toolCallId);}
      if(event?.type==='tool.result')add('tool_result',typeof event.result==='string'?event.result:JSON.stringify(event.result??''),event.toolCallId);
      if(event?.type==='step.end'&&['interrupted','error'].includes(event.finishReason)){clearStep();context.kimiToolStep=true;}
    }
    if(row.type==='turn.ended'){
      if(context.kimiCodeTurnId&&row.turnId!=null&&context.kimiCodeTurnId!==String(row.turnId))return events;
      if(row.reason==='completed'&&!context.kimiToolStep&&!context.kimiOverflow&&context.kimiText){add('assistant',context.kimiText,undefined,'final');events.at(-1)!.at=context.kimiAt??at;if(context.kimiHostTurn!==false)events.at(-1)!.attribution='host';}
      clearStep();context.kimiToolStep=false;context.kimiHostTurn=undefined;context.kimiCodeTurnId=undefined;
    }
  }else if(wire){
    const m=row.message,p=m?.payload;
    if(!m||!p)return [];
    if(['TurnBegin','StepBegin','ToolCall','TurnInterrupted'].includes(m.type)){context.kimiText='';context.kimiOverflow=false;context.kimiAt=undefined;}
    if(m.type==='TurnBegin')add('user',textParts(p.user_input));
    if(m.type==='ContentPart'&&p.type==='text'){
      const text=String(p.text??'');add('assistant_delta',text,undefined,'commentary');
      context.kimiAt??=at;
      if((context.kimiText?.length??0)+text.length>MAX_CODING_DIALOGUE_MESSAGE_CHARACTERS){context.kimiOverflow=true;context.kimiText='';}
      else if(!context.kimiOverflow)context.kimiText=(context.kimiText??'')+text;
    }
    if(m.type==='TurnEnd'){
      if(!context.kimiOverflow&&context.kimiText){add('assistant',context.kimiText,undefined,'final');events.at(-1)!.at=context.kimiAt??at;}
      context.kimiText='';context.kimiOverflow=false;context.kimiAt=undefined;
    }
    if(m.type==='ToolCall'){context.callId=p.id;add('tool_call',JSON.stringify({name:p.function?.name,arguments:p.function?.arguments}),p.id);}
    if(m.type==='ToolCallPart')add('tool_call_delta',String(p.arguments_part??''),context.callId);
    if(m.type==='ToolResult')add('tool_result',typeof p.return_value==='string'?p.return_value:JSON.stringify(p.return_value??''),p.tool_call_id);
  }else {
    if(['user','assistant','tool'].includes(row.role))add(row.role==='tool'?'tool_result':row.role,textParts(row.content),row.tool_call_id,row.role==='assistant'?(row.finish_reason==='stop'&&!row.tool_calls?.length?'final':'unknown'):undefined);
    if(row.role==='assistant')for(const call of row.tool_calls??[])add('tool_call',JSON.stringify(call.function),call.id);
  }
  return events;
}

/** Bounded output pieces for one decoded event. Native identity plus the
 * immutable raw-event version stay independent of scan scheduling. */
function codingEventItems(provider:CodingProvider,context:Context,events:Event[],eventHash:string,identityPrefix:string,itemQueue:'realtime'|'history',options:SourceOptions,signal?:Pick<AbortSignal,'aborted'|'throwIfAborted'>):ScannedItem[]{
  const bodies=events.map(event=>{
    const body=redactSourceText(event.text,options.redactLiterals),pieces:string[]=[];
    for(let offset=0;offset<body.length;){signal?.throwIfAborted();let end=Math.min(offset+8000,body.length);if(end<body.length&&/[\uD800-\uDBFF]/.test(body[end-1]))end--;pieces.push(body.slice(offset,end));offset=end;}
    return {event,pieces};
  });
  const items:ScannedItem[]=[];
  for(const [eventIndex,{event,pieces}] of bodies.entries()){
    const identity=event.nativeId?`${provider}:${context.sessionId}:${event.nativeId}:${eventIndex}`:`${identityPrefix}:${eventIndex}`;
    const eventId=hash(`${identity}:${eventHash}`);
    const cwd=context.cwd?redactSourceText(context.cwd,options.redactLiterals):undefined;
    for(const [part,text] of pieces.entries())items.push({externalId:`coding:${provider}:${eventId}:${part}`,kind:'message',layer:options.retention==='reference'?'reference':'snapshot',title:`${codingProviders[provider]} · ${redactSourceText(context.sessionId,options.redactLiterals).slice(0,80)} · ${event.role}`,text:options.retention==='reference'?'':text,mimeType:'text/plain',syncQueue:itemQueue,document:{contentRole:'transcript',timeBasis:event.at?'recorded':'unknown',recordedAt:event.at,coding:{version:1,provider,sessionId:redactSourceText(context.sessionId,options.redactLiterals).slice(0,500),projectIdentity:context.cwd?'workspace':'session',projectKey:hash(context.cwd??`${provider}:${context.sessionId}`),cwd,projectName:cwd?basename(cwd).slice(0,400):undefined,repositoryKey:context.repositoryKey,branch:context.branch?redactSourceText(context.branch,options.redactLiterals).slice(0,500):undefined,eventId,role:event.role,...(event.channel?{channel:event.channel}:{}),...(event.attribution?{attribution:event.attribution}:{}),callId:event.callId?redactSourceText(event.callId,options.redactLiterals).slice(0,500):undefined,parentSessionId:context.parentSessionId?redactSourceText(context.parentSessionId,options.redactLiterals).slice(0,500):undefined,part,parts:pieces.length}}});
  }
  return items;
}

/** Incremental complete-event reader with bounded, durable output-piece turns.
 * Event-piece continuation and the cursor commit atomically with SourceSync's outbox. */
export async function scanCodingAgent(rootPath:string,provider:CodingProvider,options:SourceOptions,previous?:CodingCheckpoint,signal?:Pick<AbortSignal,'aborted'|'throwIfAborted'>,limits={items:200,bytes:4*1024*1024}):Promise<SourceScan> {
  if(provider==='opencode')return scanOpenCodeDatabase(rootPath,options,previous,signal,limits);
  const selected=await lstat(rootPath);if(!selected.isDirectory()||selected.isSymbolicLink())throw Error(moteText("Agent 来源必须是普通目录"));
  const root=await realpath(rootPath),priorScanStartedAt=previous?.scanStartedAt,checkpoint:CodingCheckpoint=structuredClone(previous??{version:3,files:{},initialized:false,catalog:{},scanNumber:0,scanStartedAt:new Date().toISOString()});
  if(checkpoint.version!==3||!checkpoint.catalog||!Number.isSafeInteger(checkpoint.scanNumber)||!Number.isFinite(Date.parse(checkpoint.scanStartedAt)))throw Error('Unsupported Coding checkpoint format; reset the source state before scanning');
  for(const cursor of Object.values(checkpoint.files))if(![cursor.size,cursor.mtimeMs,cursor.ctimeMs].every(Number.isFinite)||typeof cursor.quickHash!=='string'||cursor.pendingEvent&&(!/^[a-f0-9]{64}$/.test(cursor.pendingEvent.hash)||!Number.isSafeInteger(cursor.pendingEvent.nextItem)||cursor.pendingEvent.nextItem<0))throw Error('Unsupported Coding cursor format; reset the source state before scanning');
  checkpoint.scanNumber++;checkpoint.scanStartedAt=new Date().toISOString();
  const result:SourceScan={items:[],seen:[],complete:true,skipped:0,checkpoint,queue:previous?.initialized?'realtime':options.initialSync==='new_only'?'realtime':'history'};
  const files:{path:string;relativePath:string;size:number;mtimeMs:number;ctimeMs:number;ino:number;fileId:string;quickHash:string}[]=[];let visited=0,bytes=0;
  async function visit(path:string,depth:number):Promise<void>{
    signal?.throwIfAborted();if(++visited>20000||depth>12){result.complete=false;result.skipped++;return;}
    const rel=relative(root,path).split('\\').join('/');
    if(options.excludedPaths.some(p=>rel===p||rel.startsWith(p+'/')))return;
    // Both Kimi CLI and Kimi Code store delegated conversations separately.
    if(provider==='kimi'&&(rel.split('/').includes('subagents')||/\/agents\/(?!main(?:\/|$))[^/]+(?:\/|$)/.test('/'+rel)))return;
    const info=await lstat(path);if(info.isSymbolicLink())return;
    if(info.isDirectory()){for(const entry of (await readdir(path)).sort())await visit(join(path,entry),depth+1);}
    else if(info.isFile()&&(provider==='kimi'?['wire.jsonl','context.jsonl'].includes(basename(path)):path.endsWith('.jsonl'))){
      const relativePath=rel.split('\\').join('/'),fileId=`${info.dev}:${info.ino}`,quickHash=hash(`${fileId}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`);
      files.push({path,relativePath,size:info.size,mtimeMs:info.mtimeMs,ctimeMs:info.ctimeMs,ino:info.ino,fileId,quickHash});
    }
  }
  await visit(root,0);
  // A wire journal survives context compaction. Never ingest both representations.
  const selectedFiles=files.filter(entry=>provider!=='kimi'||basename(entry.path)==='wire.jsonl'||!files.some(other=>other.path===join(dirname(entry.path),'wire.jsonl')));
  const cursorIndex=checkpoint.nextFile?selectedFiles.findIndex(entry=>entry.relativePath===checkpoint.nextFile):-1;
  const rotated=cursorIndex<0?selectedFiles:[...selectedFiles.slice(cursorIndex+1),...selectedFiles.slice(0,cursorIndex+1)];
  // New or growing journals jump ahead of the historical round-robin cursor.
  const urgent=rotated.filter(entry=>{const old=checkpoint.files[hash(entry.relativePath)],catalog=checkpoint.catalog[entry.relativePath];return !catalog||(priorScanStartedAt!==undefined&&entry.mtimeMs>=Date.parse(priorScanStartedAt))||(old!==undefined&&entry.size>old.offset);});
  const routine=rotated.filter(entry=>!urgent.includes(entry));
  const orderedFiles=[...urgent,...routine];
  for(const entry of orderedFiles){
    const path=entry.path;signal?.throwIfAborted();const rel=entry.relativePath,key=hash(rel),old=checkpoint.files[key];
    if(result.items.length>=limits.items||bytes>=limits.bytes){result.complete=false;break;}
    let handle;const itemStart=result.items.length,seenStart=result.seen.length;
    try{
      if(await realpath(path)!==path)throw Error('Source path changed');
      handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);const info=await handle.stat();if(!info.isFile())throw Error('Invalid source');
      const read=async(start:number,length:number)=>{const buffer=Buffer.alloc(length);const {bytesRead}=await handle!.read(buffer,0,length,start);return buffer.subarray(0,bytesRead);};
      const parent=dirname(path),sessionId=provider==='kimi'?(basename(parent)==='main'&&basename(dirname(parent))==='agents'?basename(dirname(dirname(parent))):basename(parent)):basename(path,'.jsonl');
      let cursor:Cursor=old?structuredClone(old):{offset:0,anchor:hash(''),ino:info.ino,size:info.size,mtimeMs:info.mtimeMs,ctimeMs:info.ctimeMs,quickHash:entry.quickHash,generation:0,context:{sessionId}};
      if(old&&(info.ino!==old.ino||info.size<old.offset||hash(await read(Math.max(0,old.offset-256),Math.min(old.offset,256)))!==old.anchor))cursor={offset:0,anchor:hash(''),ino:info.ino,size:info.size,mtimeMs:info.mtimeMs,ctimeMs:info.ctimeMs,quickHash:entry.quickHash,generation:old.generation+1,context:{sessionId:old.context.sessionId}};
      const itemQueue: 'realtime'|'history' = old && info.size>old.offset ? 'realtime' : checkpoint.catalog[rel] && priorScanStartedAt && info.mtimeMs>=Date.parse(priorScanStartedAt) ? 'realtime' : checkpoint.initialized ? 'realtime' : 'history';
      if(!checkpoint.initialized&&!old&&options.initialSync==='new_only'){
        // Baseline only complete lines so a currently partial message is picked up later.
        const header=await read(0,Math.min(info.size,65536));for(const line of header.toString('utf8').split('\n').slice(0,-1)){try{decodeCodingEvent(provider,JSON.parse(line),cursor.context,basename(path)==='wire.jsonl');}catch{break;}}
        let end=info.size;cursor.offset=0;
        while(end>0){signal?.throwIfAborted();const start=Math.max(0,end-65536),tail=await read(start,end-start),newline=tail.lastIndexOf(10);if(newline>=0){cursor.offset=start+newline+1;break;}end=start;}
      }else if(cursor.offset<info.size){
        // Read complete JSONL events in chunks, then emit a bounded prefix of
        // their pieces. No raw partial content enters the persisted checkpoint.
        let buffer=Buffer.alloc(0),position=cursor.offset;
        const nextLine=async():Promise<Buffer|undefined>=>{
          const chunks:Buffer[]=[];let length=0;
          while(true){
            signal?.throwIfAborted();
            const newline=buffer.indexOf(10);
            if(newline>=0){const tail=buffer.subarray(0,newline);chunks.push(tail);length+=tail.length;buffer=buffer.subarray(newline+1);return Buffer.concat(chunks,length);}
            if(buffer.length){chunks.push(buffer);length+=buffer.length;buffer=Buffer.alloc(0);}
            if(position>=info.size)return undefined;
            buffer=await read(position,Math.min(info.size-position,65536));position+=buffer.length;
            if(!buffer.length)return undefined;
          }
        };
        while(cursor.offset<info.size){
          const raw=await nextLine();if(raw===undefined){result.complete=false;break;}
          const context=structuredClone(cursor.context);
          let events:Event[];
          try{const row=raw.length?JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw)):{};events=decodeCodingEvent(provider,row,context,basename(path)==='wire.jsonl');}
          catch{result.complete=false;result.skipped++;break;}
          const eventHash=hash(raw);
          if(cursor.pendingEvent&&cursor.pendingEvent.hash!==eventHash){cursor.generation++;delete cursor.pendingEvent;}
          // Changed input cannot complete earlier event pieces.
          const items=codingEventItems(provider,context,events,eventHash,`${key}:${cursor.generation}:${cursor.offset}`,itemQueue,options,signal);
          let nextItem=cursor.pendingEvent?.nextItem??0;
          if(nextItem>items.length)throw Error('Invalid Coding event continuation');
          const bytesBefore=bytes;
          while(nextItem<items.length){
            signal?.throwIfAborted();if(result.items.length>=limits.items||bytes>bytesBefore&&bytes>=limits.bytes)break;
            const item=items[nextItem++]!;result.items.push(item);result.seen.push(item.externalId);bytes+=Buffer.byteLength(item.text,'utf8');
          }
          if(nextItem<items.length){cursor.pendingEvent={hash:eventHash,nextItem};result.complete=false;break;}
          delete cursor.pendingEvent;cursor.context=context;cursor.offset+=raw.length+1;bytes=Math.max(bytes,bytesBefore+raw.length);
          if(result.items.length>=limits.items||bytes>=limits.bytes){result.complete=false;break;}
        }
      }
      cursor.anchor=hash(await read(Math.max(0,cursor.offset-256),Math.min(cursor.offset,256)));
      if(await realpath(path)!==path)throw Error('Source path changed');
      cursor.size=info.size;cursor.mtimeMs=info.mtimeMs;cursor.ctimeMs=info.ctimeMs;cursor.quickHash=entry.quickHash;checkpoint.files[key]=cursor;checkpoint.nextFile=rel;checkpoint.catalog[rel]={relativePath:rel,fileId:entry.fileId,size:info.size,mtimeMs:info.mtimeMs,ctimeMs:info.ctimeMs,quickHash:entry.quickHash,lastSeenScan:checkpoint.scanNumber,syncState:result.complete?'synced':'pending'};
    }catch(error){if(signal?.aborted)throw error;result.items.splice(itemStart);result.seen.splice(seenStart);result.complete=false;result.skipped++;}
    finally{await handle?.close();}
  }
  // new_only must not sweep all history again on the second page.
  if(result.complete)checkpoint.initialized=true;
  return result;
}

/** OpenCode persists sessions in SQLite. Read only the session/message tables,
 * never provider credentials, and keep the owner's live database untouched. */
async function scanOpenCodeDatabase(rootPath:string,options:SourceOptions,previous:CodingCheckpoint|undefined,signal:Pick<AbortSignal,'aborted'|'throwIfAborted'>|undefined,limits:{items:number;bytes:number}):Promise<SourceScan> {
  const selected=await lstat(rootPath);
  if(selected.isSymbolicLink())throw Error('OpenCode database path must not be a symbolic link');
  const root=selected.isFile()?dirname(await realpath(rootPath)):selected.isDirectory()?await realpath(rootPath):undefined;
  if(!root)throw Error('OpenCode database path must be a regular file or directory');
  const databasePath=selected.isFile()?join(root,basename(rootPath)):join(root,'opencode.db'),relativePath=relative(root,databasePath).split('\\').join('/');
  let info;try{info=await lstat(databasePath);}catch{throw Error('OpenCode session database not found');}
  if(!info.isFile()||info.isSymbolicLink())throw Error('OpenCode session database not found');
  if(await realpath(databasePath)!==databasePath)throw Error('Source path changed');
  const checkpoint:CodingCheckpoint=structuredClone(previous??{version:3,files:{},initialized:false,catalog:{},scanNumber:0,scanStartedAt:new Date().toISOString()});
  if(checkpoint.version!==3||!checkpoint.catalog||!Number.isSafeInteger(checkpoint.scanNumber)||!Number.isFinite(Date.parse(checkpoint.scanStartedAt)))throw Error('Unsupported Coding checkpoint format; reset the source state before scanning');
  if(checkpoint.opencode){
    if(!checkpoint.opencode.database||typeof checkpoint.opencode.database.fileId!=='string'||!checkpoint.opencode.sessions||typeof checkpoint.opencode.sessions!=='object')throw Error('Unsupported Coding checkpoint format; reset the source state before scanning');
    for(const [id,cursor] of Object.entries(checkpoint.opencode.sessions)){
      if(!id||!cursor||![cursor.lastSeq,cursor.lastUpdated].every(Number.isSafeInteger)||!Array.isArray(cursor.incomplete)||cursor.incomplete.some(value=>typeof value!=='string')||cursor.continuation&&(typeof cursor.continuation.id!=='string'||typeof cursor.continuation.hash!=='string'||!Number.isSafeInteger(cursor.continuation.nextItem)||cursor.continuation.nextItem<0))throw Error('Unsupported Coding cursor format; reset the source state before scanning');
    }
  }
  checkpoint.scanNumber++;checkpoint.scanStartedAt=new Date().toISOString();
  const result:SourceScan={items:[],seen:[],complete:true,skipped:0,checkpoint,queue:previous?.initialized?'realtime':options.initialSync==='new_only'?'realtime':'history'};
  if(options.excludedPaths.some(path=>relativePath===path||relativePath.startsWith(path+'/')))return result;
  const fileId=`${info.dev}:${info.ino}`,quickHash=hash(`${fileId}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`);
  const changed=!checkpoint.opencode||checkpoint.opencode.database.fileId!==fileId;
  if(changed){checkpoint.opencode={database:{fileId},sessions:{}};checkpoint.initialized=false;result.queue=options.initialSync==='new_only'?'realtime':'history';}
  const state=checkpoint.opencode!,baselined=checkpoint.initialized,itemQueue:'realtime'|'history'=baselined?'realtime':'history';
  let bytes=0,stopped=false;
  const database=new DatabaseSync(databasePath,{readOnly:true});
  try{
    database.prepare('PRAGMA busy_timeout=2000').get();
    const tables=new Set((database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('session_v2','session_message')").all() as Array<{name:string}>).map(row=>row.name));
    if(!tables.has('session_v2')||!tables.has('session_message'))throw Error('Unsupported OpenCode session database');
    const sessions=database.prepare('SELECT id,parent_id,directory,time_created,time_updated FROM session_v2 ORDER BY time_updated DESC,id').all() as Array<Record<string,unknown>>;
    for(const session of sessions){
      if(stopped)break;signal?.throwIfAborted();
      const sessionId=String(session.id??'');if(!sessionId||session.parent_id!=null)continue;
      const context:Context={sessionId,...(typeof session.directory==='string'&&session.directory?{cwd:session.directory}:{})};
      const prior=state.sessions[sessionId];
      if(!baselined&&!prior&&options.initialSync==='new_only'){
        const max=database.prepare('SELECT coalesce(max(seq),0) AS lastSeq,coalesce(max(time_updated),0) AS lastUpdated FROM session_message WHERE session_id=?').get(sessionId) as {lastSeq:number;lastUpdated:number};
        state.sessions[sessionId]={lastSeq:Number(max.lastSeq),lastUpdated:Number(max.lastUpdated),incomplete:[]};
        continue;
      }
      const cursor:CodingOpenCodeCursor=prior?structuredClone(prior):{lastSeq:0,lastUpdated:0,incomplete:[]};
      const pending=cursor.incomplete.slice(0,200),marks=pending.map(()=>'?').join(',');
      const rows=database.prepare(`SELECT id,type,seq,time_created,time_updated,data FROM session_message WHERE session_id=? AND type IN ('user','assistant','system','synthetic') AND (seq>? OR time_updated>?${marks?` OR id IN (${marks})`:''}) ORDER BY seq,time_created,id`)
        .all(sessionId,cursor.lastSeq,cursor.lastUpdated,...pending) as Array<Record<string,unknown>>;
      const present=new Set(rows.map(row=>String(row.id??'')));
      cursor.incomplete=cursor.incomplete.filter(id=>present.has(id));
      if(cursor.continuation&&!present.has(cursor.continuation.id))delete cursor.continuation;
      let advancedSeq=cursor.lastSeq,advancedUpdated=cursor.lastUpdated;
      for(const row of rows){
        if(stopped)break;signal?.throwIfAborted();
        if(result.items.length>=limits.items||bytes>=limits.bytes){result.complete=false;stopped=true;break;}
        const messageId=String(row.id??''),type=String(row.type??''),seq=Number(row.seq),updated=Number(row.time_updated);
        if(!Number.isSafeInteger(seq)||!Number.isFinite(updated)){result.complete=false;result.skipped++;stopped=true;break;}
        let data:any;
        try{data=JSON.parse(String(row.data));}catch{result.complete=false;result.skipped++;stopped=true;break;}
        if(type==='assistant'&&data?.time?.completed==null){
          if(!cursor.incomplete.includes(messageId))cursor.incomplete.push(messageId);
          advancedSeq=Math.max(advancedSeq,seq);advancedUpdated=Math.max(advancedUpdated,updated);result.complete=false;continue;
        }
        const rowHash=hash(`${messageId}\0${String(row.data)}`);
        let nextItem=0;
        if(cursor.continuation?.id===messageId){nextItem=cursor.continuation.hash===rowHash?cursor.continuation.nextItem:0;delete cursor.continuation;}
        let events:Event[];
        try{events=decodeCodingEvent('opencode',{id:messageId,type,seq,time_created:row.time_created,time_updated:row.time_updated,data},structuredClone(context));}
        catch{result.complete=false;result.skipped++;stopped=true;break;}
        const items=codingEventItems('opencode',context,events,rowHash,`${sessionId}:${messageId}`,itemQueue,options,signal);
        if(nextItem>items.length){result.complete=false;result.skipped++;stopped=true;break;}
        const bytesBefore=bytes;
        while(nextItem<items.length){
          signal?.throwIfAborted();if(result.items.length>=limits.items||bytes>bytesBefore&&bytes>=limits.bytes)break;
          const item=items[nextItem++]!;result.items.push(item);result.seen.push(item.externalId);bytes+=Buffer.byteLength(item.text,'utf8');
        }
        if(nextItem<items.length){cursor.continuation={id:messageId,hash:rowHash,nextItem};result.complete=false;stopped=true;break;}
        cursor.incomplete=cursor.incomplete.filter(id=>id!==messageId);
        advancedSeq=Math.max(advancedSeq,seq);advancedUpdated=Math.max(advancedUpdated,updated);
        if(result.items.length>=limits.items||bytes>=limits.bytes){result.complete=false;stopped=true;break;}
      }
      cursor.lastSeq=advancedSeq;cursor.lastUpdated=advancedUpdated;state.sessions[sessionId]=cursor;
      if(stopped)break;
    }
  }finally{database.close();}
  if(result.complete)checkpoint.initialized=true;
  checkpoint.catalog[relativePath]={relativePath,fileId,size:info.size,mtimeMs:info.mtimeMs,ctimeMs:info.ctimeMs,quickHash,lastSeenScan:checkpoint.scanNumber,syncState:result.complete?'synced':'pending'};
  return result;
}
