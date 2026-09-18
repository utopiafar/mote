import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {fileProcessingSchema,transcriptSchema} from '@mote/shared';
import {Store,StoreError,sha256} from './store.js';
import type {FileProcessorRuntime} from './file-processors.js';

const endpoint=z.string().max(2048).refine(value=>{if(!value)return true;try{const u=new URL(value);return ['http:','https:'].includes(u.protocol)&&!u.username&&!u.password&&!u.search&&!u.hash&&(u.protocol==='https:'||['127.0.0.1','localhost','[::1]'].includes(u.hostname));}catch{return false;}},'Use HTTPS or loopback HTTP');
export const perceptionSettingsSchema=z.object({
  providerRevision:z.string().min(1).max(128).default('1'),enabled:z.boolean().default(true),ocrEndpoint:endpoint.default(''),semanticEndpoint:endpoint.default(''),
  semanticMode:z.enum(['manual','realtime','batch']).default('manual'),batchMinutes:z.number().int().min(1).max(1440).default(15),
  batchSize:z.number().int().min(1).max(100).default(20),allowExternalProcessing:z.boolean().default(false),allowQueryImages:z.boolean().default(false),
}).strict();
export type PerceptionSettings=z.infer<typeof perceptionSettingsSchema>;
/** Durable screenshot adapter for the existing processor runtime. Ingest triggers create jobs atomically. */
export class Perception {
  private pending?:Promise<void>;private abort=new AbortController();private closed=false;
  constructor(private store:Store,private runtime:FileProcessorRuntime){
    store.db.exec("UPDATE perception_jobs SET state='waiting' WHERE state='running'");
  }
  settings(){const row=this.store.db.prepare("SELECT value FROM settings WHERE key='perception'").get();return perceptionSettingsSchema.parse(row?JSON.parse(String(row.value)):{});}
  view(){return {recent:this.store.db.prepare('SELECT capture_id AS id,kind,state,error FROM perception_jobs ORDER BY created_at DESC LIMIT 40').all(),settings:this.settings(),jobs:this.store.db.prepare('SELECT kind,state,count(*) AS count FROM perception_jobs GROUP BY kind,state').all()};}
  configure(raw:unknown){const value=perceptionSettingsSchema.parse(raw);this.abort.abort();this.abort=new AbortController();this.store.db.prepare("INSERT INTO settings VALUES('perception',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(value));this.store.db.exec("UPDATE perception_jobs SET state='waiting',attempts=0,available_at=0 WHERE state IN ('failed','blocked','running')");return this.view();}
  retry(id:string,kind:'ocr'|'semantic'){
    if(!this.store.imageReference(id)?.blobHash)throw new StoreError('Screenshot not found',404);
    this.store.db.prepare("INSERT INTO perception_jobs(capture_id,kind,state,created_at) VALUES(?,?,'waiting',?) ON CONFLICT(capture_id,kind) DO UPDATE SET state='waiting',attempts=0,available_at=0,requested=1").run(id,kind,Date.now());
    this.store.db.prepare('UPDATE perception_jobs SET requested=1 WHERE capture_id=? AND kind=?').run(id,kind);return {queued:true};
  }
  tick(){if(this.closed)return Promise.resolve();return this.pending??=this.run().finally(()=>{this.pending=undefined;});}
  private async run(){
    const settings=this.settings();if(!settings.enabled)return;
    const revision=sha256(JSON.stringify(settings)),signal=this.abort.signal,now=Date.now();
    const eligible=(url:string)=>Boolean(url)&&(settings.allowExternalProcessing||['localhost','127.0.0.1','[::1]'].includes(new URL(url).hostname));
    for(const kind of ['ocr','semantic']){const url=kind==='ocr'?settings.ocrEndpoint:settings.semanticEndpoint;if(!eligible(url))this.store.db.prepare("UPDATE perception_jobs SET state='blocked',error=? WHERE kind=? AND state IN ('waiting','failed','blocked')").run(url?'external_processing_disabled':'provider_not_configured',kind);}
    const jobs=this.store.db.prepare("SELECT * FROM perception_jobs WHERE state IN ('waiting','failed','blocked') AND attempts<4 AND available_at<=? AND ((kind='ocr' AND ?!='') OR (kind='semantic' AND ?!='' AND (requested=1 OR ?='realtime' OR (?='batch' AND created_at<=?)))) ORDER BY created_at LIMIT ?").all(now,eligible(settings.ocrEndpoint)?settings.ocrEndpoint:'',eligible(settings.semanticEndpoint)?settings.semanticEndpoint:'',settings.semanticMode,settings.semanticMode,now-settings.batchMinutes*60000,settings.batchSize);
    for(const kind of ['ocr','semantic'])if(!(kind==='ocr'?settings.ocrEndpoint:settings.semanticEndpoint))this.store.db.prepare("UPDATE perception_jobs SET state='blocked',error='provider_not_configured' WHERE kind=? AND state='waiting'").run(kind);
    let processed=0;
    for(const job of jobs){
      if(this.closed||signal.aborted||processed>=settings.batchSize)return;
      const id=String(job.capture_id),kind=String(job.kind),url=kind==='ocr'?settings.ocrEndpoint:settings.semanticEndpoint;
      if(kind==='semantic'&&!job.requested){
        if(settings.semanticMode==='manual')continue;
        if(settings.semanticMode==='batch'&&now-Number(job.created_at)<settings.batchMinutes*60000)continue;
      }
      if(!url) {this.store.db.prepare("UPDATE perception_jobs SET state='blocked',error='provider_not_configured' WHERE capture_id=? AND kind=?").run(id,kind);continue;}
      const local=['localhost','127.0.0.1','[::1]'].includes(new URL(url).hostname);
      if(!local&&!settings.allowExternalProcessing){this.store.db.prepare("UPDATE perception_jobs SET state='blocked',error='external_processing_disabled' WHERE capture_id=? AND kind=?").run(id,kind);continue;}
      processed++;
      const original=this.store.imageReference(id);if(!original?.blobHash)continue;
      const processor=this.runtime.registry.get('image.http');
      const fingerprint=sha256(JSON.stringify([original.blobHash,processor.id,processor.version,kind,url,revision]));
      this.store.db.prepare("UPDATE perception_jobs SET state='running',attempts=attempts+1,error=NULL WHERE capture_id=? AND kind=?").run(id,kind);
      try{
        const cached=this.store.db.prepare('SELECT json FROM perception_results WHERE fingerprint=? LIMIT 1').get(fingerprint);
        let result:unknown;
        if(cached)result=JSON.parse(String(cached.json)).transcript;else{
          const image=this.store.image(id);
          result=await processor.process({file:{id,title:'Screenshot',mimeType:image.mime,sizeBytes:image.bytes.length},settings:fileProcessingSchema.parse({imageEndpoint:url}),maxAudioMs:0,signal:AbortSignal.any([signal,AbortSignal.timeout(120000)]),readOriginal:async function*(){yield image.bytes;}});
        }
        const transcript=transcriptSchema.parse(result);
        if(transcript.durationMs!==0)throw Error('Invalid image result');
        const text=transcript.segments.map(s=>s.text).join('\n');if(text.length>100000)throw Error('Image text exceeds limit');
        if(this.closed||signal.aborted||this.store.imageReference(id)?.blobHash!==original.blobHash)continue;
        this.store.savePerception(id,kind,{id:randomUUID(),fingerprint,text,engine:processor.id,engineVersion:processor.version,configRevision:revision,inputHash:original.blobHash,generatedAt:new Date().toISOString(),transcript});
      }catch{
        if(this.closed||signal.aborted)continue;
        this.store.db.prepare("UPDATE perception_jobs SET state='failed',error='processor_failed',available_at=? WHERE capture_id=? AND kind=?").run(Date.now()+60000*2**Math.min(Number(job.attempts),6),id,kind);
      }
    }
  }
  async close(){this.closed=true;this.abort.abort();await this.pending;}
}
