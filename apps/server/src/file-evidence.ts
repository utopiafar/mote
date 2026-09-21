import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {fileReadResultSchema,type FileReadRequest} from '@mote/shared';
import {StoreError} from './store.js';
import type {SourceStore} from './sources.js';
export class FileEvidenceRequests {
 constructor(private sources:SourceStore){sources.store.db.exec('CREATE TABLE IF NOT EXISTS file_read_requests(id TEXT PRIMARY KEY,source_id TEXT NOT NULL,capture_id TEXT NOT NULL,expires INTEGER NOT NULL,request TEXT NOT NULL,result TEXT)');}
 private sweep(){this.sources.store.db.prepare('DELETE FROM file_read_requests WHERE expires<?').run(Date.now());}
 private rows(){return this.sources.store.db.prepare('SELECT * FROM file_read_requests').all().map(r=>({request:JSON.parse(String(r.request)) as FileReadRequest,captureId:String(r.capture_id),expires:Number(r.expires),result:r.result?JSON.parse(String(r.result)):undefined}));}
 private result(id:string,result:unknown){this.sources.store.db.prepare('UPDATE file_read_requests SET result=? WHERE id=?').run(JSON.stringify(result),id);}

 private current(captureId:string){const capture=this.sources.store.evidence([captureId])[0];const p=capture?.provenance;
  if(!p||p.deleted||!p.document?.fileIndex)throw new StoreError('File index not found',404);
  const source=this.sources.getSource(p.sourceId),head=this.sources.getItem(p.sourceId,p.externalId);
  if(!source.enabled||head?.revision!==p.revision||!p.document.fileIndex.allowRead)throw new StoreError('File version or permission changed',409);
  return {capture,p,index:p.document.fileIndex,source};
 }
 pending(sourceId:string){this.sweep();if(!this.sources.getSource(sourceId).enabled)return {items:[]};return {items:this.rows().filter(r=>r.request.sourceId===sourceId&&!r.result).map(r=>r.request)};}
 async complete(sourceId:string,id:string,raw:unknown){this.sweep();const row=this.rows().find(r=>r.request.id===id);if(!row||row.request.sourceId!==sourceId)throw new StoreError('Read request expired',404);
  const {capture,p,index}=this.current(row.captureId);if(row.result)return {accepted:true};const result=fileReadResultSchema.parse(raw);
  if(result.status!=='ready'){this.result(id,{status:result.status});return {accepted:true};}
  if(result.contentVersion!==row.request.contentVersion||result.text.length>row.request.length)throw new StoreError('Read response mismatch',409);
  const request=row.request;const item={externalId:p.externalId+':excerpt:'+request.contentVersion+':'+request.offset+':'+request.length,revision:request.contentVersion,observedAt:capture.capturedAt,modifiedAt:p.modifiedAt,title:capture.windowTitle,text:result.text,kind:'file',layer:'snapshot',mimeType:'text/plain',document:{...p.document,fileIndex:{...index,coverage:'excerpt',status:'ready',offset:request.offset,length:result.text.length,allowRead:false}}};
  const saved=await this.sources.upsert(p.sourceId,item,()=>{this.current(row.captureId);},saved=>{
   this.sources.store.db.prepare('INSERT OR IGNORE INTO file_evidence_links(parent_id,capture_id) VALUES(?,?)').run(row.captureId,saved.id);
  });
  this.result(id,{status:'ready',captureId:saved.id});return {accepted:true};
 }
 async read(id:string,offset:number,length:number){this.sweep();const {p,index}=this.current(id);
  if(index.mode==='catalog')return {status:'unavailable',reason:'catalog_only'};
  const request:FileReadRequest={id:randomUUID(),sourceId:p.sourceId,externalId:p.externalId,revision:p.revision,contentVersion:index.contentVersion,offset,length};
  const existing=this.rows().find(r=>r.captureId===id&&r.request.offset===offset&&r.request.length===length&&r.request.contentVersion===index.contentVersion);
  if(!existing&&this.rows().length>=100)throw new StoreError('Too many evidence requests',429);
  const selected=existing?.request??request;
  if(!existing)this.sources.store.db.prepare('INSERT INTO file_read_requests VALUES(?,?,?,?,?,NULL)').run(request.id,p.sourceId,id,Date.now()+300000,JSON.stringify(request));
  const deadline=Date.now()+1000;
  do{this.current(id);const result=this.rows().find(r=>r.request.id===selected.id)?.result;if(result)return result.status==='ready'?{status:'ready',record:this.sources.store.evidence([result.captureId])[0]}:result;await delay(50);}while(Date.now()<deadline);
  return {status:'unavailable',reason:'device_pending',requestId:selected.id,location:p.uri};
 }
}
