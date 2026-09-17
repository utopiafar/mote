import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {fileReadResultSchema,type FileReadRequest} from '@mote/shared';
import {StoreError} from './store.js';
import type {SourceStore} from './sources.js';
export class FileEvidenceRequests {
 private requests=new Map<string,{request:FileReadRequest;captureId:string;expires:number;result?:unknown}>();
 constructor(private sources:SourceStore){}
 private sweep(){for(const [id,row] of this.requests)if(row.expires<Date.now())this.requests.delete(id);}
 private current(captureId:string){const capture=this.sources.store.evidence([captureId])[0];const p=capture?.provenance;
  if(!p||p.deleted||!p.document?.fileIndex)throw new StoreError('File index not found',404);
  const source=this.sources.getSource(p.sourceId),head=this.sources.getItem(p.sourceId,p.externalId);
  if(!source.enabled||head?.revision!==p.revision||!p.document.fileIndex.allowRead)throw new StoreError('File version or permission changed',409);
  return {capture,p,index:p.document.fileIndex,source};
 }
 pending(sourceId:string){this.sweep();if(!this.sources.getSource(sourceId).enabled)return {items:[]};return {items:[...this.requests.values()].filter(r=>r.request.sourceId===sourceId&&!r.result).map(r=>r.request)};}
 async complete(sourceId:string,id:string,raw:unknown){this.sweep();const row=this.requests.get(id);if(!row||row.request.sourceId!==sourceId)throw new StoreError('Read request expired',404);
  if(row.result)return {accepted:true};const result=fileReadResultSchema.parse(raw);const {capture,p,index}=this.current(row.captureId);
  if(result.status!=='ready'){row.result={status:result.status};return {accepted:true};}
  if(result.contentVersion!==row.request.contentVersion||result.text.length>row.request.length)throw new StoreError('Read response mismatch',409);
  const request=row.request;const item={externalId:p.externalId+':excerpt:'+request.contentVersion+':'+request.offset+':'+request.length,revision:request.contentVersion,observedAt:capture.capturedAt,modifiedAt:p.modifiedAt,title:capture.windowTitle,text:result.text,kind:'file',layer:'snapshot',mimeType:'text/plain',document:{...p.document,fileIndex:{...index,coverage:'excerpt',status:'ready',offset:request.offset,length:result.text.length,allowRead:false}}};
  const saved=await this.sources.upsert(p.sourceId,item,()=>{this.current(row.captureId);},saved=>{
   this.sources.store.db.prepare('INSERT OR IGNORE INTO file_evidence_links(parent_id,capture_id) VALUES(?,?)').run(row.captureId,saved.id);
  });
  row.result={status:'ready',record:this.sources.store.evidence([saved.id])[0]};return {accepted:true};
 }
 async read(id:string,offset:number,length:number){this.sweep();const {p,index}=this.current(id);
  if(index.mode==='catalog')return {status:'unavailable',reason:'catalog_only'};
  if(this.requests.size>=100)throw new StoreError('Too many evidence requests',429);
  const request:FileReadRequest={id:randomUUID(),sourceId:p.sourceId,externalId:p.externalId,revision:p.revision,contentVersion:index.contentVersion,offset,length};
  const row:{request:FileReadRequest;captureId:string;expires:number;result?:any}={request,captureId:id,expires:Date.now()+30000};this.requests.set(request.id,row);
  try{while(Date.now()<row.expires){if(row.result)return row.result;await delay(200);}return {status:'unavailable',reason:'device_offline_or_parser_unavailable'};}finally{this.requests.delete(request.id);}
 }
}
