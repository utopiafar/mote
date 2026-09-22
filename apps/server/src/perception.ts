import {ExecutionEngine,ExecutionFailure,type ExecutionStep} from './execution-engine.js';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {fileProcessingSchema,transcriptSchema} from '@mote/shared';
import {Store,StoreError,sha256} from './store.js';
import type {FileProcessorRuntime} from './file-processors.js';

const endpoint=z.string().max(2048).refine(value=>{if(!value)return true;try{const u=new URL(value);return ['http:','https:'].includes(u.protocol)&&!u.username&&!u.password&&!u.search&&!u.hash&&(u.protocol==='https:'||['127.0.0.1','localhost','[::1]'].includes(u.hostname));}catch{return false;}},'Use HTTPS or loopback HTTP');
export const perceptionSettingsSchema=z.object({
  ocrProcessorId:z.string().max(100).default('image.http'),semanticProcessorId:z.string().max(100).default('image.http'),concurrency:z.number().int().min(1).max(8).default(2),
  providerRevision:z.string().min(1).max(128).default('1'),enabled:z.boolean().default(true),ocrEndpoint:endpoint.default(''),semanticEndpoint:endpoint.default(''),
  semanticMode:z.enum(['manual','realtime','batch']).default('manual'),batchMinutes:z.number().int().min(1).max(1440).default(15),
  batchSize:z.number().int().min(1).max(100).default(20),allowExternalProcessing:z.boolean().default(false),allowQueryImages:z.boolean().default(false),
}).strict();
export type PerceptionSettings=z.infer<typeof perceptionSettingsSchema>;
/** Durable screenshot adapter for the existing processor runtime. Ingest triggers create jobs atomically. */
export class Perception {
  readonly engine:ExecutionEngine;private owned:boolean;private closed=false;
  private inFlight=new Map<string,Promise<unknown>>();
  constructor(private store:Store,private runtime:FileProcessorRuntime,engine?:ExecutionEngine){
    this.engine=engine??new ExecutionEngine(store);this.owned=!engine;
    // One-time compatibility recovery: only jobs with no durable engine step are legacy.
    store.db.exec("UPDATE perception_jobs SET state='waiting' WHERE state='running' AND NOT EXISTS(SELECT 1 FROM execution_steps WHERE operation_id='capture:'||perception_jobs.capture_id AND kind='perception.'||perception_jobs.kind)");
    for(const kind of ['ocr','semantic'] as const)this.engine.register({kind:'perception.'+kind,pool:'image-'+kind,concurrency:()=>kind==='ocr'?this.settings().concurrency:1,
      validate:step=>this.valid(step),admit:step=>this.admit(step),execute:(step,signal)=>this.process(step,signal),commit:(step,result)=>this.commit(step,result),project:step=>this.project(step),
      classify:error=>error instanceof z.ZodError?new ExecutionFailure('permanent','invalid_processor_output'):new ExecutionFailure('transient','processor_failed',60000),
    });
  }
  private execution(settings:PerceptionSettings,kind:string){return sha256(JSON.stringify([settings.enabled,settings.allowExternalProcessing,settings.providerRevision,kind==='ocr'?settings.ocrProcessorId:settings.semanticProcessorId,kind==='ocr'?settings.ocrEndpoint:settings.semanticEndpoint]));}
  private valid(step:ExecutionStep){return !this.closed&&this.store.imageReference(String(step.input.captureId))?.blobHash===step.input.blobHash&&this.execution(this.settings(),String(step.input.kind))===step.input.configRevision;}
  private admit(step:ExecutionStep){
    const settings=this.settings(),kind=String(step.input.kind),url=kind==='ocr'?settings.ocrEndpoint:settings.semanticEndpoint;
    if(!settings.enabled)return new ExecutionFailure('blocked','processing_disabled');
    if(!url)return new ExecutionFailure('blocked','provider_not_configured');
    if(!settings.allowExternalProcessing&&!['localhost','127.0.0.1','[::1]'].includes(new URL(url).hostname))return new ExecutionFailure('blocked','external_processing_disabled');
    try{const processor=this.runtime.registry.get(kind==='ocr'?settings.ocrProcessorId:settings.semanticProcessorId);if(step.input.processorVersion&&step.input.processorVersion!==processor.version)return new ExecutionFailure('blocked','processor_version_unavailable');}catch{return new ExecutionFailure('blocked','processor_unavailable');}
  }
  private project(step:ExecutionStep){
    if(!this.valid(step))return;
    const state=step.state==='waiting'&&step.error==='processor_failed'?'failed':step.state;
    this.store.db.prepare('UPDATE perception_jobs SET state=?,attempts=?,available_at=?,error=? WHERE capture_id=? AND kind=?').run(state,step.attempts,step.availableAt,step.error??null,String(step.input.captureId),String(step.input.kind));
  }
  settings(){const row=this.store.db.prepare("SELECT value FROM settings WHERE key='perception'").get();return perceptionSettingsSchema.parse(row?JSON.parse(String(row.value)):{});}
  view(){return {recent:this.store.db.prepare('SELECT capture_id AS id,kind,state,error FROM perception_jobs ORDER BY created_at DESC LIMIT 40').all(),settings:this.settings(),jobs:this.store.db.prepare('SELECT kind,state,count(*) AS count FROM perception_jobs GROUP BY kind,state').all()};}
  configure(raw:unknown){
    const previous=this.settings(),value=perceptionSettingsSchema.parse(raw);
    this.store.db.prepare("INSERT INTO settings VALUES('perception',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(value));
    for(const kind of ['ocr','semantic'] as const)if(this.execution(previous,kind)!==this.execution(value,kind)){
      this.engine.cancelKind('perception.'+kind);
      this.store.db.prepare("UPDATE perception_jobs SET state='waiting',attempts=0,available_at=0 WHERE kind=? AND state IN ('failed','blocked','running')").run(kind);
    }
    return this.view();
  }

  retry(id:string,kind:'ocr'|'semantic'){
    if(!this.store.imageReference(id)?.blobHash)throw new StoreError('Screenshot not found',404);
    this.store.db.prepare("INSERT INTO perception_jobs(capture_id,kind,state,created_at) VALUES(?,?,'waiting',?) ON CONFLICT(capture_id,kind) DO UPDATE SET state='waiting',attempts=0,available_at=0,requested=1").run(id,kind,Date.now());
    for(const step of this.engine.list({operationId:'capture:'+id,kind:'perception.'+kind,limit:100}).items)if(this.valid(step)){if(step.state==='running')this.engine.cancel(step.id);if(step.input.requested)this.engine.retry(step.id);}
    this.store.db.prepare('UPDATE perception_jobs SET requested=1 WHERE capture_id=? AND kind=?').run(id,kind);return {queued:true};
  }
  /** Compatibility helper for callers/tests; production ticks the shared engine. */
  async tick(){const ids=this.prepare(true);await this.engine.drain(ids);}
  prepare(skipActive=false){
    if(this.closed)return [];
    const settings=this.settings(),now=Date.now(),ids:string[]=[];
    for(const kind of ['ocr','semantic'] as const){
      if(skipActive&&this.engine.hasActive('perception.'+kind))continue;
      const jobs=this.store.db.prepare("SELECT * FROM perception_jobs WHERE kind=? AND state IN ('waiting','failed','blocked') AND attempts<4 AND available_at<=? AND (kind='ocr' OR requested=1 OR ?='realtime' OR (?='batch' AND created_at<=?) OR ?='') ORDER BY created_at LIMIT ?").all(kind,now,settings.semanticMode,settings.semanticMode,now-settings.batchMinutes*60000,settings.semanticEndpoint,settings.batchSize);
      for(const job of jobs){
        const captureId=String(job.capture_id),original=this.store.imageReference(captureId);if(!original?.blobHash)continue;
        let processorVersion='';try{processorVersion=this.runtime.registry.get(kind==='ocr'?settings.ocrProcessorId:settings.semanticProcessorId).version;}catch{}
        const input={captureId,kind,processorVersion,blobHash:original.blobHash,configRevision:this.execution(settings,kind),requested:Boolean(job.requested)};
        const stepId=this.engine.enqueue('capture:'+captureId,'perception.'+kind,input,{generation:{slot:kind,version:input.configRevision}});
        if(job.state==='waiting'&&['cancelled','blocked','failed'].includes(this.engine.get(stepId)!.state))this.engine.retry(stepId);
        ids.push(stepId);
      }
    }
    return ids;
  }
  private async process(step:ExecutionStep,signal:AbortSignal){
    const settings=this.settings(),id=String(step.input.captureId),kind=String(step.input.kind),url=kind==='ocr'?settings.ocrEndpoint:settings.semanticEndpoint;
    const record=this.store.evidence([id])[0];
    if(kind==='ocr'&&!step.input.requested&&record.ocrText&&record.ocr?.status==='completed')return {skip:true};
    const processor=this.runtime.registry.get(kind==='ocr'?settings.ocrProcessorId:settings.semanticProcessorId);
    const fingerprint=sha256(JSON.stringify([step.input.blobHash,processor.id,processor.version,kind,url,settings.providerRevision,...(kind==='semantic'?[id,record.capturedAt,record.deviceId,record.appId,record.windowTitle,record.provenance]:[])]));
    const cached=this.store.db.prepare('SELECT json FROM perception_results WHERE fingerprint=? LIMIT 1').get(fingerprint);
    let result:unknown;
    if(cached)result=JSON.parse(String(cached.json)).transcript;
    else{
      let task=this.inFlight.get(fingerprint);
      if(!task){
        const image=this.store.image(id);
        task=processor.process({file:{id,title:'Screenshot',mimeType:image.mime,sizeBytes:image.bytes.length},settings:fileProcessingSchema.parse({imageEndpoint:url}),maxAudioMs:0,signal,readOriginal:async function*(){yield image.bytes;}});
        this.inFlight.set(fingerprint,task);const forget=()=>{if(this.inFlight.get(fingerprint)===task)this.inFlight.delete(fingerprint);};signal.addEventListener('abort',forget,{once:true});void task.finally(()=>{forget();signal.removeEventListener('abort',forget);}).catch(()=>{});
      }
      result=await task;
    }
    const transcript=transcriptSchema.parse(result);if(transcript.durationMs!==0)throw new ExecutionFailure('permanent','invalid_image_duration');
    const text=transcript.segments.map(s=>s.text).join('\n');if(text.length>100000)throw new ExecutionFailure('permanent','image_text_limit');
    return {id:randomUUID(),fingerprint,text,engine:processor.id,engineVersion:processor.version,configRevision:step.input.configRevision,inputHash:step.input.blobHash,generatedAt:new Date().toISOString(),transcript};
  }
  private commit(step:ExecutionStep,result:unknown){
    if((result as {skip?:boolean}).skip)return;
    this.store.savePerception(String(step.input.captureId),String(step.input.kind),result as {id:string;text:string;fingerprint:string},false);
  }
  async close(){if(this.owned)await this.engine.close();else if(!this.engine.closed)for(const kind of ['ocr','semantic'])this.engine.cancelKind('perception.'+kind);this.closed=true;}
}
