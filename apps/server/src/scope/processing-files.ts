import {attachmentVisible} from './ingress-attachments.js';
import {fileOriginalGeneration} from './ingress-file-forget.js';
import {Readable} from 'node:stream';
import {z} from 'zod';
import {exportTar,transcriptMarkdown,transcriptCsv,csvCell} from '../file-export-tar.js';
import {fileTypePattern,transcriptSchema} from '@mote/shared';
import {executionEnvelope} from '@mote/shared/execution';
import type {DatabaseSync} from 'node:sqlite';
import type {UserContext} from './context.js';
import type {IngressHost} from './ingress.js';
import {identityHash} from './originals.js';
import {PrivateSql, PrivateCursor, PrivateDataError, missing} from './private-data-sql.js';
import {registerUserRoute, type ScopedRuntime} from './http.js';
import type {ProcessingHost} from './processing.js';
import {PROCESSING_DOMAIN} from './processing.js';
import type {TaskExecution} from './task-execution.js';
import {evidenceId as chunkId} from './processing-analysis.js';

const listSchema = z.object({sourceId:z.string().max(128).optional(),query:z.string().max(2000).optional(),type:fileTypePattern.optional(),mimePrefix:z.enum(['audio/','text/','image/']).optional(),limit:z.coerce.number().int().min(1).max(100).default(50),cursor:z.string().max(8192).optional()}).strict();

/** Owned presentation of existing M03 originals and M06 publications. This has
 * no data store, processor, scheduler, model call or inferred default owner. */
