import {ProviderFailure} from '@mote/shared';
import {validationFeedback} from './memory-validation.js';
import { moteText } from './i18n.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, readdir, rename, stat, unlink,type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';

export type LogLevel = 'debug'|'info'|'warn'|'error'|'silent';
export type Stage = 'ingest'|'index'|'agent'|'source'|'maintenance'|'file';
export type DiagnosticStage = Stage|'request'|'system'|'unknown';
export const diagnosticStageFilters=['all','system','request','ingest','index','agent','source','maintenance','file','unknown'] as const;
export type DiagnosticStageFilter=typeof diagnosticStageFilters[number];
export type Operation = 'capture'|'note'|'import'|'embedding'|'search'|'timeline'|'evidence'|'activity'|'devices'|'query'|'insight'|'retention'|'extract'|'diarize'|'align'|'turns'|'summary'|'file_upload'|'file_part'|'file_commit'|'file_revision'|'file_process'|'file_settings'|'file_retry';
export interface AgentTraceContext {
  operationId?: string;
  traceId?: string; requestId?: string; jobId?: string; batchId?: string; batchIndex?: number; attempt?: number;
  phase?: string; operation?: string; moduleId?: string; profileId?: string; provider?: string; protocol?: string; model?: string;
}
export interface AgentTraceInput {
  type: string; at?: string; runId?: string; stage?: string; phase?: string; step?: number; tool?: string;
  durationMs?: number; status?: string; payload?: unknown;
}
const levels = ['debug','info','warn','error','silent'] as const;
const operations:Operation[] = ['capture','note','import','embedding','search','timeline','evidence','activity','devices','query','insight','retention','extract','diarize','align','turns','summary','file_upload','file_part','file_commit','file_revision','file_process','file_settings','file_retry'];
const events = new Set(['server.started','server.stopping','request.started','request.completed','request.failed','queue.snapshot','support.exported','agent.trace','agent.tool_rejected','agent.memory_validation_failed','agent.waiting','agent.heartbeat','file.blocked','file.retry','file.cached','file.cancelled','file.settings','file.step.started','file.step.completed','file.step.failed',...['ingest','index','agent','source','maintenance','file'].flatMap(s=>[`${s}.started`,`${s}.completed`,`${s}.failed`])]);
const routes = new Set(['files','file-sync','file-processing','conversations','configuration','sources','memories','layers','connectors','health','status','captures','notes','image','devices','connections','updates','activity','query','insights','index','export','import','diagnostics','support','web','unknown']);
const categories = new Set(['validation','unauthorized','forbidden','not_found','conflict','deleted','too_large','rate_limited','model_not_configured','agent_response','embedding_http','embedding_invalid','embedding_transport','timeout','unavailable','storage_full','internal','not_configured','archive_only','unsupported_format','daily_budget','local_only','summary_disabled','cancelled']);
const numberKeys = ['durationMs','statusCode','count','bytes','pending','failed','queueDepth','activeQueries','toolCalls','citations','httpStatus','deleted','attempt','retryAfterMs','part','batchIndex','candidateIndex','spanIndex','declaredOffset','declaredLength','quoteLength','sourceLength','authorizedMatches','idleMs','elapsedMs','remainingCalls','remainingCharacters','repeatCount'] as const;
const responseReasons:Record<string,string>={
  provider_quota:"模型服务额度不足，恢复账户额度后再继续。",
  provider_policy:"模型服务拒绝了本次请求，请调整内容或处理范围。",
  recovery_window_exhausted:"自动恢复时间已用完，可手动重试开启新的恢复周期。",
  model_token_budget:"模型 token 预算不足，等待预算重置或调整预算后继续。",
  model_cost_budget:"模型金额预算不足，等待预算重置或调整预算后继续。",
  budget_price_required:"金额预算需要当前币种的模型价格，请先设置价格。",
  budget_unbounded_runtime:"当前运行时无法强制限制每次请求的预算，请选择支持预算限制的运行时或调整预算。",
  model_budget_unavailable:"模型预算服务不可用，请稍后重试。",
  configuration_changed:"相关模型配置已改变，请重试以使用新配置；已完成批次会保留。",
  provider_authentication:"处理服务拒绝了凭据，请检查服务权限与密钥。",
  provider_endpoint:"处理服务地址不可用，请检查端点配置。",
  provider_redirect:"处理服务返回了重定向，请配置最终服务地址。",
  rate_limited:"处理服务正在限流，请等待允许重试的时间。",
  provider_unavailable:"处理服务暂时不可用，请稍后重试。",
  provider_timeout:"处理服务报告请求超时，请稍后重试。",
  provider_network:"无法连接处理服务，请检查网络与服务地址。",
  processing_limit:"处理服务拒绝了内容大小，请缩小本次处理范围。",
  unsupported_format:"处理服务不支持此内容格式。",
  provider_request_invalid:"处理服务拒绝了请求参数，请检查处理配置。",

  invalid_response:"模型未返回可验证的回答，请重试或检查模型配置。",
  tool_failure:"工具调用修复次数已耗尽，本次任务已停止。",
  host_validation:"模型输出未通过业务校验，当前对话内修复后仍不合规。",
  invalid_json:"模型返回的回答格式不完整或无效，请重试。",
  invalid_shape:"模型返回的回答或引用列表格式无效，请重试。",
  response_too_large:"模型回答超过大小限制，请缩小问题范围后重试。",
  unretrieved_citation:"模型引用了本次未检索到的资料，回答未保存，请重试。",
  truncated_citation:"模型未使用完整的资料引用编号，回答未保存，请重试。",
  undeclared_citation:"模型正文与引用列表不一致，回答未保存，请重试。",
  output_limit:"模型达到输出上限，回答未能完整生成。请缩小问题范围，或在模型服务设置中提高输出预算后重试。",
  tools_unverified:"只读检索工具未能完成初始化，请重试或检查节点运行环境。",
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const bounded=(n:number|undefined,fallback:number,min:number,max:number)=>Math.min(max,Math.max(min,Math.floor(typeof n==='number'&&Number.isFinite(n)?n:fallback)));
const logDay=(at:string)=>at.slice(0,10);
const maxEventBytes=20*1024;
const requiredEventFields=new Set(['seq','at','instanceId','event','level','stage']);
const serializedBytes=(value:unknown)=>Buffer.byteLength(JSON.stringify(value));
const truncateUtf8=(value:string,maxBytes:number)=>Buffer.byteLength(value)<=maxBytes?value:Buffer.from(value).subarray(0,Math.max(0,maxBytes)).toString('utf8');
const eventStage=(event:string):DiagnosticStage=>{
  const prefix=event.split('.',1)[0];
  if(prefix==='request')return 'request';
  if(prefix==='ingest'||prefix==='index'||prefix==='agent'||prefix==='source'||prefix==='maintenance'||prefix==='file')return prefix;
  if(prefix==='server'||prefix==='queue'||prefix==='support')return 'system';
  return 'unknown';
};
const validStage=(value:unknown):value is DiagnosticStage=>typeof value==='string'&&value!=='all'&&diagnosticStageFilters.includes(value as DiagnosticStageFilter);
const processStartedAt=Date.now()-process.uptime()*1000;
type Metrics = Partial<Record<typeof numberKeys[number],number>>;
type QueuedLine = {line:string;day:string};
export type EventFields = Metrics & { requestId?:string;jobId?:string;batchId?:string;runId?:string;evidenceId?:string;validationCode?:string;toolErrorCode?:string;validationPhase?:'extract'|'review';method?:'GET'|'POST'|'PUT'|'PATCH'|'DELETE'|'HEAD'|'OPTIONS';operation?:Operation;route?:string;category?:string;reason?:string };
export interface DiagnosticEvent extends EventFields { seq:number;at:string;instanceId:string;event:string;level:Exclude<LogLevel,'silent'>;stage?:DiagnosticStage;truncated?:boolean;trace?:Record<string,unknown> }
export interface ServerDiagnosticsOptions { enabled?:boolean;debug?:boolean;level?:LogLevel;directory:string;maxBytes?:number;maxFiles?:number;maxEntries?:number;now?:()=>Date;traceEnabled?:boolean }

export function serializeDiagnosticEvent(entry:DiagnosticEvent,maxBytes=maxEventBytes):string {
  const original=JSON.stringify(entry)+'\n';
  if(Buffer.byteLength(original)<=maxBytes)return original;
  const candidate:Record<string,unknown>={...entry,truncated:true};
  const stringFields=Object.keys(candidate).filter(key=>!requiredEventFields.has(key)&&typeof candidate[key]==='string').sort((a,b)=>Buffer.byteLength(String(candidate[b]))-Buffer.byteLength(String(candidate[a])));
  for(const key of stringFields) {
    const value=String(candidate[key]);let low=0,high=value.length,best='';
    while(low<=high) {const middle=Math.floor((low+high)/2),part=truncateUtf8(value,middle);candidate[key]=part;if(serializedBytes(candidate)+1<=maxBytes){best=part;low=middle+1;}else high=middle-1;}
    candidate[key]=best;
  }
  if(serializedBytes(candidate)+1>maxBytes)for(const key of Object.keys(candidate))if(!requiredEventFields.has(key)&&key!=='truncated')delete candidate[key];
  return JSON.stringify(candidate)+'\n';
}

/** Normal diagnostic events never carry error text, stacks, headers, provider bodies or arbitrary codes. */
export function safeError(error:unknown):{status:number;category:string;message:string;reason?:string} {
  try{return describeError(error);}catch{return {status:500,category:'internal',message:moteText("请求未完成，请使用请求编号查看诊断记录。")};}
}
function describeError(error:unknown):{status:number;category:string;message:string;reason?:string} {
  const e=error&&typeof error==='object'?error as {name?:unknown;code?:unknown;statusCode?:unknown;reason?:unknown}:{};
  if(e.name==='ZodError')return {status:400,category:'validation',message:moteText("输入格式无效，请检查必填项和取值范围。")};
  if(e.name==='AgentNotConfiguredError')return {status:503,category:'model_not_configured',message:moteText("Agent 未配置，请在中央节点配置模型后重试。")};
  if(e.name==='AgentTimeoutError')return {status:504,category:'timeout',message:moteText("Agent 请求已超时，请稍后重试或缩小查询范围。")};
  if(error instanceof ProviderFailure&&Object.hasOwn(responseReasons,error.details.code)){const reason=error.details.code;return {status:502,category:error.details.category==='blocked'?'model_not_configured':error.details.category==='permanent'?'validation':reason==='rate_limited'?'rate_limited':'unavailable',reason,message:moteText(responseReasons[reason])};}
  if(e.name==='AgentProviderError')return {status:502,category:'agent_response',message:moteText("模型服务请求未完成，请检查地址、凭据和模型配置。")};
  if(e.name==='AgentResponseError') {const reason=typeof e.reason==='string'&&Object.hasOwn(responseReasons,e.reason)?e.reason:'invalid_response';return {status:502,category:'agent_response',reason,message:moteText(responseReasons[reason])};}
  if(e.name==='AbortError'||e.name==='TimeoutError')return {status:504,category:'timeout',message:moteText("操作已取消或超时，请稍后重试。")};
  if(typeof e.code==='string'&&['embedding_http','embedding_invalid','embedding_transport'].includes(e.code))return {status:502,category:e.code,message:moteText("索引模型请求未完成，请检查模型配置或稍后重试。")};
  const status=typeof e.statusCode==='number'&&Number.isInteger(e.statusCode)&&e.statusCode>=400&&e.statusCode<=599?e.statusCode:500;
  const fixed:Record<number,[string,string]>={400:['validation',moteText("输入格式无效，请检查必填项和取值范围。")],401:['unauthorized',moteText("访问凭据无效或已失效，请重新验证身份。")],403:['forbidden',moteText("此操作不可用。")],404:['not_found',moteText("未找到所请求的资料。")],409:['conflict',moteText("资料状态已变化或当前配置不支持此操作，请刷新后重试。")],410:['deleted',moteText("该条目已删除，排队重试不能恢复它。")],413:['too_large',moteText("内容超过大小限制，请分批处理。")],429:['rate_limited',moteText("请求过于频繁或已有任务运行，请稍后重试。")],503:['unavailable',moteText("服务暂不可用，请检查节点状态与模型配置。")],507:['storage_full',moteText("存储容量已满，请清理空间或调整容量限制。")]};
  const [category,message]=fixed[status]??['internal',moteText("请求未完成，请使用请求编号查看诊断记录。")];
  return {status,category,message};
}
function fields(raw:unknown):EventFields {
  if(!raw||typeof raw!=='object')return {};
  const value=raw as Record<string,unknown>,out:EventFields={};
  for(const key of numberKeys){const n=value[key];if(typeof n==='number'&&Number.isFinite(n)&&n>=0&&n<=Number.MAX_SAFE_INTEGER)out[key]=Math.round(n*1000)/1000;}
  if(typeof value.requestId==='string'&&uuid.test(value.requestId))out.requestId=value.requestId;
  if(typeof value.jobId==='string'&&uuid.test(value.jobId))out.jobId=value.jobId;
  for(const key of ['batchId','runId','evidenceId'] as const)if(typeof value[key]==='string'&&uuid.test(value[key]))out[key]=value[key];
  if(typeof value.validationCode==='string'&&Object.hasOwn(validationFeedback,value.validationCode))out.validationCode=value.validationCode;
  if(typeof value.toolErrorCode==='string'&&['evidence_changed','invalid_tool_arguments','evidence_budget_exceeded','tool_budget_exceeded','evidence_scope_denied','invalid_evidence_range','evidence_range_exceeded','invalid_changes_view','context_tool_failed','repeated_tool_failure'].includes(value.toolErrorCode))out.toolErrorCode=value.toolErrorCode;
  if(value.validationPhase==='extract'||value.validationPhase==='review')out.validationPhase=value.validationPhase;
  if(typeof value.method==='string'&&['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS'].includes(value.method))out.method=value.method as EventFields['method'];
  if(operations.includes(value.operation as Operation))out.operation=value.operation as Operation;
  if(typeof value.route==='string'&&routes.has(value.route))out.route=value.route;
  if(typeof value.category==='string'&&categories.has(value.category))out.category=value.category;
  if(typeof value.reason==='string'&&Object.hasOwn(responseReasons,value.reason))out.reason=value.reason;
  return out;
}
function cleanEvent(value:unknown):DiagnosticEvent|undefined {
  if(!value||typeof value!=='object')return;
  const v=value as Record<string,unknown>;
  if(typeof v.event!=='string'||!events.has(v.event)||!levels.slice(0,4).includes(v.level as 'info')||typeof v.seq!=='number'||!Number.isSafeInteger(v.seq)||v.seq<1||typeof v.at!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v.at)||!Number.isFinite(Date.parse(v.at))||typeof v.instanceId!=='string'||!uuid.test(v.instanceId))return;
  const trace=v.event==='agent.trace'&&v.trace&&typeof v.trace==='object'&&!Array.isArray(v.trace)?v.trace as Record<string,unknown>:undefined;
  if(v.event==='agent.trace'&&typeof trace?.type!=='string')return;
  return {seq:v.seq,at:v.at,instanceId:v.instanceId,event:v.event,level:v.level as DiagnosticEvent['level'],stage:validStage(v.stage)?v.stage:eventStage(v.event),...fields(v),...(v.truncated===true?{truncated:true}: {}),...(trace?{trace}: {})};
}

