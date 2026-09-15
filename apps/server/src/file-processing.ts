import {randomUUID} from 'node:crypto';
import {readFileSync,existsSync,renameSync,rmSync,openSync,closeSync,fsyncSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {z} from 'zod';
import {fileProcessingSchema,transcriptSchema,type FileProcessingSettings,type Transcript} from '@mote/shared';
import type {ContextRecord} from '@mote/agent';
import {FileStore} from './files.js';
import {StoreError,sha256} from './store.js';

export interface TranscriptionProvider {
  transcribe(input:{body:AsyncIterable<Buffer>;sizeBytes:number;mimeType:string;settings:FileProcessingSettings;maxAudioMs:number;signal:AbortSignal}):Promise<Transcript>;
}
/** Public extension contract: raw audio in, timestamped transcript out. */
export class HttpTranscriptionProvider implements TranscriptionProvider {
  async transcribe(input:Parameters<TranscriptionProvider['transcribe']>[0]){
    const {settings,signal}=input;
    const r=await fetch(settings.endpoint,{method:'POST',headers:{'Content-Type':'application/octet-stream','Content-Length':String(input.sizeBytes),'X-Mote-Max-Audio-Ms':String(input.maxAudioMs),...(settings.apiKey?{Authorization:`Bearer ${settings.apiKey}`}:{})},body:input.body as unknown as BodyInit,duplex:'half',redirect:'error',signal} as RequestInit);
    if(!r.ok){await r.body?.cancel();throw new StoreError(r.status===413?'Audio budget or file limit exceeded':'Transcription provider failed',r.status===413?413:502);}
    const chunks:Uint8Array[]=[];let size=0;if(!r.body)throw new StoreError('Empty transcription response',502);
    const reader=r.body.getReader();try{for(;;){const {done,value:part}=await reader.read();if(done)break;size+=part.length;if(size>32*1024*1024)throw new StoreError('Transcription response too large',502);chunks.push(part);}}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
    return transcriptSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  }
}

type Saved={revision:string;settings:FileProcessingSettings};
type Job={capture_id:string;state:string;stage:string;attempts:number;summary_state:string};
export type SummarizeFiles=(records:ContextRecord[])=>Promise<{answer:string;citations:{id:string}[]}>;
export class FileProcessing {
  private saved:Saved;
  private path:string;
  private current?:Promise<void>;
  private abort=new AbortController();
  private stopping=false;
  constructor(readonly files:FileStore,private provider:TranscriptionProvider=new HttpTranscriptionProvider(),private summarize?:SummarizeFiles){
    this.path=join(files.store.directory,'file-processing.json');
    this.saved=existsSync(this.path)?z.object({revision:z.string(),settings:fileProcessingSchema}).parse(JSON.parse(readFileSync(this.path,'utf8'))):{revision:'initial',settings:fileProcessingSchema.parse({})};
    // A previous process cannot own a job lease after restart.
    files.store.db.exec("UPDATE file_jobs SET state='waiting' WHERE state='running'; UPDATE file_jobs SET summary_state='waiting' WHERE summary_state='running'");
  }
  view(){const {apiKey,...settings}=this.saved.settings;return {revision:this.saved.revision,settings:{...settings,apiKeyConfigured:!!apiKey},execution:'central'};}
  update(raw:unknown){
    const input=z.object({revision:z.string(),settings:z.record(z.unknown())}).strict().parse(raw);
    if(input.revision!==this.saved.revision)throw new StoreError('Processing settings changed; refresh before saving',409);
    const next={...input.settings};delete next.apiKeyConfigured;
    if(next.apiKey===undefined){if(next.endpoint!==this.saved.settings.endpoint&&this.saved.settings.apiKey)throw new StoreError('Changing provider requires clearing or replacing its key',409);next.apiKey=this.saved.settings.apiKey;}
    if(next.apiKey===null||next.apiKey==='')delete next.apiKey;
    const saved={revision:randomUUID(),settings:fileProcessingSchema.parse(next)},temp=this.path+'.'+randomUUID()+'.tmp';
    try{writeFileSync(temp,JSON.stringify(saved),{mode:0o600,flag:'wx'});const fd=openSync(temp,'r');try{fsyncSync(fd);}finally{closeSync(fd);}renameSync(temp,this.path);}finally{rmSync(temp,{force:true});}
    this.abort.abort();this.abort=new AbortController();this.saved=saved;
    this.files.store.db.exec("UPDATE file_jobs SET state='waiting',attempts=0,available_at=0,error=NULL WHERE state IN ('blocked','failed','running'); UPDATE file_jobs SET summary_state='waiting' WHERE summary_state IN ('blocked','failed','running')");
    return this.view();
  }
  retry(id:string,stage:'transcribe'|'summary'='transcribe'){
    this.files.version(id);
    if(this.files.store.db.prepare("SELECT 1 FROM file_jobs WHERE capture_id=? AND (state='running' OR summary_state='running')").get(id))throw new StoreError('File processing is active',409);
    this.files.store.db.prepare(stage==='summary'?"UPDATE file_jobs SET summary_state='waiting',available_at=0,error=NULL WHERE capture_id=?":"UPDATE file_jobs SET state='waiting',attempts=0,available_at=0,error=NULL WHERE capture_id=?").run(id);return {queued:true};
  }
  tick(){if(this.current)return this.current;if(this.stopping)return Promise.resolve();this.current=this.run().finally(()=>{this.current=undefined;});return this.current;}
  private exists(id:string,revision:string){return !this.stopping&&this.saved.revision===revision&&!!this.files.store.db.prepare('SELECT 1 FROM file_versions WHERE capture_id=?').get(id);}
  private async run(){
    const db=this.files.store.db,settings=this.saved.settings,revision=this.saved.revision;
    const jobs=db.prepare("SELECT * FROM file_jobs WHERE ((state IN ('waiting','failed') AND attempts<4) OR (state='succeeded' AND summary_state='waiting')) AND available_at<=? ORDER BY rowid LIMIT 2").all(Date.now()) as Job[];
    for(const job of jobs){if(this.stopping||this.saved.revision!==revision)break;const id=job.capture_id;
      if(!settings.enabled){db.prepare("UPDATE file_jobs SET state='blocked',error='not_configured' WHERE capture_id=? AND state!='succeeded'").run(id);continue;}
      if(job.state!=='succeeded'){
        const file=this.files.detail(id),mime=file.item.mimeType??'application/octet-stream';
        if(!mime.startsWith('audio/')&&!mime.startsWith('text/')){db.prepare("UPDATE file_jobs SET state='blocked',error='unsupported_format' WHERE capture_id=?").run(id);continue;}
        const day=new Date().toISOString().slice(0,10),used=Number(db.prepare('SELECT audio_ms FROM file_usage WHERE day=?').get(day)?.audio_ms??0),budget=settings.dailyAudioMinutes*60000-used;
        if(budget<=0){db.prepare("UPDATE file_jobs SET error='daily_budget',available_at=? WHERE capture_id=?").run(Date.parse(day)+86400000,id);continue;}
        db.prepare("UPDATE file_jobs SET state='running',stage='transcribe',attempts=attempts+1,config_revision=?,error=NULL WHERE capture_id=?").run(revision,id);
        try{
          const signal=AbortSignal.any([this.abort.signal,AbortSignal.timeout(settings.timeoutMs)]);
          let transcript:Transcript;
          if(mime.startsWith('text/')){
            if(file.sizeBytes>2*1024*1024)throw new StoreError('Text file too large for this processor',413);
            const text=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat([...this.files.bytes(id)]));
            transcript={durationMs:0,segments:Array.from({length:Math.ceil(text.length/4000)},(_,i)=>({startMs:0,endMs:0,text:text.slice(i*4000,(i+1)*4000)}))};
          }else transcript=transcriptSchema.parse(await this.provider.transcribe({body:ReadableAsync(this.files.bytes(id)),sizeBytes:file.sizeBytes,mimeType:mime,settings,maxAudioMs:budget,signal}));
          signal.throwIfAborted();if(!this.exists(id,revision))continue;
          if(transcript.durationMs>budget)throw new StoreError('Audio budget exceeded',413);
          const artifactId=randomUUID(),metadata={durationMs:transcript.durationMs,segments:transcript.segments.length,complete:true,provider:settings.endpoint};
          this.files.store.reserveMetadata(Buffer.byteLength(JSON.stringify(transcript))*2+4096);
          db.exec('BEGIN IMMEDIATE');
          try{
            db.prepare('UPDATE file_artifacts SET current=0 WHERE capture_id=?').run(id);
            db.prepare('INSERT INTO file_artifacts VALUES(?,?,?,?,?,?,1)').run(artifactId,id,mime.startsWith('text/')?'text':'transcript',new Date().toISOString(),revision,JSON.stringify(metadata));
            for(const s of transcript.segments)db.prepare('INSERT INTO file_chunks(id,artifact_id,capture_id,start_ms,end_ms,text) VALUES(?,?,?,?,?,?)').run(randomUUID(),artifactId,id,mime.startsWith('text/')?null:s.startMs,mime.startsWith('text/')?null:s.endMs,(s.speaker?`${s.speaker}: `:'')+s.text);
            db.prepare("UPDATE file_jobs SET state='succeeded',stage='indexed',summary_state='waiting',error=NULL WHERE capture_id=?").run(id);
            db.prepare('INSERT INTO file_usage VALUES(?,?) ON CONFLICT(day) DO UPDATE SET audio_ms=audio_ms+excluded.audio_ms').run(day,transcript.durationMs);
            this.invalidate(id);db.exec('COMMIT');
          }catch(error){db.exec('ROLLBACK');throw error;}
        }catch(error){if(this.exists(id,revision))db.prepare("UPDATE file_jobs SET state='failed',error=?,available_at=? WHERE capture_id=?").run(error instanceof StoreError&&error.statusCode===413?'processing_limit':'provider_failed',Date.now()+30000*Math.pow(2,job.attempts),id);continue;}
      }
      if(!this.exists(id,revision))continue;
      if(!settings.summarize||!this.summarize){db.prepare("UPDATE file_jobs SET summary_state='blocked' WHERE capture_id=?").run(id);continue;}
      db.prepare("UPDATE file_jobs SET summary_state='running' WHERE capture_id=?").run(id);
      try{
        const summaries:{answer:string;citationIds:string[]}[]=[];
        for(let offset=0;;offset+=20){const records=this.files.chunks(id,offset,20);if(!records.length)break;const result=await this.summarize(records);if(!this.exists(id,revision))break;
          const allowed=new Set(records.map(r=>r.id));if(!result.citations.length||result.citations.some(c=>!allowed.has(c.id)))throw new Error('Invalid summary citations');summaries.push({answer:result.answer,citationIds:result.citations.map(c=>c.id)});
        }
        if(!this.exists(id,revision))continue;
        const json=JSON.stringify({sections:summaries,complete:true});this.files.store.reserveMetadata(Buffer.byteLength(json));
        db.exec('BEGIN IMMEDIATE');try{db.prepare("UPDATE file_artifacts SET current=0 WHERE capture_id=? AND kind='summary'").run(id);db.prepare('INSERT INTO file_artifacts VALUES(?,?,?,?,?,?,1)').run(randomUUID(),id,'summary',new Date().toISOString(),revision,json);db.prepare("UPDATE file_jobs SET summary_state='succeeded' WHERE capture_id=?").run(id);this.invalidate(id);db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}
      }catch{if(this.exists(id,revision))db.prepare("UPDATE file_jobs SET summary_state='failed',error='summary_failed' WHERE capture_id=?").run(id);}
    }
  }
  private invalidate(id:string){const db=this.files.store.db;db.exec("DELETE FROM insights; UPDATE memories SET json=json_set(json,'$.status','stale')");this.files.store.invalidateConversationAnswers();db.prepare("INSERT INTO changes(id,operation,changed_at) VALUES(?,'supersede',?)").run(id,new Date().toISOString());}
  async close(){this.stopping=true;this.abort.abort();await this.current;}
}
async function* ReadableAsync(chunks:Iterable<Buffer>){yield* chunks;}
