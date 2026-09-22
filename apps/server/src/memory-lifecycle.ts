import {ExecutionEngine} from './execution-engine.js';
import {AgentTimeoutError} from '@mote/agent';
import {ProviderFailure} from '@mote/shared';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {Store,StoreError} from './store.js';

const policy=z.object({maxWaitHours:z.number().min(1/60).max(8760).optional(),enabled:z.boolean(),intervalHours:z.number().min(1/60).max(8760),minChanges:z.number().int().min(1).max(100000),maxItems:z.number().int().min(1).max(2000)}).strict();
export const lifecycleSettingsSchema=z.object({
  extraction:policy,consolidation:policy.extend({maxItems:z.number().int().min(1).max(50)}),insights:policy,working:policy,
  drainWindows:z.number().int().min(1).max(1000).default(100),
  batchCharacters:z.number().int().min(256).max(12000),recentTurns:z.number().int().min(2).max(20),
  contextCharacters:z.number().int().min(4000).max(60000),summaryCharacters:z.number().int().min(1000).max(12000),
}).strict().refine(v=>v.summaryCharacters<v.contextCharacters,{message:'Working summary must be smaller than the context budget',path:['summaryCharacters']});
export type LifecycleSettings=z.infer<typeof lifecycleSettingsSchema>;
export const defaultLifecycleSettings:LifecycleSettings={
  extraction:{enabled:true,intervalHours:6,minChanges:25,maxItems:100},
  consolidation:{enabled:true,intervalHours:24,minChanges:20,maxItems:30},
  insights:{enabled:true,intervalHours:24,minChanges:100,maxItems:1000},
  working:{enabled:true,intervalHours:1,minChanges:8,maxItems:20},
  drainWindows:100,batchCharacters:12000,recentTurns:8,contextCharacters:24000,summaryCharacters:6000,
};
export type LifecycleWindow={id:string;version:string;from:number;through:number;ids:string[];startedAt:number;settings:LifecycleSettings;checkpoint?:string};
type State={stream?:LifecycleExtension['stream'];drainThrough?:number;cursor:number;lastSuccess:number;retryAt?:number;failures:number;active?:LifecycleWindow;lastRun?:{id:string;through:number;completedAt:number};error?:string};
export type LifecycleExecution={operationId:string;jobId:string;signal:AbortSignal;interrupted:()=>boolean;commit:<T>(write:()=>T)=>T};
export type LifecycleExtension={id:keyof Pick<LifecycleSettings,'extraction'|'consolidation'|'insights'|'working'>;version:string;stream:'evidence'|'artifact'|'memory'|'conversation';
  run:(window:LifecycleWindow,checkpoint:(id:string)=>void,execution?:LifecycleExecution)=>Promise<void>};

/** The host owns persistence/admission; replaceable extensions own model procedures.
 * Each window is a contiguous journal prefix. Arrivals during a run stay pending.
 * No timers, semantic dispatch, or write tools are installed in query sessions. */