export function registerProcessingFiles(runtime:ScopedRuntime,db:DatabaseSync,processing:ProcessingHost,ingress:IngressHost,execution:TaskExecution,key:string){
  const bind=(context:UserContext)=>{
    const assert=()=>runtime.authority.assert(context),sql=new PrivateSql(db,context.userId,assert),cursor=new PrivateCursor(key,context.deploymentId,context.userId),originals=ingress.forUser(context),service=processing.forUser(context);
    const base=`FROM ig_originals r JOIN pd_captures c ON c.user_id=r.user_id AND c.id=r.capture_id JOIN pd_sources s ON s.user_id=r.user_id AND s.id=r.source_id JOIN pd_source_heads h ON h.user_id=r.user_id AND h.capture_id=c.id JOIN mp_original_formats f ON f.user_id=r.user_id AND f.original_id=r.id
      WHERE r.user_id=$user AND c.user_id=$user AND s.user_id=$user AND h.user_id=$user AND f.user_id=$user AND (f.format='file' OR instr(f.format,'processor:')=1) AND COALESCE(json_extract(s.json,'$.enabled'),1)=1 AND COALESCE(json_extract(c.json,'$.provenance.deleted'),0)=0 AND json_extract(c.json,'$.source')='file' AND ${attachmentVisible()}`;
    const owned=(id:string)=>{
      z.string().uuid().parse(id); const row=sql.get(`SELECT r.*,c.json capture ${base} AND r.user_id=$user AND c.id=?`,id); if(!row)throw missing();
      const ref='original:'+row.id,info=originals.readOriginal(ref,{length:0}),capture=JSON.parse(String(row.capture)),status=service.status(ref);
      return {row,ref,info,capture,status};
    };
    const detail=(id:string,includeAcoustics=true)=>{
      const {row,ref,info,capture,status}=owned(id),taskRow=sql.get('SELECT a.task_id FROM mp_admissions a JOIN execution_steps e ON e.user_id=a.user_id AND e.id=a.task_id WHERE a.user_id=$user AND e.user_id=$user AND a.original_id=? ORDER BY e.updated_at DESC,e.id LIMIT 1',String(row.id));
      const task=taskRow?execution.forUser(context).get(String(taskRow.task_id)):undefined,diarization=includeAcoustics?service.fileDiarization(ref):undefined,error=task?.failure?.code??task?.error??null;
      return {captureId:id,originalGeneration:fileOriginalGeneration(sql,ref),sourceId:info.sourceId,originalRef:ref,sizeBytes:info.totalBytes,sha256:info.hash,hasOriginal:info.available!==false,originMissing:!status.current,
        rawArtifactId:service.fileStageIds(ref).raw,cancellation:service.cancellation(ref),calendarLink:service.fileCalendar(ref),item:{...capture.provenance,title:capture.windowTitle,observedAt:capture.capturedAt,mimeType:info.mime},processing:status,
        job:task?{state:task.state,stage:task.kind,attempts:task.attempts,error,execution:executionEnvelope({state:task.state,attempts:task.attempts,errorCode:error})}:null,
        artifacts:[...(diarization?[{...diarization,kind:'diarization',complete:true}]:[]),...(status.artifactId?[{id:status.artifactId,kind:'transcript',complete:true}]:[]),...status.derivations.map(x=>({id:x.artifactId,kind:x.kind==='turns'?'dialogue':x.kind,complete:true}))]};
    };
    return {owned,detail,
      proof:(id:string)=>{const {ref}=owned(id);return identityHash({detail:detail(id,false),control:sql.get('SELECT generation,cancelled FROM mp_file_controls WHERE user_id=$user AND original_id=?',ref.slice(9)),tasks:sql.all('SELECT u.task_id,e.state,e.updated_at FROM user_tasks u JOIN execution_steps e ON e.user_id=u.user_id AND e.id=u.task_id WHERE u.user_id=$user AND e.user_id=$user AND json_extract(u.input,\'$.originalRef\')=? ORDER BY u.task_id',ref)});},
      list:(raw:unknown)=>{
        const {cursor:token,limit,...filters}=listSchema.parse(raw),query={collection:'processing-files',...filters,limit},position=token?z.object({at:z.string(),id:z.string().uuid()}).strict().parse(cursor.decodeCompact(token,query)):undefined,args:(string|number)[]=[],where:string[]=[];
        if(filters.sourceId){where.push('r.source_id=?');args.push(filters.sourceId);}
        if(filters.query){where.push("instr(lower(json_extract(c.json,'$.windowTitle')),lower(?))>0");args.push(filters.query);}
        if(filters.mimePrefix){where.push('instr(r.mime,?)=1');args.push(filters.mimePrefix);}
        if(filters.type&&filters.type!=='*/*'){where.push('r.mime LIKE ?');args.push(filters.type.replace('*','%'));}
        if(position){where.push('(c.context_at<? OR(c.context_at=? AND c.id>?))');args.push(position.at,position.at,position.id);}
        const rows=sql.all(`SELECT c.id,c.context_at ${base} AND r.user_id=$user ${where.length?' AND '+where.join(' AND '):''} ORDER BY c.context_at DESC,c.id LIMIT ?`,...args,limit+1),page=rows.slice(0,limit),last=page.at(-1);
        return {items:page.map(row=>detail(String(row.id),false)),nextCursor:rows.length>limit&&last?cursor.encodeCompact(query,{at:String(last.context_at),id:String(last.id)}):null};
      },
      chunks:(id:string,raw:unknown)=>{
        const {offset}=z.object({offset:z.coerce.number().int().min(0).default(0)}).strict().parse(raw),{capture,status}=owned(id);
        if(!status.artifactId)return {items:[],nextOffset:null};
        const artifact=service.artifact(status.artifactId),transcript=transcriptSchema.parse(artifact.payload),segments=transcript.segments.slice(offset,offset+100),names=service.fileSpeakerNames('original:'+status.original.ref.slice(9),artifact.id);
        const items=segments.map((segment,index)=>{const id=chunkId(context.userId,artifact.id,offset+index);return {...capture,id,ocrText:segment.text,source:'file',fileEvidence:{captureId:capture.id,revision:capture.provenance.revision,artifactId:artifact.id,chunkId:id,startMs:segment.startMs,endMs:segment.endMs,...(segment.speaker?{speaker:segment.speaker}:{}),...(segment.uncertain!==undefined?{uncertain:segment.uncertain}:{}),...(segment.overlap!==undefined?{overlap:segment.overlap}:{}),...(segment.documentLocation?{documentLocation:segment.documentLocation}:{}),...(segment.imageLocation?{imageLocation:segment.imageLocation}:{})}};});
        for(const item of items){const label=item.fileEvidence.speaker;if(label&&names[label])Object.assign(item.fileEvidence,{speakerAttribution:names[label]});}
        assert();return {items,nextOffset:offset+segments.length<transcript.segments.length?offset+segments.length:null};
      },
      playback:(id:string)=>{const {ref}=owned(id),ticket=originals.ticket(ref,'play');return {url:'/api/ingress/originals/'+ref.slice(9)+'/content?ticket='+encodeURIComponent(ticket.ticket)};},
      export:(id:string)=>{
        const {capture,status,ref}=owned(id),extracted=service.rawFileArtifact(ref),currentId=status.artifactId??extracted?.id;if(!currentId)throw missing();
        const transcript=transcriptSchema.parse(service.artifact(currentId).payload),raw=service.originalFileArtifact(status.original.ref,currentId),uncorrected=transcriptSchema.parse(raw.payload),diarization=service.fileDiarization(ref);
        const entries=[{name:'transcript.md',bytes:Buffer.from(transcriptMarkdown(transcript,capture.windowTitle))},{name:'transcript.csv',bytes:Buffer.from(transcriptCsv(transcript))},{name:'transcript.json',bytes:Buffer.from(JSON.stringify(transcript,null,2))},{name:'manifest.json',bytes:Buffer.from(JSON.stringify({version:1,captureId:id,sourceId:capture.provenance.sourceId,artifactId:currentId,rawExtractionArtifactId:extracted?.id,diarizationArtifactId:diarization?.id,processed:status.processed,indexed:status.indexed,originalRef:status.original.ref,originalSha256:status.original.hash,uncorrectedPreserved:true,uncorrectedArtifactId:raw.id}))}];
        entries.push({name:'uncorrected-transcript.json',bytes:Buffer.from(JSON.stringify(uncorrected,null,2))},{name:'uncorrected-transcript.md',bytes:Buffer.from(transcriptMarkdown(uncorrected,capture.windowTitle))},{name:'uncorrected-transcript.csv',bytes:Buffer.from(transcriptCsv(uncorrected))});
        if(extracted){const original=transcriptSchema.parse(extracted.payload),prefix=status.original.mime.startsWith('audio/')?'raw-asr-transcript':'raw-extraction';entries.push({name:prefix+'.json',bytes:Buffer.from(JSON.stringify(original,null,2))},{name:prefix+'.md',bytes:Buffer.from(transcriptMarkdown(original,capture.windowTitle))},{name:prefix+'.csv',bytes:Buffer.from(transcriptCsv(original))});}
        if(diarization){entries.push({name:'diarization.json',bytes:Buffer.from(JSON.stringify(diarization,null,2))},{name:'diarization.rttm',bytes:Buffer.from(diarization.segments.map(segment=>`SPEAKER ${id} 1 ${(segment.startMs/1000).toFixed(3)} ${((segment.endMs-segment.startMs)/1000).toFixed(3)} <NA> <NA> ${segment.speaker} <NA> <NA>`).join('\n')+'\n')},{name:'diarization.csv',bytes:Buffer.from([['start_ms','end_ms','speaker'],...diarization.segments.map(segment=>[segment.startMs,segment.endMs,segment.speaker])].map(row=>row.map(csvCell).join(',')).join('\r\n'))});for(const sample of diarization.samples){const name='speaker_samples/'+sample.speaker+'.wav';entries.push({name,bytes:service.fileAsset(ref,diarization.id,name)});}}
        const calendarLink=service.fileCalendar(ref);if(calendarLink)entries.push({name:'confirmed-calendar.json',bytes:Buffer.from(JSON.stringify(calendarLink,null,2))});
        const names=service.fileSpeakerNames(status.original.ref,currentId);if(Object.keys(names).length)entries.push({name:'confirmed-speakers.json',bytes:Buffer.from(JSON.stringify({inputArtifact:currentId,attributions:names},null,2))});
        for(const item of status.derivations){const payload=transcriptSchema.parse(service.artifact(String(item.artifactId)).payload);entries.push({name:item.kind+'.json',bytes:Buffer.from(JSON.stringify(payload,null,2))},{name:item.kind+'.md',bytes:Buffer.from(transcriptMarkdown(payload,capture.windowTitle))},{name:item.kind+'.csv',bytes:Buffer.from(transcriptCsv(payload))});}
        if(entries.reduce((size,item)=>size+item.bytes.length,0)>64*1024*1024)throw new PrivateDataError('invalid_data',413);
        const proof=identityHash([status.original.ref,status.original.hash,status.artifactId,status.revision,status.derivations,{raw:extracted?.id,diarization:diarization?.id},calendarLink]);
        const current=()=>{assert();const value=owned(id);if(identityHash([value.status.original.ref,value.status.original.hash,value.status.artifactId,value.status.revision,value.status.derivations,service.fileStageIds(ref),service.fileCalendar(ref)])!==proof)throw new PrivateDataError('conflict',409);};
        current();return exportTar(entries,current);
      },
    };
  };
  registerUserRoute(runtime,{scope:'user',service:PROCESSING_DOMAIN,method:'POST',url:'/api/records/:id/attachments/:attachmentId/processing',handle:({context,request})=>{const input=z.object({id:z.string().uuid(),attachmentId:z.string().uuid()}).parse(request.params);const result=ingress.forUser(context).prepareAttachment(input.id,input.attachmentId,request.body);return {...result,processing:bind(context).detail(result.captureId,false).job};}});
  registerUserRoute(runtime,{scope:'user',service:PROCESSING_DOMAIN,method:'GET',url:'/api/files',handle:({context,request})=>bind(context).list(request.query)});
  registerUserRoute(runtime,{scope:'user',service:PROCESSING_DOMAIN,method:'GET',url:'/api/files/:id',handle:({context,request})=>bind(context).detail(z.object({id:z.string().uuid()}).parse(request.params).id)});
  registerUserRoute(runtime,{scope:'user',service:PROCESSING_DOMAIN,method:'GET',url:'/api/files/:id/chunks',handle:({context,request})=>bind(context).chunks(z.object({id:z.string().uuid()}).parse(request.params).id,request.query)});
  registerUserRoute(runtime,{scope:'user',service:PROCESSING_DOMAIN,method:'POST',url:'/api/files/:id/playback',handle:({context,request})=>{z.object({}).strict().parse(request.body??{});return bind(context).playback(z.object({id:z.string().uuid()}).parse(request.params).id);}});
  registerUserRoute(runtime,{scope:'user',service:PROCESSING_DOMAIN,method:'GET',url:'/api/files/:id/export',handle:({context,request,reply})=>reply.type('application/gzip').header('Cache-Control','no-store').header('Content-Disposition','attachment; filename="mote-recording.tar.gz"').send(bind(context).export(z.object({id:z.string().uuid()}).parse(request.params).id))});
  registerUserRoute(runtime,{scope:'user',service:PROCESSING_DOMAIN,method:'DELETE',url:'/api/files/:id',handle:({context,request})=>{const id=z.object({id:z.string().uuid()}).parse(request.params).id,service=ingress.forUser(context),receipt=service.fileForgetReceipt(id,request.body);if(receipt)return receipt;const file=bind(context).owned(id);return service.forgetFile(file.capture.id,request.body);}});
  registerUserRoute(runtime,{scope:'user',service:PROCESSING_DOMAIN,method:'GET',url:'/api/files/:id/forgotten',handle:({context,request})=>ingress.forUser(context).forgottenFile(z.object({id:z.string().uuid()}).parse(request.params).id)});
  registerUserRoute(runtime,{scope:'user',service:PROCESSING_DOMAIN,method:'POST',url:'/api/files/:id/allow-again',handle:({context,request})=>ingress.forUser(context).allowFileAgain(z.object({id:z.string().uuid()}).parse(request.params).id,request.body)});
  registerUserRoute(runtime,{scope:'user',service:PROCESSING_DOMAIN,method:'GET',url:'/api/files/:id/reviews',handle:({context,request})=>{const file=bind(context).owned(z.object({id:z.string().uuid()}).parse(request.params).id);return processing.forUser(context).fileReviews(file.ref);}});
  registerUserRoute(runtime,{scope:'user',service:PROCESSING_DOMAIN,method:'POST',url:'/api/files/:id/reviews',handle:({context,request})=>{const file=bind(context).owned(z.object({id:z.string().uuid()}).parse(request.params).id);return processing.forUser(context).reviewFile(file.ref,request.body);}});
  registerUserRoute(runtime,{scope:'user',service:PROCESSING_DOMAIN,method:'POST',url:'/api/files/:id/reviews/:reviewId',handle:({context,request})=>{const input=z.object({id:z.string().uuid(),reviewId:z.string().uuid()}).parse(request.params),file=bind(context).owned(input.id);return processing.forUser(context).confirmFileReview(file.ref,input.reviewId,request.body);}});
  registerUserRoute(runtime,{scope:'user',service:PROCESSING_DOMAIN,method:'GET',url:'/api/files/:id/assets',handle:({context,request,reply})=>{const file=bind(context).owned(z.object({id:z.string().uuid()}).parse(request.params).id),query=z.object({artifactId:z.string().regex(/^[a-f0-9]{64}$/),name:z.string().max(100)}).strict().parse(request.query);const service=processing.forUser(context),bytes=service.fileAsset(file.ref,query.artifactId,query.name),current=()=>{bind(context).owned(file.capture.id);if(service.fileStageIds(file.ref).diarization!==query.artifactId)throw missing();};
    // Start reading only after Fastify's response hooks. Every emitted block
    // retains the exact source and acoustic publication, including slow reads.
    function* blocks(){for(let offset=0;offset<bytes.length;offset+=64*1024){current();yield bytes.subarray(offset,offset+64*1024);}current();}
    return reply.header('Cache-Control','no-store').type('audio/wav').send(Readable.from(blocks()));}});
  registerUserRoute(runtime,{scope:'user',service:PROCESSING_DOMAIN,method:'POST',url:'/api/files/:id/cancel',handle:({context,request})=>{z.object({}).strict().parse(request.body??{});const file=bind(context).owned(z.object({id:z.string().uuid()}).parse(request.params).id);return processing.forUser(context).cancelFile(file.ref);}});
  registerUserRoute(runtime,{scope:'user',service:PROCESSING_DOMAIN,method:'POST',url:'/api/files/:id/retry',handle:({context,request})=>{const file=bind(context).owned(z.object({id:z.string().uuid()}).parse(request.params).id);return processing.forUser(context).retryFile(file.ref,request.body);}});
  registerUserRoute(runtime,{scope:'user',service:PROCESSING_DOMAIN,method:'POST',url:'/api/files/:id/corrections',handle:({context,request})=>{const file=bind(context).owned(z.object({id:z.string().uuid()}).parse(request.params).id);return processing.forUser(context).correctFile(file.ref,request.body);}});
  registerUserRoute(runtime,{scope:'user',service:PROCESSING_DOMAIN,method:'POST',url:'/api/files/:id/speakers',handle:({context,request})=>{const file=bind(context).owned(z.object({id:z.string().uuid()}).parse(request.params).id);return processing.forUser(context).nameFileSpeakers(file.ref,request.body);}});
  return bind;
}
