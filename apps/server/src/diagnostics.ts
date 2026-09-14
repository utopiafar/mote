import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, readdir, rename, stat, unlink,type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';

export type LogLevel = 'debug'|'info'|'warn'|'error'|'silent';
export type Stage = 'ingest'|'index'|'agent'|'source'|'maintenance';
export type Operation = 'capture'|'note'|'import'|'embedding'|'search'|'timeline'|'evidence'|'activity'|'devices'|'query'|'insight'|'retention';
const levels = ['debug','info','warn','error','silent'] as const;
const operations:Operation[] = ['capture','note','import','embedding','search','timeline','evidence','activity','devices','query','insight','retention'];
const events = new Set(['server.started','server.stopping','request.completed','request.failed','queue.snapshot','support.exported',...['ingest','index','agent','source','maintenance'].flatMap(s=>[`${s}.started`,`${s}.completed`,`${s}.failed`])]);
const routes = new Set(['health','status','captures','notes','image','devices','connections','updates','activity','query','insights','index','export','import','diagnostics','support','web','unknown']);
const categories = new Set(['validation','unauthorized','forbidden','not_found','conflict','deleted','too_large','rate_limited','model_not_configured','agent_response','embedding_http','embedding_invalid','embedding_transport','timeout','unavailable','storage_full','internal']);
const numberKeys = ['durationMs','statusCode','count','bytes','pending','failed','queueDepth','activeQueries','toolCalls','citations','httpStatus','deleted'] as const;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const bounded=(n:number|undefined,fallback:number,min:number,max:number)=>Math.min(max,Math.max(min,Math.floor(typeof n==='number'&&Number.isFinite(n)?n:fallback)));
const processStartedAt=Date.now()-process.uptime()*1000;
type Metrics = Partial<Record<typeof numberKeys[number],number>>;
export type EventFields = Metrics & { requestId?:string;operation?:Operation;route?:string;category?:string };
export interface DiagnosticEvent extends EventFields { seq:number;at:string;instanceId:string;event:string;level:Exclude<LogLevel,'silent'> }
export interface ServerDiagnosticsOptions { enabled?:boolean;debug?:boolean;level?:LogLevel;directory:string;maxBytes?:number;maxFiles?:number;maxEntries?:number }

