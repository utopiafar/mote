import {EXECUTION_POLICIES} from './execution-policy.js';
import {ExecutionEngine,ExecutionFailure} from './execution-engine.js';
import {AgentTimeoutError} from '@mote/agent';
import {ProviderFailure} from '@mote/shared';
import {MemoryProviderError} from './memory-provider-contract.js';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {Store,StoreError,sha256} from './store.js';
import type {ConfigService} from './config-service.js';
import {lifecycleSettingsSchema,defaultLifecycleSettings,type LifecycleSettings} from './memory-configuration.js';
export {lifecycleSettingsSchema,defaultLifecycleSettings,type LifecycleSettings} from './memory-configuration.js';

/** Derived runtime projection for code that receives originals before the lifecycle runtime exists.
 * The YAML service owns settings; this table is never a saved configuration source. */
export function projectMemoryLifecycleSettings(store:Store,settings:LifecycleSettings):void {
  const value=lifecycleSettingsSchema.parse(settings);
  store.db.exec('CREATE TABLE IF NOT EXISTS memory_lifecycle_effective(id INTEGER PRIMARY KEY CHECK(id=1),json TEXT NOT NULL)');
  store.db.prepare('INSERT INTO memory_lifecycle_effective VALUES(1,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(JSON.stringify(value));
}
export function storedMemoryLifecycleSettings(store:Store):LifecycleSettings {
  if(!store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_lifecycle_effective'").get())return structuredClone(defaultLifecycleSettings);
  const row=store.db.prepare('SELECT json FROM memory_lifecycle_effective WHERE id=1').get() as {json:string}|undefined;
  return row?lifecycleSettingsSchema.parse(JSON.parse(row.json)):structuredClone(defaultLifecycleSettings);
}
/** Host-only semantic time. Execution, authorization and retention keep their real clocks. */
export function freezeSemanticContextTime(clock:()=>string=()=>new Date().toISOString()):string {
  return z.string().max(64).datetime({offset:true}).refine(value=>Number.isFinite(Date.parse(value)),'Invalid semantic context time').parse(clock());
}
export type LifecycleWindow={manual?:boolean;id:string;version:string;from:number;through:number;ids:string[];startedAt:number;contextTime:string;settings:LifecycleSettings;checkpoint?:string};
type State={cancelled?:boolean;cancellationCause?:'owner'|'authority';manualRetryRequired?:boolean;stream?:LifecycleExtension['stream'];drainThrough?:number;cursor:number;lastSuccess:number;retryAt?:number;failures:number;countedFailure?:string;active?:LifecycleWindow;lastRun?:{id:string;through:number;completedAt:number};error?:string};
export type LifecycleExecution={operationId:string;jobId:string;signal:AbortSignal;interrupted:()=>boolean;commit:<T>(write:()=>T)=>T;recovery?:'transient'};
export type LifecycleExtension={id:keyof Pick<LifecycleSettings,'extraction'|'consolidation'|'insights'|'working'>;version:string;stream:'evidence'|'artifact'|'memory'|'conversation';maxAttempts?:number;
  cancel?:(window:LifecycleWindow,cause:'owner'|'authority')=>void;
  run:(window:LifecycleWindow,checkpoint:(id:string)=>void,execution?:LifecycleExecution)=>Promise<void>};

/** The host owns persistence/admission; replaceable extensions own model procedures.
 * Each window is a contiguous journal prefix. Arrivals during a run stay pending.
 * No timers, semantic dispatch, or write tools are installed in query sessions. */
export class MemoryLifecycle {
  automaticAdmission?:(id:LifecycleExtension['id'])=>boolean;
  private extensions=new Map<string,LifecycleExtension>();
  private running=new Map<string,Promise<void>>();
  private closed=false;private quiescing=false;private abort=new AbortController();
  private interrupting?:Promise<void>;private closing?:Promise<void>;
  private policy:LifecycleSettings;
  constructor(private store:Store,private configured:()=>boolean,private now:()=>number=Date.now,private executor?:ExecutionEngine,private semanticContextTime?:()=>string,private configService?:ConfigService){
    this.policy=lifecycleSettingsSchema.parse(configService?.current('memory')??defaultLifecycleSettings);
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_lifecycle_state(id TEXT PRIMARY KEY,json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memory_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,stream TEXT NOT NULL,entity TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS memory_events_stream ON memory_events(stream,seq);
      CREATE TRIGGER IF NOT EXISTS memory_event_insert AFTER INSERT ON memories WHEN json_extract(new.json,'$.tier')='episode' BEGIN INSERT INTO memory_events(stream,entity) VALUES('memory',new.id); END;
      CREATE TRIGGER IF NOT EXISTS memory_event_update AFTER UPDATE ON memories WHEN new.json!=old.json AND json_extract(new.json,'$.tier')='episode' BEGIN INSERT INTO memory_events(stream,entity) VALUES('memory',new.id); END;
      CREATE TRIGGER IF NOT EXISTS conversation_event_insert AFTER INSERT ON conversations BEGIN INSERT INTO memory_events(stream,entity) VALUES('conversation',new.id); END;
      CREATE TRIGGER IF NOT EXISTS conversation_event_update AFTER UPDATE ON conversations WHEN new.json!=old.json BEGIN INSERT INTO memory_events(stream,entity) VALUES('conversation',new.id); END;
    `);
    projectMemoryLifecycleSettings(store,this.policy);
    configService?.setHandler<LifecycleSettings>('memory',next=>{
      const previous=this.settings(),candidate=lifecycleSettingsSchema.parse(next);
      return {apply:()=>{},publish:()=>this.applySettings(candidate),rollback:()=>this.applySettings(previous)};
    });
  }
  register(extension:LifecycleExtension){
    if(this.extensions.has(extension.id))throw new Error('Duplicate lifecycle extension: '+extension.id);
    const exists=this.store.db.prepare('SELECT id FROM memory_lifecycle_state WHERE id=?').get(extension.id);
    if(exists&&this.state(extension.id).stream!==extension.stream)throw new StoreError('Unsupported lifecycle stream structure',409);
    this.extensions.set(extension.id,extension);
    if(!exists)this.saveState(extension.id,{stream:extension.stream,cursor:0,lastSuccess:this.now(),failures:0});
    const state=this.state(extension.id);
    // Cancellation can outlive its running listener. Replay the exact durable
    // checkpoint; automatic authority withdrawal preserves independent replies.
    if(state.cancelled&&state.active)extension.cancel?.(structuredClone(state.active),state.cancellationCause??(state.active.manual?'owner':'authority'));
  }
  replace(extension:LifecycleExtension){
    if(!this.extensions.has(extension.id))return this.register(extension);
    if(this.running.has(extension.id)||this.state(extension.id).active)throw new StoreError('Finish the active window before replacing an extension',409);
    this.extensions.set(extension.id,extension);
  }
  settings():LifecycleSettings{return structuredClone(this.policy);}
  request(id:LifecycleExtension['id'],ids:string[],checkpoint:string){
    if(this.closed||this.quiescing)throw new StoreError('Memory lifecycle is not accepting new work',503);
    const extension=this.extensions.get(id);if(!extension)throw new StoreError('Lifecycle extension is unavailable',409);
    const db=this.store.db,own=!db.isTransaction;if(own)db.exec('BEGIN IMMEDIATE');
    try{
    const settings=this.settings(),state=this.state(id);
    if(this.running.has(id)||state.active&&!state.cancelled&&this.executor?.get('lifecycle:'+state.active.id)?.state!=='cancelled')throw new StoreError('Finish or cancel the active lifecycle task first',409);
    if(!ids.length||ids.length>settings[id].maxItems||new Set(ids).size!==ids.length||checkpoint.length>32000)throw new StoreError('Choose a smaller unique set of inputs',413);
    state.active={manual:true,id:randomUUID(),version:extension.version,from:state.cursor,through:state.cursor,ids,startedAt:this.now(),contextTime:freezeSemanticContextTime(this.semanticContextTime),settings,checkpoint};
    delete state.cancelled;delete state.cancellationCause;delete state.manualRetryRequired;delete state.retryAt;delete state.error;state.failures=0;delete state.countedFailure;this.saveState(id,state);if(own)db.exec('COMMIT');return state.active.id;
    }catch(error){if(own&&db.isTransaction)db.exec('ROLLBACK');throw error;}
  }
  cancel(id:LifecycleExtension['id'],windowId:string,options?:{cause:'authority'}){
    const db=this.store.db,own=!db.isTransaction;if(own)db.exec('BEGIN IMMEDIATE');
    let afterCommit=()=>{};
    try{
      const write=()=>{
        const state=this.state(id);if(state.active?.id!==windowId)throw new StoreError('Active lifecycle task not found',404);
        const cause=options?.cause??'owner';state.cancelled=true;state.cancellationCause=cause;delete state.retryAt;this.saveState(id,state);
        this.extensions.get(id)?.cancel?.(structuredClone(state.active),cause);
        this.executor?.cancel('lifecycle:'+windowId);
      };
      if(this.executor)afterCommit=this.executor.deferLocalEffects(write);else write();
      if(own)db.exec('COMMIT');
    }catch(error){if(own&&db.isTransaction)db.exec('ROLLBACK');throw error;}
    afterCommit();return this.view();
  }
  retry(id:LifecycleExtension['id'],windowId:string,prepare?:(window:LifecycleWindow)=>void){
    const db=this.store.db,own=!db.isTransaction;if(own)db.exec('BEGIN IMMEDIATE');
    try{
      const state=this.state(id);if(state.active?.id!==windowId)throw new StoreError('Active lifecycle task not found',404);
      if(this.running.has(id)||this.executor?.get('lifecycle:'+windowId)?.state==='running')throw new StoreError('Wait for the current task to stop before retrying',409);
      prepare?.(structuredClone(state.active));
      if(this.executor?.get('lifecycle:'+windowId))this.executor.retry('lifecycle:'+windowId,true);
      delete state.cancelled;delete state.cancellationCause;delete state.manualRetryRequired;delete state.retryAt;delete state.error;state.failures=0;delete state.countedFailure;this.saveState(id,state);
      if(own)db.exec('COMMIT');return this.view();
    }catch(error){if(own&&db.isTransaction)db.exec('ROLLBACK');throw error;}
  }
  /** Owner strategy changes retire earlier pending work, never its products. */
  retirePending(id:LifecycleExtension['id'],through:number){
    if(!this.extensions.has(id))return;
    const state=this.state(id);if(state.cursor>=through||state.active&&state.active.through>through)return;
    if(state.active?.manual)return;
    if(state.active)this.executor?.cancel('lifecycle:'+state.active.id);
    state.cursor=through;delete state.active;delete state.cancelled;delete state.cancellationCause;delete state.manualRetryRequired;delete state.retryAt;delete state.error;delete state.drainThrough;state.failures=0;delete state.countedFailure;this.saveState(id,state);
  }
  private applySettings(settings:LifecycleSettings){this.policy=lifecycleSettingsSchema.parse(settings);projectMemoryLifecycleSettings(this.store,this.policy);}
  /** Standalone tests can configure their in-memory runtime; the app always uses a revisioned transaction. */
  configure(input:unknown){if(this.configService)throw new StoreError('Use the configuration transaction to save memory settings',409);this.applySettings(lifecycleSettingsSchema.parse(input));return this.view();}
  async save(input:unknown){
    const parsed=z.object({revision:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),settings:lifecycleSettingsSchema}).strict().parse(input);
    if(!this.configService)return this.configure(parsed.settings);
    await this.configService.update('memory',parsed.settings,parsed.revision);return this.view();
  }
  /** Resume does not authorize the paused gap. Preserve an already admitted
   * window, while retiring unregistered automatic rounds at today's watermark. */
  skipAutomaticBacklog(){
    for(const id of ['extraction','consolidation'] as const){const extension=this.extensions.get(id);if(!extension)continue;const state=this.state(id);
      const row=extension.stream==='artifact'?this.store.db.prepare('SELECT max(seq) n FROM artifact_events').get():extension.stream==='evidence'?this.store.db.prepare('SELECT max(seq) n FROM changes').get():this.store.db.prepare('SELECT max(seq) n FROM memory_events WHERE stream=?').get(extension.stream);
      state.cursor=Math.max(state.cursor,Number(row?.n??0));delete state.drainThrough;
      if(state.cancelled&&!state.active?.manual){delete state.active;delete state.cancelled;delete state.cancellationCause;delete state.manualRetryRequired;delete state.error;delete state.retryAt;state.failures=0;}
      this.saveState(id,state);
    }
  }
  private state(id:string):State{const state=JSON.parse(String(this.store.db.prepare('SELECT json FROM memory_lifecycle_state WHERE id=?').get(id)!.json)) as State;if(state.active&&(!Array.isArray(state.active.ids)||typeof state.active.contextTime!=='string'||!Number.isFinite(Date.parse(state.active.contextTime))))throw new StoreError('Unsupported lifecycle window structure',409);return state;}
  private saveState(id:string,state:State){this.store.db.prepare('INSERT INTO memory_lifecycle_state VALUES(?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(id,JSON.stringify(state));}
  private events(extension:LifecycleExtension,cursor:number,limit:number){
    return (extension.stream==='artifact'?this.store.db.prepare('SELECT seq,entity FROM artifact_events WHERE seq>? ORDER BY seq LIMIT ?').all(cursor,limit):extension.stream==='evidence'?this.store.db.prepare('SELECT seq,id AS entity FROM changes WHERE seq>? ORDER BY seq LIMIT ?').all(cursor,limit):this.store.db.prepare('SELECT seq,entity FROM memory_events WHERE stream=? AND seq>? ORDER BY seq LIMIT ?').all(extension.stream,cursor,limit)) as {seq:number;entity:string}[];
  }
  private count(extension:LifecycleExtension,cursor:number){
    // Turns (including repeated conversation IDs) are increments for working memory.
    return Number((extension.stream==='artifact'?this.store.db.prepare('SELECT count(*) AS n FROM artifact_events WHERE seq>?').get(cursor):extension.stream==='evidence'?this.store.db.prepare('SELECT count(*) AS n FROM changes WHERE seq>?').get(cursor):this.store.db.prepare('SELECT count(*) AS n FROM memory_events WHERE stream=? AND seq>?').get(extension.stream,cursor))!.n);
  }
  private dueAt(id:LifecycleExtension['id'],p:LifecycleSettings['insights'],state:State){return state.lastSuccess+(id==='insights'?p.intervalHours:(p.maxWaitHours??Math.min(p.intervalHours,1)))*3600000;}
  private ready(id:LifecycleExtension['id'],p:LifecycleSettings['insights'],state:State,pending:number,now:number){return pending>0&&(id==='insights'?pending>=p.minChanges&&now>=this.dueAt(id,p,state):pending>=p.minChanges||now>=this.dueAt(id,p,state));}
  view(){const settings=this.settings();return {...(this.configService?{revision:this.configService.revision}:{}),settings,trigger:'insights: interval AND increment threshold; memory: increment threshold OR maximum wait',storage:'text',extensions:[...this.extensions.values()].map(e=>{
    const state=this.state(e.id),p=settings[e.id],pendingChanges=this.count(e,state.cursor),dueAt=state.drainThrough?this.now():this.dueAt(e.id,p,state);
    return {id:e.id,version:e.version,stream:e.stream,pendingChanges,dueAt,retryAt:state.retryAt,cursor:state.cursor,failures:state.failures,maxAttempts:e.maxAttempts,error:state.error,manualRetryRequired:state.manualRetryRequired??false,
      trigger:e.id==='insights'?'interval AND increment threshold':'increment threshold OR maximum wait',
      drainThrough:state.drainThrough,status:state.cancelled||state.active&&this.executor?.get('lifecycle:'+state.active.id)?.state==='cancelled'?'cancelled':!state.active&&(!p.enabled||this.automaticAdmission?.(e.id)===false)||state.active&&!state.active.manual&&!p.enabled&&!['extraction','consolidation'].includes(e.id)?'disabled':this.running.has(e.id)?'running':state.manualRetryRequired||e.maxAttempts&&state.failures>=e.maxAttempts?'failed':(state.retryAt??0)>this.now()?'retry_wait':state.active?'pending':!this.configured()?'waiting_for_model':pendingChanges===0?'waiting_for_increment':this.ready(e.id,p,state,pendingChanges,this.now())?'ready':e.id==='insights'&&pendingChanges<p.minChanges?'waiting_for_increment':'waiting_for_interval',
      active:state.active?{id:state.active.id,manual:state.active.manual===true,operationId:this.executor?'workflow:lifecycle:'+state.active.id:undefined,through:state.active.through,items:state.active.ids.length,startedAt:state.active.startedAt,checkpoint:state.active.checkpoint}:undefined,lastRun:state.lastRun};})};}
  tick(){
    if(this.closed||this.quiescing)return Promise.resolve();
    // Aggregation is independently scheduled by the maintenance worker.
    for(const extension of this.extensions.values()){
      if(this.running.has(extension.id)||!this.configured())continue;
      // Register ownership before invoking the handler, including synchronous re-entry.
      const task=Promise.resolve().then(()=>this.execute(extension)).finally(()=>this.running.delete(extension.id));
      this.running.set(extension.id,task);
    }
    return Promise.all([...this.running.values()]).then(()=>{});
  }
  private invocationFailure(state:State){
    if(!state.active||!this.executor)return;
    const id='lifecycle:'+state.active.id,step=this.executor.get(id),receipt=this.executor.failure(id);
    if(!step||!receipt||receipt.stepId!==id||receipt.category!=='transient'||receipt.code==='interrupted'||receipt.admissionWaiting||step.error!==receipt.code||step.attempts!==receipt.attempt)return;
    if(step.state!==receipt.state||!['waiting','failed'].includes(step.state)||step.state==='waiting'&&step.availableAt!==receipt.availableAt)return;
    return {receipt,key:sha256(JSON.stringify([id,receipt]))};
  }
  private async execute(extension:LifecycleExtension){
      if(this.closed||this.quiescing||!this.configured())return;
      const settings=this.settings(),p=settings[extension.id],state=this.state(extension.id),now=this.now();
      if(!state.active&&(!p.enabled||this.automaticAdmission?.(extension.id)===false)||state.active&&!state.active.manual&&!p.enabled&&!['extraction','consolidation'].includes(extension.id)||state.cancelled||state.manualRetryRequired||extension.maxAttempts&&state.failures>=extension.maxAttempts||(state.retryAt??0)>now||state.active&&this.executor?.get('lifecycle:'+state.active.id)?.state==='cancelled')return;
      if(!state.active){
        if(!state.drainThrough){
          const pending=this.count(extension,state.cursor);
          if(pending===0)return;
          if(!this.ready(extension.id,p,state,pending,now))return;
          // Freeze a bounded extraction round. Arrivals after this watermark wait
          // for the next round; one window per tick keeps other workflows fair.
          if(extension.id==='extraction')state.drainThrough=Number(this.store.db.prepare(`SELECT max(seq) AS seq FROM (SELECT seq FROM ${extension.stream==='artifact'?'artifact_events':'changes'} WHERE seq>? ORDER BY seq LIMIT ?)`).get(state.cursor,p.maxItems*settings.drainWindows)?.seq)||undefined;
        }
        const events=this.events(extension,state.cursor,p.maxItems).filter(e=>!state.drainThrough||e.seq<=state.drainThrough);if(!events.length)return;
        state.active={id:randomUUID(),version:extension.version,from:state.cursor,through:events.at(-1)!.seq,ids:[...new Set(events.map(e=>e.entity))],startedAt:now,contextTime:freezeSemanticContextTime(this.semanticContextTime),settings};this.saveState(extension.id,state);
      }
      try{
        // Engine failure and window state use separate commits. Consume an
        // exact outstanding failure before starting another invocation, even
        // after a crash between those commits.
        const pendingFailure=this.invocationFailure(state);
        if(pendingFailure&&pendingFailure.key!==state.countedFailure)throw new ExecutionFailure('waiting',pendingFailure.receipt.code);
        if(state.active.version!==extension.version)throw new StoreError('Active window requires its original extension version',409);
        const window=structuredClone(state.active),checkpoint=(id:string)=>{state.active!.checkpoint=id;this.saveState(extension.id,state);};
        if(this.executor){
          const executor=this.executor,id='lifecycle:'+window.id,operationId='workflow:lifecycle:'+window.id;
          // Only this window's finite, typed recovery decision can reopen a
          // failed invocation. Observing a terminal child is never retry consent.
          // The scheduled finite recovery survives a yielded admission slot or
          // interruption. A child still has to establish its own replay safety.
          const recovery=state.retryAt!==undefined&&state.failures>0?'transient' as const:undefined;
          if(recovery&&['failed','waiting'].includes(executor.get(id)?.state??'')&&executor.get(id)?.error===executor.failure(id)?.code&&executor.failure(id)?.category==='transient')executor.retry(id,false);
          await executor.runStep({id,operationId,kind:'lifecycle-window',pool:'lifecycle.'+extension.id,input:{windowId:window.id,extensionId:extension.id,version:window.version},signal:this.abort.signal,policy:EXECUTION_POLICIES.orchestration,maxAttempts:extension.maxAttempts??EXECUTION_POLICIES.modelCall.maxAttempts,
            classify:error=>error instanceof AgentTimeoutError?new ExecutionFailure('transient','provider_timeout'):new ExecutionFailure('permanent',error instanceof MemoryProviderError&&error.code==='unsupported_input'?'memory_provider_unsupported_input':error instanceof StoreError?'workflow_'+error.statusCode:'step_failed'),
            validate:()=>!this.closed&&!this.quiescing&&this.state(extension.id).active?.id===window.id,
            execute:async signal=>{
              const fence=this.store.db.prepare('SELECT fence FROM execution_steps WHERE id=?').get(id)?.fence;
              const commit=<T>(write:()=>T):T=>{signal.throwIfAborted();const db=this.store.db,own=!db.isTransaction;if(own)db.exec('BEGIN IMMEDIATE');try{if(!fence||!executor.isCurrentGrant(id,String(fence))||this.state(extension.id).active?.id!==window.id)throw new StoreError('Lifecycle execution grant expired',409);const result=write();if(own)db.exec('COMMIT');return result;}catch(error){if(own)db.exec('ROLLBACK');throw error;}};
              await extension.run(window,value=>commit(()=>checkpoint(value)),{operationId,jobId:window.id,signal,interrupted:()=>this.closed||this.quiescing||executor.closed,commit,...(recovery?{recovery}:{})});signal.throwIfAborted();return true;
            },commit:()=>{},read:()=>executor.get(id)?.state==='succeeded'?true:undefined,project:()=>{},
          });
        }else await extension.run(window,checkpoint);
        if(this.closed||this.state(extension.id).active?.id!==state.active.id)return;
        // An explicitly retired historical prefix can be ahead of a retained
        // authorized window. Completing that window never undoes the cutoff.
        state.cursor=Math.max(state.cursor,this.state(extension.id).cursor,state.active.through);if(!state.drainThrough||state.cursor>=state.drainThrough){delete state.drainThrough;if(!state.active.manual)state.lastSuccess=this.now();}state.lastRun={id:state.active.id,through:state.cursor,completedAt:this.now()};delete state.active;delete state.cancelled;delete state.cancellationCause;delete state.manualRetryRequired;delete state.error;delete state.retryAt;state.failures=0;delete state.countedFailure;
      }catch(error){
        if(this.closed||this.quiescing)return;
        if(state.active){
          if(this.executor?.get('lifecycle:'+state.active.id)?.state==='running')return;
          const latest=this.state(extension.id);if(latest.active?.id!==state.active.id)return;Object.assign(state,latest);
        }
        const receipt=state.active&&this.executor?.failure('lifecycle:'+state.active.id),invocation=state.active&&this.executor?.get('lifecycle:'+state.active.id);
        const actualFailure=this.invocationFailure(state),completedFailure=actualFailure&&actualFailure.key!==state.countedFailure;
        // The shared engine now retains a bounded retry as waiting. Preserve
        // this window's original failed-invocation count and domain backoff;
        // capacity waits and observing the same receipt cannot consume it.
        if(actualFailure&&!completedFailure)return;
        if(completedFailure)state.countedFailure=actualFailure.key;
        const waiting=(error instanceof ExecutionFailure&&error.category==='waiting'||error instanceof ProviderFailure&&error.details.admissionWaiting===true)&&!completedFailure;
        const retryable=error instanceof ProviderFailure&&error.details.category==='transient'||error instanceof ExecutionFailure&&error.category==='transient'||error instanceof AgentTimeoutError||receipt?.category==='transient';
        const maxAttempts=extension.maxAttempts??EXECUTION_POLICIES.modelCall.maxAttempts;
        const unsupportedInput=error instanceof MemoryProviderError&&error.code==='unsupported_input';
        const semanticTerminal=unsupportedInput||error instanceof ExecutionFailure&&error.category==='blocked'&&(extension.id==='extraction'&&['semantic_processing_failed','semantic_processing_blocked'].includes(error.code)||extension.id==='consolidation'&&['memory_integration_unreadable','memory_integration_no_delivery'].includes(error.code));
        if(!waiting&&(!semanticTerminal||error.code==='semantic_processing_failed'))state.failures++;
        if(semanticTerminal||!waiting&&(!retryable||state.failures>=maxAttempts||Boolean(invocation&&invocation.state==='failed'&&invocation.attempts>=maxAttempts)))state.manualRetryRequired=true;
        state.error=unsupportedInput?'memory_provider_unsupported_input':error instanceof ExecutionFailure?error.code:error instanceof ProviderFailure?error.details.code:error instanceof AgentTimeoutError?'provider_timeout':error instanceof StoreError?'workflow_'+error.statusCode:'workflow_failed';
        if(!state.cancelled&&!state.manualRetryRequired&&(waiting||state.failures<maxAttempts)){
          const requestedDelay=error instanceof ExecutionFailure?error.retryAfterMs:error instanceof ProviderFailure?error.details.retryAfterMs:undefined;
          const failedAt=completedFailure?Math.min(this.now(),Date.parse(actualFailure.receipt.at)):this.now();
          state.retryAt=Math.max(completedFailure?actualFailure.receipt.availableAt??0:0,failedAt+(waiting?Math.max(1,requestedDelay??60000):Math.max(requestedDelay??0,Math.min(6*3600000,60000*2**Math.min(state.failures,8)))));
        }else delete state.retryAt;
      }
      this.saveState(extension.id,state);
  }
  /** Stop admitting windows and interrupt in-flight invocations without
   * cancelling their durable checkpoints. A later start resumes them. */
  quiesce(){
    if(this.closed||this.quiescing)return this.interrupting??Promise.resolve();
    this.quiescing=true;this.abort.abort();
    this.interrupting=(async()=>{try{await this.interrupt();}finally{this.interrupting=undefined;}})();
    return this.interrupting;
  }
  /** Reopen admission on the same durable lifecycle after quiesce/stop. */
  start(){
    if(this.closed)throw new StoreError('Memory lifecycle is closed',503);
    if(this.running.size||this.interrupting)throw new StoreError('Wait for lifecycle work to stop before restarting',409);
    this.quiescing=false;this.abort=new AbortController();
  }
  private async interrupt(){
    // Shutdown/fencing interrupts replayable work; explicit owner cancellation stays terminal.
    const interrupted=[...this.running.keys()].flatMap(key=>{const window=this.state(key).active,id=window?'lifecycle:'+window.id:undefined;return id&&this.executor?.get(id)?.state==='running'?[id]:[];});
    this.abort.abort();await Promise.allSettled([...this.running.values()]);
    for(const id of interrupted)if(this.executor?.get(id)?.state==='cancelled')this.executor.retry(id,false);
  }
  async close(){
    if(this.closing)return this.closing;
    this.closed=true;this.quiescing=true;
    this.closing=(async()=>{await this.interrupting?.catch(()=>{});await this.interrupt();})();
    return this.closing;
  }
}