const traceStringLimit=1_000_000,traceArrayLimit=500,traceObjectLimit=250,traceDepthLimit=8;
function compactTraceValue(value:unknown,depth=0):{value:unknown;truncated:boolean} {
  if(value===undefined)return {value:undefined,truncated:false};
  if(typeof value==='string')return value.length>traceStringLimit?{value:value.slice(0,traceStringLimit),truncated:true}:{value,truncated:false};
  if(value===null||typeof value==='number'||typeof value==='boolean')return {value,truncated:false};
  if(depth>=traceDepthLimit)return {value:'[trace depth limit]',truncated:true};
  if(Array.isArray(value)){
    let truncated=value.length>traceArrayLimit;const output=[];
    for(const item of value.slice(0,traceArrayLimit)){const result=compactTraceValue(item,depth+1);output.push(result.value);truncated ||= result.truncated;}
    return {value:output,truncated};
  }
  if(typeof value==='object'){
    const output:Record<string,unknown>={};let truncated=false;
    for(const [key,item] of Object.entries(value as Record<string,unknown>).slice(0,traceObjectLimit)){const result=compactTraceValue(item,depth+1);output[key]=result.value;truncated ||= result.truncated;}
    if(Object.keys(value as object).length>traceObjectLimit)truncated=true;
    return {value:output,truncated};
  }
  return {value:String(value),truncated:true};
}