/** Error text, stacks, headers, provider bodies and arbitrary codes never cross this boundary. */
export function safeError(error:unknown):{status:number;category:string;message:string} {
  try{return describeError(error);}catch{return {status:500,category:'internal',message:'请求未完成，请使用请求编号查看诊断记录。'};}
}
function describeError(error:unknown):{status:number;category:string;message:string} {
  const e=error&&typeof error==='object'?error as {name?:unknown;code?:unknown;statusCode?:unknown}:{};
  if(e.name==='ZodError')return {status:400,category:'validation',message:'输入格式无效，请检查必填项和取值范围。'};
  if(e.name==='AgentNotConfiguredError')return {status:503,category:'model_not_configured',message:'Agent 未配置，请在中央节点配置模型后重试。'};
  if(e.name==='AgentResponseError')return {status:502,category:'agent_response',message:'模型未返回可验证的回答，请重试或检查模型配置。'};
  if(e.name==='AbortError'||e.name==='TimeoutError')return {status:504,category:'timeout',message:'操作已取消或超时，请稍后重试。'};
  if(typeof e.code==='string'&&['embedding_http','embedding_invalid','embedding_transport'].includes(e.code))return {status:502,category:e.code,message:'索引模型请求未完成，请检查模型配置或稍后重试。'};
  const status=typeof e.statusCode==='number'&&Number.isInteger(e.statusCode)&&e.statusCode>=400&&e.statusCode<=599?e.statusCode:500;
  const fixed:Record<number,[string,string]>={400:['validation','输入格式无效，请检查必填项和取值范围。'],401:['unauthorized','请连接中央节点并输入有效访问令牌。'],403:['forbidden','此操作不可用。'],404:['not_found','未找到所请求的资料。'],409:['conflict','资料状态已变化或当前配置不支持此操作，请刷新后重试。'],410:['deleted','该条目已删除，排队重试不能恢复它。'],413:['too_large','内容超过大小限制，请分批处理。'],429:['rate_limited','请求过于频繁或已有任务运行，请稍后重试。'],503:['unavailable','服务暂不可用，请检查节点状态与模型配置。'],507:['storage_full','存储容量已满，请清理空间或调整容量限制。']};
  const [category,message]=fixed[status]??['internal','请求未完成，请使用请求编号查看诊断记录。'];
  return {status,category,message};
}
function fields(raw:unknown):EventFields {
  if(!raw||typeof raw!=='object')return {};
  const value=raw as Record<string,unknown>,out:EventFields={};
  for(const key of numberKeys){const n=value[key];if(typeof n==='number'&&Number.isFinite(n)&&n>=0&&n<=Number.MAX_SAFE_INTEGER)out[key]=Math.round(n*1000)/1000;}
  if(typeof value.requestId==='string'&&uuid.test(value.requestId))out.requestId=value.requestId;
  if(operations.includes(value.operation as Operation))out.operation=value.operation as Operation;
  if(typeof value.route==='string'&&routes.has(value.route))out.route=value.route;
  if(typeof value.category==='string'&&categories.has(value.category))out.category=value.category;
  return out;
}
function cleanEvent(value:unknown):DiagnosticEvent|undefined {
  if(!value||typeof value!=='object')return;
  const v=value as Record<string,unknown>;
  if(typeof v.event!=='string'||!events.has(v.event)||!levels.slice(0,4).includes(v.level as 'info')||typeof v.seq!=='number'||!Number.isSafeInteger(v.seq)||v.seq<1||typeof v.at!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v.at)||!Number.isFinite(Date.parse(v.at))||typeof v.instanceId!=='string'||!uuid.test(v.instanceId))return;
  return {seq:v.seq,at:v.at,instanceId:v.instanceId,event:v.event,level:v.level as DiagnosticEvent['level'],...fields(v)};
}