export class MemoryLifecycle {
  private extensions=new Map<string,LifecycleExtension>();
  private running=new Map<string,Promise<void>>();
  private closed=false;private abort=new AbortController();
  constructor(private store:Store,private configured:()=>boolean,private now:()=>number=Date.now,legacyInsightHours=0,private executor?:ExecutionEngine){
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_lifecycle_settings(id INTEGER PRIMARY KEY CHECK(id=1),json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memory_lifecycle_state(id TEXT PRIMARY KEY,json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memory_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,stream TEXT NOT NULL,entity TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS memory_events_stream ON memory_events(stream,seq);
      CREATE TRIGGER IF NOT EXISTS memory_event_insert AFTER INSERT ON memories WHEN coalesce(json_extract(new.json,'$.tier'),'episode')='episode' BEGIN INSERT INTO memory_events(stream,entity) VALUES('memory',new.id); END;
      CREATE TRIGGER IF NOT EXISTS memory_event_update AFTER UPDATE ON memories WHEN new.json!=old.json AND coalesce(json_extract(new.json,'$.tier'),'episode')='episode' BEGIN INSERT INTO memory_events(stream,entity) VALUES('memory',new.id); END;
      CREATE TRIGGER IF NOT EXISTS conversation_event_insert AFTER INSERT ON conversations BEGIN INSERT INTO memory_events(stream,entity) VALUES('conversation',new.id); END;
      CREATE TRIGGER IF NOT EXISTS conversation_event_update AFTER UPDATE ON conversations WHEN new.json!=old.json BEGIN INSERT INTO memory_events(stream,entity) VALUES('conversation',new.id); END;
    `);
    if(!store.db.prepare('SELECT 1 FROM memory_lifecycle_settings').get()){
      const settings=structuredClone(defaultLifecycleSettings);if(legacyInsightHours>0)settings.insights.intervalHours=legacyInsightHours;
      store.db.exec('BEGIN IMMEDIATE');
      try{
        const inserted=store.db.prepare('INSERT OR IGNORE INTO memory_lifecycle_settings VALUES(1,?)').run(JSON.stringify(settings));
        if(inserted.changes)store.db.exec("INSERT INTO memory_events(stream,entity) SELECT 'memory',id FROM memories; INSERT INTO memory_events(stream,entity) SELECT 'conversation',id FROM conversations");
        store.db.exec('COMMIT');
      }catch(error){store.db.exec('ROLLBACK');throw error;}
    }
  }
  register(extension:LifecycleExtension){
    if(this.extensions.has(extension.id))throw new Error('Duplicate lifecycle extension: '+extension.id);
    this.extensions.set(extension.id,extension);
    const exists=this.store.db.prepare('SELECT id FROM memory_lifecycle_state WHERE id=?').get(extension.id);
    // A journal cursor is meaningful only in its original stream. Rebuild the
    // new artifact cursor; existing memories and durable manual jobs stay intact.
    if(!exists||(extension.stream==='artifact'&&this.state(extension.id).stream!=='artifact'))this.save(extension.id,{stream:extension.stream,cursor:0,lastSuccess:this.now(),failures:0});
  }
  replace(extension:LifecycleExtension){
    if(!this.extensions.has(extension.id))return this.register(extension);
    if(this.running.has(extension.id)||this.state(extension.id).active)throw new StoreError('Finish the active window before replacing an extension',409);
    this.extensions.set(extension.id,extension);
  }
  settings():LifecycleSettings{return lifecycleSettingsSchema.parse(JSON.parse(String(this.store.db.prepare('SELECT json FROM memory_lifecycle_settings WHERE id=1').get()!.json)));}
  configure(input:unknown){const parsed=lifecycleSettingsSchema.parse(input);this.store.db.prepare('UPDATE memory_lifecycle_settings SET json=? WHERE id=1').run(JSON.stringify(parsed));return this.view();}
  private state(id:string):State{return JSON.parse(String(this.store.db.prepare('SELECT json FROM memory_lifecycle_state WHERE id=?').get(id)!.json));}
  private save(id:string,state:State){this.store.db.prepare('INSERT INTO memory_lifecycle_state VALUES(?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(id,JSON.stringify(state));}
  private events(extension:LifecycleExtension,cursor:number,limit:number){
    return (extension.stream==='artifact'?this.store.db.prepare('SELECT seq,entity FROM artifact_events WHERE seq>? ORDER BY seq LIMIT ?').all(cursor,limit):extension.stream==='evidence'?this.store.db.prepare('SELECT seq,id AS entity FROM changes WHERE seq>? ORDER BY seq LIMIT ?').all(cursor,limit):this.store.db.prepare('SELECT seq,entity FROM memory_events WHERE stream=? AND seq>? ORDER BY seq LIMIT ?').all(extension.stream,cursor,limit)) as {seq:number;entity:string}[];
  }
  private count(extension:LifecycleExtension,cursor:number){
    // Turns (including repeated conversation IDs) are increments for working memory.
    return Number((extension.stream==='artifact'?this.store.db.prepare('SELECT count(*) AS n FROM artifact_events WHERE seq>?').get(cursor):extension.stream==='evidence'?this.store.db.prepare('SELECT count(*) AS n FROM changes WHERE seq>?').get(cursor):this.store.db.prepare('SELECT count(*) AS n FROM memory_events WHERE stream=? AND seq>?').get(extension.stream,cursor))!.n);
  }
  view(){const settings=this.settings();return {settings,trigger:'increment threshold OR maximum wait',storage:'text',extensions:[...this.extensions.values()].map(e=>{
    const state=this.state(e.id),p=settings[e.id],pendingChanges=this.count(e,state.cursor),dueAt=state.drainThrough?this.now():state.lastSuccess+(p.maxWaitHours??Math.min(p.intervalHours,1))*3600000;
    return {id:e.id,version:e.version,stream:e.stream,pendingChanges,dueAt,retryAt:state.retryAt,cursor:state.cursor,failures:state.failures,error:state.error,
      drainThrough:state.drainThrough,status:!p.enabled?'disabled':state.active&&this.executor?.get('lifecycle:'+state.active.id)?.state==='cancelled'?'cancelled':this.running.has(e.id)?'running':(state.retryAt??0)>this.now()?'retry_wait':state.active?'pending':!this.configured()?'waiting_for_model':pendingChanges===0?'waiting_for_increment':pendingChanges>=p.minChanges||this.now()>=dueAt?'ready':'waiting_for_interval',
      active:state.active?{id:state.active.id,operationId:this.executor?'workflow:lifecycle:'+state.active.id:undefined,through:state.active.through,items:state.active.ids.length,startedAt:state.active.startedAt,checkpoint:state.active.checkpoint}:undefined,lastRun:state.lastRun};})};}
  tick(){
    if(this.closed)return Promise.resolve();
    // Aggregation is independently scheduled by the maintenance worker.
    for(const extension of this.extensions.values()){
      if(this.running.has(extension.id)||!this.configured())continue;
      // Register ownership before invoking the handler, including synchronous re-entry.
      const task=Promise.resolve().then(()=>this.execute(extension)).finally(()=>this.running.delete(extension.id));
      this.running.set(extension.id,task);
    }
    return Promise.all([...this.running.values()]).then(()=>{});
  }
  private async execute(extension:LifecycleExtension){
      if(this.closed||!this.configured())return;
      const settings=this.settings(),p=settings[extension.id],state=this.state(extension.id),now=this.now();
      if(!p.enabled||(state.retryAt??0)>now||state.active&&this.executor?.get('lifecycle:'+state.active.id)?.state==='cancelled')return;
      if(!state.active){
        if(!state.drainThrough){
          const pending=this.count(extension,state.cursor);
          if(pending===0)return;
          const maximumWait=(p.maxWaitHours??Math.min(p.intervalHours,1))*3600000;
          if(pending<p.minChanges&&now<state.lastSuccess+maximumWait)return;
          // Freeze a bounded extraction round. Arrivals after this watermark wait
          // for the next round; one window per tick keeps other workflows fair.
          if(extension.id==='extraction')state.drainThrough=Number(this.store.db.prepare(`SELECT max(seq) AS seq FROM (SELECT seq FROM ${extension.stream==='artifact'?'artifact_events':'changes'} WHERE seq>? ORDER BY seq LIMIT ?)`).get(state.cursor,p.maxItems*settings.drainWindows)?.seq)||undefined;
        }
        const events=this.events(extension,state.cursor,p.maxItems).filter(e=>!state.drainThrough||e.seq<=state.drainThrough);if(!events.length)return;
        state.active={id:randomUUID(),version:extension.version,from:state.cursor,through:events.at(-1)!.seq,ids:[...new Set(events.map(e=>e.entity))],startedAt:now,settings};this.save(extension.id,state);
      }
      try{
        if(state.active.version!==extension.version)throw new StoreError('Active window requires its original extension version',409);
        const window=structuredClone(state.active),checkpoint=(id:string)=>{state.active!.checkpoint=id;this.save(extension.id,state);};
        if(this.executor){
          const executor=this.executor,id='lifecycle:'+window.id,operationId='workflow:lifecycle:'+window.id;
          await executor.runStep({id,operationId,kind:'lifecycle-window',pool:'lifecycle.'+extension.id,input:{windowId:window.id,extensionId:extension.id,version:window.version},signal:this.abort.signal,timeoutMs:2147483647,
            validate:()=>!this.closed&&this.state(extension.id).active?.id===window.id,
            execute:async signal=>{
              const fence=this.store.db.prepare('SELECT fence FROM execution_steps WHERE id=?').get(id)?.fence;
              const commit=<T>(write:()=>T):T=>{signal.throwIfAborted();const db=this.store.db,own=!db.isTransaction;if(own)db.exec('BEGIN IMMEDIATE');try{if(!fence||!executor.isCurrentGrant(id,String(fence))||this.state(extension.id).active?.id!==window.id)throw new StoreError('Lifecycle execution grant expired',409);const result=write();if(own)db.exec('COMMIT');return result;}catch(error){if(own)db.exec('ROLLBACK');throw error;}};
              await extension.run(window,value=>commit(()=>checkpoint(value)),{operationId,jobId:window.id,signal,interrupted:()=>this.closed||executor.closed,commit});signal.throwIfAborted();return true;
            },commit:()=>{},read:()=>executor.get(id)?.state==='succeeded'?true:undefined,project:()=>{},
          });
        }else await extension.run(window,checkpoint);
        if(this.closed||this.state(extension.id).active?.id!==state.active.id)return;
        state.cursor=state.active.through;if(!state.drainThrough||state.cursor>=state.drainThrough){delete state.drainThrough;state.lastSuccess=this.now();}state.lastRun={id:state.active.id,through:state.cursor,completedAt:this.now()};delete state.active;delete state.error;delete state.retryAt;state.failures=0;
      }catch(error){if(this.closed)return;if(state.active&&this.executor){if(this.executor.get('lifecycle:'+state.active.id)?.state==='running')return;const latest=this.state(extension.id);if(latest.active?.id!==state.active.id)return;Object.assign(state,latest);}state.failures++;state.error=error instanceof ProviderFailure?error.details.code:error instanceof AgentTimeoutError?'provider_timeout':error instanceof StoreError?'workflow_'+error.statusCode:'workflow_failed';state.retryAt=this.now()+Math.max(error instanceof ProviderFailure?error.details.retryAfterMs??0:0,Math.min(6*3600000,60000*2**Math.min(state.failures,8)));}
      this.save(extension.id,state);
  }
  async close(){
    this.closed=true;
    // Shutdown interrupts replayable work; explicit user cancellation stays terminal.
    const interrupted=[...this.running.keys()].flatMap(key=>{const window=this.state(key).active,id=window?'lifecycle:'+window.id:undefined;return id&&this.executor?.get(id)?.state==='running'?[id]:[];});
    this.abort.abort();await Promise.allSettled([...this.running.values()]);
    for(const id of interrupted)if(this.executor?.get(id)?.state==='cancelled')this.executor.retry(id,false);
  }
}
