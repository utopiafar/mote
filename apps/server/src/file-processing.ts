import {randomUUID} from 'node:crypto';
import {readFileSync,existsSync,renameSync,rmSync,openSync,closeSync,fsyncSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {z} from 'zod';
import {fileProcessingSchema,transcriptSchema,diarizationSchema,type FileProcessingSettings,type Transcript,type Diarization} from '@mote/shared';
import type {ContextRecord} from '@mote/agent';
import type {Plugin} from '@deepseek-ai/cordis';
import {FileStore} from './files.js';
import {StoreError,sha256} from './store.js';
import {FileProcessorRuntime,isLoopback,type TranscriptionProvider,type ProcessorInput} from './file-processors.js';
import {alignDialogue,applySemanticGroups,TURN_GROUP_PROMPT} from './file-dialogue.js';
export {HttpTranscriptionProvider,type TranscriptionProvider} from './file-processors.js';

type Saved={revision:string;settings:FileProcessingSettings};
type Job={capture_id:string;state:string;stage:string;attempts:number;summary_state:string;local_only:number};
type Step={fingerprint:string;state:string;artifact_id:string|null};
export type FileAnalysis=(records:ContextRecord[],prompt:string,settings:FileProcessingSettings,localOnly:boolean)=>Promise<{answer:string;citations:{id:string}[]}>;
export type SummarizeFiles=(records:ContextRecord[])=>Promise<{answer:string;citations:{id:string}[]}>;
export class FileProcessing {
  private saved:Saved;private path:string;private current?:Promise<void>;private abort=new AbortController();private stopping=false;
  readonly runtime:FileProcessorRuntime;
  constructor(readonly files:FileStore,provider?:TranscriptionProvider,private summarize?:SummarizeFiles,private options:{plugins?:Plugin[];modules?:string[];analyze?:FileAnalysis}={}){
    this.path=join(files.store.directory,'file-processing.json');
    this.saved=existsSync(this.path)?z.object({revision:z.string(),settings:fileProcessingSchema}).parse(JSON.parse(readFileSync(this.path,'utf8'))):{revision:'initial',settings:fileProcessingSchema.parse({})};
    this.runtime=new FileProcessorRuntime(provider,options.plugins,options.modules);
    files.store.db.exec("UPDATE file_jobs SET state='waiting' WHERE state='running'; UPDATE file_jobs SET summary_state='waiting' WHERE summary_state='running'; UPDATE file_steps SET state='waiting' WHERE state='running'");
  }
  view(){const {apiKey,localModelApiKey,localWorkerApiKey,...settings}=this.saved.settings;return {revision:this.saved.revision,settings:{...settings,apiKeyConfigured:!!apiKey,localModelApiKeyConfigured:!!localModelApiKey,localWorkerApiKeyConfigured:!!localWorkerApiKey},execution:'central',runtime:'cordis',processors:this.runtime.registry.list()};}
  currentSettings(){return structuredClone(this.saved.settings);}
  update(raw:unknown){
    const input=z.object({revision:z.string(),settings:z.record(z.unknown())}).strict().parse(raw);
    if(input.revision!==this.saved.revision)throw new StoreError('Processing settings changed; refresh before saving',409);
    const next={...input.settings};delete next.apiKeyConfigured;delete next.localModelApiKeyConfigured;delete next.localWorkerApiKeyConfigured;
    for(const [key,endpoint] of [['apiKey','endpoint'],['localModelApiKey','localModelEndpoint'],['localWorkerApiKey','localEndpoint']] as const){
      if(next[key]===undefined){if(next[endpoint]!==this.saved.settings[endpoint]&&this.saved.settings[key])throw new StoreError('Changing provider requires clearing or replacing its key',409);next[key]=this.saved.settings[key];}
      if(next[key]===null||next[key]==='')delete next[key];
    }
    const saved={revision:randomUUID(),settings:fileProcessingSchema.parse(next)},temp=this.path+'.'+randomUUID()+'.tmp';
    try{writeFileSync(temp,JSON.stringify(saved),{mode:0o600,flag:'wx'});const fd=openSync(temp,'r');try{fsyncSync(fd);}finally{closeSync(fd);}renameSync(temp,this.path);}finally{rmSync(temp,{force:true});}
    this.abort.abort();this.abort=new AbortController();this.saved=saved;
    this.files.store.db.exec("UPDATE file_jobs SET state='waiting',attempts=0,available_at=0,error=NULL WHERE state IN ('blocked','failed','running'); UPDATE file_jobs SET summary_state='waiting' WHERE summary_state IN ('blocked','failed','running'); UPDATE file_steps SET state='waiting' WHERE state IN ('failed','running')");
    return this.view();
  }
  retry(id:string,stage:'transcribe'|'diarize'|'summary'='transcribe'){
    this.files.version(id);const db=this.files.store.db;
    if(db.prepare("SELECT 1 FROM file_jobs WHERE capture_id=? AND (state='running' OR summary_state='running')").get(id))throw new StoreError('File processing is active',409);
    if(stage==='summary')db.prepare("UPDATE file_jobs SET summary_state='waiting',available_at=0,error=NULL WHERE capture_id=?").run(id);
    else {db.prepare("UPDATE file_jobs SET state='waiting',attempts=0,available_at=0,error=NULL WHERE capture_id=?").run(id);db.prepare(stage==='transcribe'?'DELETE FROM file_steps WHERE capture_id=?':"DELETE FROM file_steps WHERE capture_id=? AND step!='extract'").run(id);}
    return {queued:true};
  }
  tick(){if(this.current)return this.current;if(this.stopping)return Promise.resolve();this.current=this.runtime.ready.then(()=>this.run()).finally(()=>{this.current=undefined;});return this.current;}
  private exists(id:string,revision:string){return !this.stopping&&this.saved.revision===revision&&!!this.files.store.db.prepare('SELECT 1 FROM file_versions WHERE capture_id=?').get(id);}
  artifact(id:string){const row=this.files.store.db.prepare('SELECT json FROM file_artifacts WHERE id=?').get(id) as {json:string}|undefined;if(!row)throw new StoreError('Processing input artifact is missing',409);return JSON.parse(row.json);}
  private transcript(id:string):Transcript{return transcriptSchema.parse(this.artifact(id).transcript);}
  private saveArtifact(id:string,kind:string,payload:unknown,revision:string,transcript?:Transcript){
    const db=this.files.store.db,artifactId=randomUUID(),json=JSON.stringify(payload);
    this.files.store.reserveMetadata(Buffer.byteLength(json)+(transcript?Buffer.byteLength(JSON.stringify(transcript)):0)+4096);
    db.prepare('UPDATE file_artifacts SET current=0 WHERE capture_id=? AND kind=?').run(id,kind);
    db.prepare('INSERT INTO file_artifacts(id,capture_id,kind,created_at,config_revision,json,current) VALUES(?,?,?,?,?,?,1)').run(artifactId,id,kind,new Date().toISOString(),revision,json);
    if(transcript)for(const s of transcript.segments){const {speaker,uncertain,overlap}=s;db.prepare('INSERT INTO file_chunks(id,artifact_id,capture_id,start_ms,end_ms,text,metadata) VALUES(?,?,?,?,?,?,?)').run(randomUUID(),artifactId,id,kind==='text'||kind==='image-text'?null:s.startMs,kind==='text'||kind==='image-text'?null:s.endMs,s.text,JSON.stringify({speaker,uncertain,overlap}));}
    return artifactId;
  }
  private async step(id:string,name:string,processor:string,version:string,key:unknown,revision:string,execute:()=>Promise<unknown>,save:(value:any)=>string){
    const db=this.files.store.db,fingerprint=sha256(JSON.stringify(key)),old=db.prepare('SELECT fingerprint,state,artifact_id FROM file_steps WHERE capture_id=? AND step=?').get(id,name) as Step|undefined;
    if(old?.state==='succeeded'&&old.fingerprint===fingerprint&&old.artifact_id&&db.prepare('SELECT 1 FROM file_artifacts WHERE id=?').get(old.artifact_id))return old.artifact_id;
    db.prepare("INSERT INTO file_steps(capture_id,step,processor,version,fingerprint,state,attempts,updated_at) VALUES(?,?,?,?,?,'running',1,?) ON CONFLICT(capture_id,step) DO UPDATE SET processor=excluded.processor,version=excluded.version,fingerprint=excluded.fingerprint,state='running',attempts=file_steps.attempts+1,error=NULL,updated_at=excluded.updated_at").run(id,name,processor,version,fingerprint,new Date().toISOString());
    db.prepare('UPDATE file_jobs SET stage=? WHERE capture_id=?').run(name,id);
    try{
      const result=await execute();if(!this.exists(id,revision))throw new DOMException('Processing configuration changed','AbortError');
      db.exec('BEGIN IMMEDIATE');try{const artifactId=save(result);db.prepare("UPDATE file_steps SET state='succeeded',artifact_id=?,error=NULL WHERE capture_id=? AND step=?").run(artifactId,id,name);this.invalidate(id);db.exec('COMMIT');return artifactId;}catch(error){db.exec('ROLLBACK');throw error;}
    }catch(error){if(this.exists(id,revision))db.prepare("UPDATE file_steps SET state='failed',error='processor_failed' WHERE capture_id=? AND step=?").run(id,name);throw error;}
  }
  private async run(){
    const db=this.files.store.db,settings=this.saved.settings,revision=this.saved.revision;
    const jobs=db.prepare("SELECT * FROM file_jobs WHERE ((state IN ('waiting','failed') AND attempts<4) OR (state='succeeded' AND summary_state='waiting')) AND available_at<=? ORDER BY rowid LIMIT 2").all(Date.now()) as Job[];
    for(const job of jobs){
      if(this.stopping||this.saved.revision!==revision)break;const id=job.capture_id,file=this.files.detail(id),mime=file.item.mimeType??'application/octet-stream';
      if(!settings.enabled){db.prepare("UPDATE file_jobs SET state='blocked',error='not_configured' WHERE capture_id=? AND state!='succeeded'").run(id);continue;}
      const override=settings.sourceProfiles[file.sourceId];const defaults:Record<string,string>={audio:settings.audioProcessor,text:'text.utf8',image:settings.imageProcessor};
      const processorId=override&&override!=='inherit'?override:settings.typeProfiles[mime]??settings.typeProfiles[mime.split('/')[0]+'/*']??defaults[mime.split('/')[0]];
      if(!processorId||processorId==='archive'){db.prepare("UPDATE file_jobs SET state='blocked',error=? WHERE capture_id=?").run(processorId==='archive'?'archive_only':'unsupported_format',id);continue;}
      const localOnly=job.state==='succeeded'?!!job.local_only:processorId==='audio.local-dialogue',effective={...settings,audioProcessor:processorId,...(localOnly?{endpoint:settings.localEndpoint,apiKey:settings.localWorkerApiKey}:{} )};
      db.prepare('UPDATE file_jobs SET local_only=? WHERE capture_id=?').run(Number(localOnly),id);
      if(job.state!=='succeeded'){
        const day=new Date().toISOString().slice(0,10),used=Number(db.prepare('SELECT audio_ms FROM file_usage WHERE day=?').get(day)?.audio_ms??0),budget=settings.dailyAudioMinutes*60000-used;
        const extracted=db.prepare("SELECT 1 FROM file_steps WHERE capture_id=? AND step='extract' AND state='succeeded'").get(id);
        if(mime.startsWith('audio/')&&budget<=0&&!extracted){db.prepare("UPDATE file_jobs SET error='daily_budget',available_at=? WHERE capture_id=?").run(Date.parse(day)+86400000,id);continue;}
        db.prepare("UPDATE file_jobs SET state='running',attempts=attempts+1,config_revision=?,error=NULL WHERE capture_id=?").run(revision,id);
        try{
          const signal=AbortSignal.any([this.abort.signal,AbortSignal.timeout(settings.timeoutMs)]),processor=this.runtime.registry.get(processorId);
          if(!processor.mediaTypes.some(t=>mime.startsWith(t))||processor.stage!=='extract')throw new StoreError('Processor does not accept this format',409);
          const input:ProcessorInput={file:{id,title:file.item.title,mimeType:mime,sizeBytes:file.sizeBytes},settings:effective,signal,maxAudioMs:Math.max(1,budget),readOriginal:()=>ReadableAsync(this.files.bytes(id))};
          const extractId=await this.step(id,'extract',processor.id,processor.version,[file.sha256,processor.id,processor.version,effective.endpoint,settings.imageEndpoint],revision,async()=>{
            const result=transcriptSchema.parse(await processor.process(input));signal.throwIfAborted();if(mime.startsWith('audio/')&&result.durationMs>budget)throw new StoreError('Audio budget exceeded',413);return result;
          },(transcript:Transcript)=>{
            db.prepare('UPDATE file_artifacts SET current=0 WHERE capture_id=?').run(id);
            db.prepare("UPDATE file_reviews SET status='stale' WHERE capture_id=?").run(id);
            const out=this.saveArtifact(id,mime.startsWith('audio/')?'transcript':mime.startsWith('image/')?'image-text':'text',{transcript,durationMs:transcript.durationMs,segments:transcript.segments.length,complete:true,processor:processor.id,processorVersion:processor.version,uncorrected:true},revision,transcript);
            if(mime.startsWith('audio/'))db.prepare('INSERT INTO file_usage VALUES(?,?) ON CONFLICT(day) DO UPDATE SET audio_ms=audio_ms+excluded.audio_ms').run(day,transcript.durationMs);
            return out;
          });
          if(localOnly){
            if(!isLoopback(effective.endpoint))throw new StoreError('Local dialogue requires a local worker',409);
            const raw=this.transcript(extractId),diarizer=this.runtime.registry.get(settings.diarizationProcessor);
            if(diarizer.stage!=='diarize'||!diarizer.localOnly)throw new StoreError('Local dialogue requires a local diarization plugin',409);
            const diarizeId=await this.step(id,'diarize',diarizer.id,diarizer.version,[file.sha256,diarizer.id,diarizer.version,effective.endpoint,settings.speakerCount],revision,()=>diarizer.process({...input,maxAudioMs:Math.ceil(raw.durationMs)+1000}),(rawDiarization:unknown)=>{
              const data=diarizationSchema.parse(rawDiarization);
              db.prepare("UPDATE file_artifacts SET current=0 WHERE capture_id=? AND kind IN ('dialogue','corrected-dialogue','summary','speaker-names','calendar-link')").run(id);
              db.prepare("UPDATE file_reviews SET status='stale' WHERE capture_id=? AND status='proposed'").run(id);
              if(Math.abs(data.durationMs-raw.durationMs)>2000)throw new StoreError('Diarization duration does not match the original',502);
              if(data.expectedSpeakers!==settings.speakerCount)throw new StoreError('Diarization speaker-count constraint was ignored',502);
              const artifactId=this.saveArtifact(id,'diarization',{...data,samples:data.samples.map(({wavBase64,...sample})=>sample),complete:true},revision);
              for(const sample of data.samples){const bytes=Buffer.from(sample.wavBase64,'base64');if(bytes.length>768*1024||bytes.subarray(0,4).toString()!=='RIFF'||bytes.subarray(8,12).toString()!=='WAVE')throw new StoreError('Invalid speaker sample',502);this.files.saveAsset(artifactId,`speaker_samples/${sample.speaker}.wav`,'audio/wav',bytes);}
              return artifactId;
            });
            const {complete:_,...diarization}=this.artifact(diarizeId);const aligned=alignDialogue(raw,diarizationSchema.parse({...diarization,samples:[]}));
            const alignId=await this.step(id,'align','mote.align','1',[extractId,diarizeId],revision,async()=>aligned,result=>this.saveArtifact(id,'dialogue',{transcript:result,complete:true,uncorrected:true,semanticGrouping:false,inputArtifacts:[extractId,diarizeId]},revision,result));
            if(settings.semanticTurns){
              await this.step(id,'turns','mote.semantic-turns','1',[alignId,settings.localModelEndpoint,settings.localModelName],revision,async()=>{
                if(!this.options.analyze||!settings.localModelName)throw new StoreError('A local language model is required for semantic turn grouping',409);
                const ids=db.prepare('SELECT id FROM file_chunks WHERE artifact_id=? ORDER BY start_ms,rowid LIMIT 200').all(alignId).map(row=>String(row.id));const records=this.files.evidence(ids);if(records.length!==aligned.segments.length)throw new StoreError('Semantic grouping currently supports up to 200 turns per file',413);
                const response=await this.options.analyze(records.map((r,i)=>({...r,ocrText:JSON.stringify({turnIndex:i,...aligned.segments[i]})})),TURN_GROUP_PROMPT,effective,true);
                const {groups}=z.object({groups:z.array(z.array(z.number().int().nonnegative()).min(1)).max(200)}).strict().parse(JSON.parse(response.answer));
                return applySemanticGroups(aligned,groups);
              },result=>this.saveArtifact(id,'dialogue',{transcript:result,complete:true,uncorrected:true,semanticGrouping:true,inputArtifacts:[alignId]},revision,result));
            }
          }
          if(!this.exists(id,revision))continue;db.prepare("UPDATE file_jobs SET state='succeeded',stage='indexed',summary_state='waiting',error=NULL WHERE capture_id=?").run(id);
        }catch(error){if(this.exists(id,revision))db.prepare('UPDATE file_jobs SET state=?,error=?,available_at=? WHERE capture_id=?').run(error instanceof StoreError&&error.statusCode===409?'blocked':'failed',error instanceof StoreError&&error.statusCode===413?'processing_limit':error instanceof StoreError&&error.statusCode===409?'processor_not_configured':'provider_failed',Date.now()+30000*Math.pow(2,job.attempts),id);continue;}
      }
      if(!this.exists(id,revision))continue;
      if(localOnly||!settings.summarize||!this.summarize){db.prepare("UPDATE file_jobs SET summary_state='blocked' WHERE capture_id=?").run(id);continue;}
      db.prepare("UPDATE file_jobs SET summary_state='running' WHERE capture_id=?").run(id);
      try{
        const summaries:{answer:string;citationIds:string[]}[]=[];
        for(let offset=0;;offset+=20){const records=this.files.chunks(id,offset,20);if(!records.length)break;const result=await this.summarize(records);if(!this.exists(id,revision))break;
          const allowed=new Set(records.map(r=>r.id));if(!result.citations.length||result.citations.some(c=>!allowed.has(c.id)))throw new Error('Invalid summary citations');summaries.push({answer:result.answer,citationIds:result.citations.map(c=>c.id)});
        }
        if(!this.exists(id,revision))continue;db.exec('BEGIN IMMEDIATE');try{this.saveArtifact(id,'summary',{sections:summaries,complete:true},revision);db.prepare("UPDATE file_jobs SET summary_state='succeeded' WHERE capture_id=?").run(id);this.invalidate(id);db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}
      }catch{if(this.exists(id,revision))db.prepare("UPDATE file_jobs SET summary_state='failed',error='summary_failed' WHERE capture_id=?").run(id);}
    }
  }
  private invalidate(id:string){const db=this.files.store.db;db.exec("DELETE FROM insights; UPDATE memories SET json=json_set(json,'$.status','stale')");this.files.store.invalidateConversationAnswers();db.prepare("INSERT INTO changes(id,operation,changed_at) VALUES(?,'supersede',?)").run(id,new Date().toISOString());}
  async analyze(id:string,records:ContextRecord[],prompt:string){if(!this.options.analyze)throw new StoreError('Analysis model is unavailable',409);const localOnly=!!this.files.store.db.prepare('SELECT local_only FROM file_jobs WHERE capture_id=?').get(id)?.local_only;return this.options.analyze(records,prompt,this.currentSettings(),localOnly);}
  async close(){this.stopping=true;this.abort.abort();await this.current;await this.runtime.close();}
}
async function* ReadableAsync(chunks:Iterable<Buffer>){yield* chunks;}