/** Bounded numeric events only, with no API for arbitrary strings or Error objects. */
export class ServerDiagnostics {
  readonly instanceId=randomUUID();
  private readonly context=new AsyncLocalStorage<string>();
  private readonly enabled:boolean;
  private readonly level:LogLevel;
  private readonly maxBytes:number;
  private readonly maxFiles:number;
  private readonly maxEntries:number;
  private entries:DiagnosticEvent[]=[];
  private queue:string[]=[];
  private seq=0;
  private currentBytes=0;
  private pending?:Promise<void>;
  private initialization?:Promise<void>;
  private closingPromise?:Promise<void>;
  private writingCount=0;
  private lock?:FileHandle;
  private writable=false;
  private closed=false;
  private dropped=0;
  private writeFailures=0;
  private readFailures=0;
  private nextAttempt=0;
  constructor(private readonly options:ServerDiagnosticsOptions) {
    this.enabled=options.enabled??true;this.level=options.level==='silent'?'silent':options.debug?'debug':levels.includes(options.level as LogLevel)?options.level!:'info';
    this.maxBytes=bounded(options.maxBytes,2*1024*1024,1024,8*1024*1024);
    this.maxFiles=bounded(options.maxFiles,3,1,10);
    this.maxEntries=bounded(options.maxEntries,2000,1,5000);
  }
  private path(index:number) {return join(this.options.directory,`central.${index}.ndjson`);}
  private async acquireLock() {
    const path=join(this.options.directory,'central.lock');
    for(let attempt=0;attempt<2;attempt++) {
      try{this.lock=await open(path,'wx',0o600);await this.lock.writeFile(JSON.stringify({pid:process.pid,startedAt:processStartedAt,instanceId:this.instanceId}));return;}
      catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
      const prior=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);let raw:string,identity;
      try{identity=await prior.stat();if(identity.size>256)throw new Error('Invalid diagnostic lock');raw=await prior.readFile('utf8');}finally{await prior.close();}
      const owner=JSON.parse(raw) as {pid?:unknown;startedAt?:unknown};
      if(typeof owner.pid!=='number'||!Number.isSafeInteger(owner.pid)||owner.pid<1||typeof owner.startedAt!=='number'||!Number.isFinite(owner.startedAt))throw new Error('Invalid diagnostic lock');
      let stale=owner.pid===process.pid&&owner.startedAt!==processStartedAt;
      if(!stale){try{process.kill(owner.pid,0);}catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')stale=true;}}
      if(!stale)throw new Error('Diagnostic directory already has a writer');
      const current=await stat(path);if(current.ino!==identity.ino||current.dev!==identity.dev)throw new Error('Diagnostic lock changed');
      await unlink(path);
    }
    throw new Error('Diagnostic directory lock unavailable');
  }
  init():Promise<void> {if(this.initialization)return this.initialization;if(this.closed)return Promise.resolve();this.initialization=this.load();return this.initialization;}
  private async load() {
    if(!this.enabled||this.level==='silent')return;
    try {
      await mkdir(this.options.directory,{recursive:true,mode:0o700});
      await this.acquireLock();this.writable=true;
      for(const entry of await readdir(this.options.directory,{withFileTypes:true})) {
        const match=/^central\.([0-9]+)\.ndjson$/.exec(entry.name);
        if(entry.isFile()&&match&&Number(match[1])>=this.maxFiles)await unlink(join(this.options.directory,entry.name));
      }
      for(let index=this.maxFiles-1;index>=0;index--) {
        try {
          const file=await open(this.path(index),constants.O_RDWR|constants.O_NOFOLLOW);
          let raw:string;
          try {
            await file.chmod(0o600);
            const size=(await file.stat()).size;
            if(size>this.maxBytes){this.readFailures++;await file.truncate(0);continue;}
            raw=await file.readFile('utf8');
            if(raw&&!raw.endsWith('\n')){raw=raw.slice(0,raw.lastIndexOf('\n')+1);await file.truncate(Buffer.byteLength(raw));this.readFailures++;}
          }
          finally {await file.close();}
          for(const line of raw.split('\n')) {
            if(!line||line.length>2048)continue;
            try {const event=cleanEvent(JSON.parse(line));if(event){this.entries.push(event);this.seq=Math.max(this.seq,event.seq);if(this.entries.length>this.maxEntries)this.entries.shift();}}catch{this.readFailures++;}
          }
        }catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')this.readFailures++;}
      }
      try{this.currentBytes=(await stat(this.path(0))).size;}catch{}
    }catch{this.writeFailures++;this.nextAttempt=Date.now()+30000;}
  }
  run<T>(requestId:string,task:()=>T):T {return this.context.run(uuid.test(requestId)?requestId:randomUUID(),task);}
  record(event:string,value:EventFields={},level:DiagnosticEvent['level']='info') {
    if(this.closed||!this.enabled||this.level==='silent'||!events.has(event)||!['debug','info','warn','error'].includes(level)||levels.indexOf(level)<levels.indexOf(this.level))return;
    const entry:DiagnosticEvent={seq:++this.seq,at:new Date().toISOString(),instanceId:this.instanceId,event,level,...fields({requestId:this.context.getStore(),...value})};
    const line=JSON.stringify(entry)+'\n';
    if(Buffer.byteLength(line)>Math.min(2048,this.maxBytes)){this.dropped++;return;}
    this.entries.push(entry);if(this.entries.length>this.maxEntries)this.entries.shift();
    if(!this.writable||this.queue.length>=Math.min(this.maxEntries,1024)||Date.now()<this.nextAttempt){this.dropped++;return;}
    this.queue.push(line);this.startWrite();
  }
  async measure<T>(stage:Stage,operation:Operation,task:()=>Promise<T>|T,metrics?:(result:T)=>Metrics):Promise<T> {
    const start=performance.now();this.record(`${stage}.started`,{operation},'debug');
    try {const result=await task();let extra:Metrics={};try{extra=metrics?.(result)??{};}catch{}this.record(`${stage}.completed`,{operation,durationMs:performance.now()-start,...extra});return result;}
    catch(error){this.record(`${stage}.failed`,{operation,durationMs:performance.now()-start,category:safeError(error).category},'error');throw error;}
  }
  private startWrite() {
    if(this.pending)return;
    this.pending=this.drain().finally(()=>{this.pending=undefined;if(this.queue.length&&!this.closed)this.startWrite();});
  }
  private async rotate() {
    for(let i=this.maxFiles-1;i>=0;i--){try{if(i===this.maxFiles-1)await unlink(this.path(i));else await rename(this.path(i),this.path(i+1));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}}
    this.currentBytes=0;
  }
  private async drain() {
    try {
      await mkdir(this.options.directory,{recursive:true,mode:0o700});
      while(this.queue.length) {
        const lines:string[]=[];let bytes=0;
        if(this.currentBytes+Buffer.byteLength(this.queue[0])>this.maxBytes)await this.rotate();
        while(this.queue.length&&lines.length<64&&this.currentBytes+bytes+Buffer.byteLength(this.queue[0])<=this.maxBytes){const line=this.queue.shift()!;lines.push(line);bytes+=Buffer.byteLength(line);}
        this.writingCount=lines.length;
        const file=await open(this.path(0),constants.O_CREAT|constants.O_APPEND|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
        try{await file.chmod(0o600);await file.writeFile(lines.join(''));}finally{await file.close();}
        this.currentBytes+=bytes;this.writingCount=0;
      }
    }catch{this.writeFailures++;this.dropped+=this.queue.length+this.writingCount;this.writingCount=0;this.queue=[];this.nextAttempt=Date.now()+30000;}
  }
  snapshot() {return {enabled:!this.closed&&this.enabled&&this.level!=='silent',level:this.level,instanceId:this.instanceId,retainedEvents:this.entries.length,lastSeq:this.seq,pendingWrites:this.queue.length+this.writingCount,droppedEvents:this.dropped,writeFailures:this.writeFailures,readFailures:this.readFailures,limits:{maxFileBytes:this.maxBytes,maxFiles:this.maxFiles,maxEvents:this.maxEntries},runtime:{uptimeMs:Math.round(process.uptime()*1000),rssBytes:process.memoryUsage().rss,cpuUserMicros:process.cpuUsage().user,cpuSystemMicros:process.cpuUsage().system}};}
  events(afterSeq=0,limit=500) {const items=this.entries.filter(e=>e.seq>afterSeq).slice(0,Math.min(500,Math.max(1,limit))).map(e=>structuredClone(e));return {items,nextSeq:items.at(-1)?.seq??afterSeq,oldestSeq:this.entries[0]?.seq??null};}
  recent(limit=500) {return this.entries.slice(-Math.min(500,Math.max(1,limit))).map(e=>structuredClone(e));}
  async flush() {while(this.pending)await this.pending;}
  close():Promise<void> {if(this.closingPromise)return this.closingPromise;this.closed=true;this.closingPromise=this.finishClose();return this.closingPromise;}
  private async finishClose() {
    await this.initialization;await this.flush();
    const lock=this.lock;this.lock=undefined;this.writable=false;
    if(lock){try{const identity=await lock.stat(),path=join(this.options.directory,'central.lock'),current=await stat(path);if(identity.ino===current.ino&&identity.dev===current.dev)await unlink(path);}catch{this.writeFailures++;}finally{await lock.close();}}
  }
}