/** Normal events are bounded numeric events; detailed Agent payloads use the explicit trace opt-in. */
export class ServerDiagnostics {
  readonly instanceId=randomUUID();
  private readonly context=new AsyncLocalStorage<string>();
  private enabled:boolean;
  private level:LogLevel;
  private readonly maxBytes:number;
  private readonly maxFiles:number;
  private readonly maxEntries:number;
  private readonly now:()=>Date;
  private traceEnabled:boolean;
  private entries:DiagnosticEvent[]=[];
  private queue:QueuedLine[]=[];
  private seq=0;
  private currentBytes=0;
  private currentDay?:string;
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
  private traceEvents=0;
  constructor(private readonly options:ServerDiagnosticsOptions) {
    this.enabled=options.enabled??true;this.level=options.level==='silent'?'silent':options.debug?'debug':levels.includes(options.level as LogLevel)?options.level!:'info';
    this.maxBytes=bounded(options.maxBytes,2*1024*1024,1024,8*1024*1024);
    this.maxFiles=bounded(options.maxFiles,3,1,10);
    this.maxEntries=bounded(options.maxEntries,2000,1,5000);
    this.now=options.now??(()=>new Date());
    this.traceEnabled=Boolean(options.traceEnabled)&&this.enabled&&this.level!=='silent';
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
      let currentDay:string|undefined;
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
            if(!line)continue;
            let parsed:unknown;try{parsed=JSON.parse(line);}catch{this.readFailures++;continue;}
            try {const event=cleanEvent(parsed);if(event){this.entries.push(event);if(event.event==='agent.trace')this.traceEvents++;this.seq=Math.max(this.seq,event.seq);if(index===0)currentDay=logDay(event.at);if(this.entries.length>this.maxEntries){const removed=this.entries.shift();if(removed?.event==='agent.trace')this.traceEvents--;}}}catch{this.readFailures++;}
          }
        }catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')this.readFailures++;}
      }
      try{this.currentBytes=(await stat(this.path(0))).size;}catch{}
      this.currentDay=currentDay;
    }catch{this.writeFailures++;this.nextAttempt=Date.now()+30000;}
  }
  private configurationQueue:Promise<unknown>=Promise.resolve();
  configure(value:{enabled:boolean;debug:boolean;traceEnabled:boolean;level:LogLevel}){const task=this.configurationQueue.then(()=>this.applyConfiguration(value));this.configurationQueue=task.catch(()=>{});return task;}
  private async applyConfiguration(value:{enabled:boolean;debug:boolean;traceEnabled:boolean;level:LogLevel}){
    await this.init();await this.flush();
    this.enabled=value.enabled;this.level=value.level==='silent'?'silent':value.debug?'debug':value.level;this.traceEnabled=value.traceEnabled&&value.enabled&&this.level!=='silent';
    if(this.enabled&&this.level!=='silent'&&!this.lock){this.entries=[];this.traceEvents=0;await this.load();}
    return this.snapshot();
  }
  run<T>(requestId:string,task:()=>T):T {return this.context.run(uuid.test(requestId)?requestId:randomUUID(),task);}
  requestId():string|undefined {return this.context.getStore();}
  record(event:string,value:EventFields={},level:DiagnosticEvent['level']='info') {
    if(event==='agent.trace'||this.closed||!this.enabled||this.level==='silent'||!events.has(event)||!['debug','info','warn','error'].includes(level)||levels.indexOf(level)<levels.indexOf(this.level))return;
    const at=this.now().toISOString();
    const entry:DiagnosticEvent={seq:++this.seq,at,instanceId:this.instanceId,event,level,stage:eventStage(event),...fields({requestId:this.context.getStore(),...value})};
    const line=serializeDiagnosticEvent(entry,Math.min(maxEventBytes,this.maxBytes));
    this.entries.push(entry);if(this.entries.length>this.maxEntries)this.entries.shift();
    if(!this.writable||this.queue.length>=Math.min(this.maxEntries,1024)||Date.now()<this.nextAttempt){this.dropped++;return;}
    this.queue.push({line,day:logDay(at)});this.startWrite();
  }
  /** Opt-in detailed Agent events share the ordinary central log for one-place troubleshooting. */
  agentTrace(event:AgentTraceInput,context:AgentTraceContext={}) {
    if(this.closed||!this.traceEnabled||!event||typeof event.type!=='string'||!event.type.trim())return;
    const payload=compactTraceValue(event.payload);
    const traceId=typeof context.traceId==='string'&&uuid.test(context.traceId)?context.traceId:randomUUID();
    const trace:Record<string,unknown>={
      type:event.type.slice(0,120),traceId,...(context.operationId&&/^[a-z]+:[a-zA-Z0-9:-]{1,200}$/.test(context.operationId)?{operationId:context.operationId}:{}),
      ...(typeof event.runId==='string'?{runId:event.runId.slice(0,200)}:{}),
      ...(typeof event.stage==='string'?{stage:event.stage.slice(0,80)}:{}),
      ...(typeof event.phase==='string'?{phase:event.phase.slice(0,80)}:{}),
      ...(typeof event.step==='number'&&Number.isSafeInteger(event.step)&&event.step>=0?{step:event.step}:{}),
      ...(typeof event.tool==='string'?{tool:event.tool.slice(0,120)}:{}),
      ...(typeof event.durationMs==='number'&&Number.isFinite(event.durationMs)&&event.durationMs>=0?{durationMs:Math.round(event.durationMs*1000)/1000}:{}),
      ...(typeof event.status==='string'?{status:event.status.slice(0,80)}:{}),
      ...(typeof event.at==='string'&&Number.isFinite(Date.parse(event.at))?{eventAt:event.at}:{}),
      ...(typeof context.batchId==='string'&&uuid.test(context.batchId)?{batchId:context.batchId}:{}),
      ...(typeof context.batchIndex==='number'&&Number.isSafeInteger(context.batchIndex)&&context.batchIndex>=0?{batchIndex:context.batchIndex}:{}),
      ...(typeof context.attempt==='number'&&Number.isSafeInteger(context.attempt)&&context.attempt>=0?{attempt:context.attempt}:{}),
      ...(typeof context.phase==='string'?{tracePhase:context.phase.slice(0,80)}:{}),
      ...(typeof context.operation==='string'?{operation:context.operation.slice(0,80)}:{}),
      ...(typeof context.moduleId==='string'?{moduleId:context.moduleId.slice(0,120)}:{}),
      ...(typeof context.profileId==='string'?{profileId:context.profileId.slice(0,120)}:{}),
      ...(typeof context.provider==='string'?{provider:context.provider.slice(0,120)}:{}),
      ...(typeof context.protocol==='string'?{protocol:context.protocol.slice(0,120)}:{}),
      ...(typeof context.model==='string'?{model:context.model.slice(0,300)}:{}),
      ...(payload.value!==undefined?{payload:payload.value}:{}),...(payload.truncated?{truncated:true}:{}),
    };
    const at=this.now().toISOString();
    const entry:DiagnosticEvent={seq:++this.seq,at,instanceId:this.instanceId,event:'agent.trace',level:'debug',stage:'agent',...fields({requestId:context.requestId??this.context.getStore(),jobId:context.jobId}),trace};
    let line=JSON.stringify(entry)+'\n';
    if(Buffer.byteLength(line)>this.maxBytes){entry.trace={type:trace.type,traceId,runId:trace.runId,truncated:true,payload:'trace payload exceeded the configured log file limit'};line=JSON.stringify(entry)+'\n';}
    if(Buffer.byteLength(line)>this.maxBytes){this.dropped++;return;}
    this.traceEvents++;this.entries.push(entry);if(this.entries.length>this.maxEntries){const removed=this.entries.shift();if(removed?.event==='agent.trace')this.traceEvents--;}
    if(!this.writable||this.queue.length>=Math.min(this.maxEntries,1024)||Date.now()<this.nextAttempt){this.dropped++;return;}
    this.queue.push({line,day:logDay(at)});this.startWrite();
  }
  async measure<T>(stage:Stage,operation:Operation,task:()=>Promise<T>|T,metrics?:(result:T)=>Metrics):Promise<T> {
    const start=performance.now();this.record(`${stage}.started`,{operation},'debug');
    try {const result=await task();let extra:Metrics={};try{extra=metrics?.(result)??{};}catch{}this.record(`${stage}.completed`,{operation,durationMs:performance.now()-start,...extra});return result;}
    catch(error){const failure=safeError(error);this.record(`${stage}.failed`,{operation,durationMs:performance.now()-start,category:failure.category,reason:failure.reason},failure.status>=500?'error':'warn');throw error;}
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
        const first=this.queue[0];
        if(!this.currentDay||this.currentBytes===0)this.currentDay=first.day;
        if(this.currentBytes>0&&first.day!==this.currentDay){await this.rotate();this.currentDay=first.day;}
        if(this.currentBytes+Buffer.byteLength(first.line)>this.maxBytes){await this.rotate();this.currentDay=first.day;}
        const lines:QueuedLine[]=[];let bytes=0;
        while(this.queue.length&&lines.length<64){
          const next=this.queue[0],size=Buffer.byteLength(next.line);
          if(next.day!==this.currentDay||this.currentBytes+bytes+size>this.maxBytes)break;
          lines.push(this.queue.shift()!);bytes+=size;
        }
        if(!lines.length){this.dropped++;this.queue.shift();continue;}
        this.writingCount=lines.length;
        const file=await open(this.path(0),constants.O_CREAT|constants.O_APPEND|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
        try{await file.chmod(0o600);await file.writeFile(lines.map(item=>item.line).join(''));}finally{await file.close();}
        this.currentBytes+=bytes;this.writingCount=0;
      }
    }catch{this.writeFailures++;this.dropped+=this.queue.length+this.writingCount;this.writingCount=0;this.queue=[];this.nextAttempt=Date.now()+30000;}
  }
  snapshot() {return {enabled:!this.closed&&this.enabled&&this.level!=='silent',level:this.level,instanceId:this.instanceId,retainedEvents:this.entries.length,lastSeq:this.seq,pendingWrites:this.queue.length+this.writingCount,droppedEvents:this.dropped,writeFailures:this.writeFailures,readFailures:this.readFailures,agentTrace:{enabled:!this.closed&&this.traceEnabled,retainedEvents:this.traceEvents},limits:{maxFileBytes:this.maxBytes,maxFiles:this.maxFiles,maxEvents:this.maxEntries},runtime:{uptimeMs:Math.round(process.uptime()*1000),rssBytes:process.memoryUsage().rss,cpuUserMicros:process.cpuUsage().user,cpuSystemMicros:process.cpuUsage().system}};}
  events(afterSeq=0,limit=500) {const items=this.entries.filter(e=>e.seq>afterSeq).slice(0,Math.min(500,Math.max(1,limit))).map(e=>structuredClone(e));return {items,nextSeq:items.at(-1)?.seq??afterSeq,oldestSeq:this.entries[0]?.seq??null};}
  recent(limit=500) {return this.entries.slice(-Math.min(500,Math.max(1,limit))).map(e=>structuredClone(e));}
  /** Return the current file verbatim, including incomplete/malformed text for troubleshooting. */
  async readRaw(index=0):Promise<string> {
    if(!Number.isInteger(index)||index<0||index>=this.maxFiles)throw Object.assign(new Error('Invalid log file'),{statusCode:400});
    await this.flush();
    try {
      const file=await open(this.path(index),constants.O_RDONLY|constants.O_NOFOLLOW);
      try {
        if((await file.stat()).size>this.maxBytes)throw new Error('Log exceeds read limit');
        const buffer=Buffer.alloc(this.maxBytes);
        const {bytesRead}=await file.read(buffer,0,buffer.length,0);
        return buffer.subarray(0,bytesRead).toString('utf8');
      } finally {await file.close();}
    } catch(error) {
      if((error as NodeJS.ErrnoException).code==='ENOENT')return '';
      this.readFailures++;throw error;
    }
  }
  async readPage(index=0,page=1,pageSize=100,stage:DiagnosticStageFilter='all') {
    if(!Number.isInteger(index)||index<0||index>=this.maxFiles)throw Object.assign(new Error('Invalid log file'),{statusCode:400});
    if(!Number.isInteger(page)||page<1)throw Object.assign(new Error('Invalid log page'),{statusCode:400});
    if(!Number.isInteger(pageSize)||pageSize<1||pageSize>500)throw Object.assign(new Error('Invalid log page size'),{statusCode:400});
    if(!diagnosticStageFilters.includes(stage))throw Object.assign(new Error('Invalid log stage'),{statusCode:400});
    const lines=(await this.readRaw(index)).split('\n').filter(line=>line.length>0).filter(line=>stage==='all'||this.lineStage(line)===stage);
    const totalLines=lines.length,totalPages=Math.max(1,Math.ceil(totalLines/pageSize)),currentPage=Math.min(page,totalPages);
    const end=totalLines-(currentPage-1)*pageSize,start=Math.max(0,end-pageSize);
    return {items:lines.slice(start,end),page:currentPage,pageSize,totalLines,totalPages,hasPrevious:currentPage<totalPages,hasNext:currentPage>1};
  }
  private lineStage(line:string):DiagnosticStage {
    try {const value=JSON.parse(line) as Record<string,unknown>;return validStage(value.stage)?value.stage:typeof value.event==='string'?eventStage(value.event):'unknown';}catch{return 'unknown';}
  }
  async exportRange(after:string,before:string) {
    await this.flush();
    const records:DiagnosticEvent[]=[];const seen=new Set<string>();let invalidLines=0;
    for(let index=this.maxFiles-1;index>=0;index--)for(const line of (await this.readRaw(index)).split('\n')) {
      if(!line.trim())continue;
      let record:DiagnosticEvent|undefined;try {record=cleanEvent(JSON.parse(line));}catch {}
      if(!record){invalidLines++;continue;}
      const key=record.instanceId+':'+record.seq;if(seen.has(key))continue;seen.add(key);records.push(record);
    }
    records.sort((a,b)=>a.at.localeCompare(b.at)||a.seq-b.seq);
    return {after,before,oldestRetainedAt:records[0]?.at??null,retentionLimited:!records.length||records[0].at>after,invalidLines,events:records.filter(e=>e.event!=='agent.trace'&&e.at>=after&&e.at<before)};
  }
  async flush() {while(this.pending)await this.pending;}
  close():Promise<void> {if(this.closingPromise)return this.closingPromise;this.closed=true;this.closingPromise=this.finishClose();return this.closingPromise;}
  private async finishClose() {
    await this.initialization;await this.flush();
    const lock=this.lock;this.lock=undefined;this.writable=false;
    if(lock){try{const identity=await lock.stat(),path=join(this.options.directory,'central.lock'),current=await stat(path);if(identity.ino===current.ino&&identity.dev===current.dev)await unlink(path);}catch{this.writeFailures++;}finally{await lock.close();}}
  }
}
