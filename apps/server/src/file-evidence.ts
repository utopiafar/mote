import {z} from 'zod';
import {StoreError} from './store.js';
import type {SourceStore} from './sources.js';

// The existing tool contract uses bounded UTF-16 text ranges.
const rangeSchema=z.object({offset:z.number().int().min(0).max(10000000),length:z.number().int().min(1).max(16000)});
/** Read authorized ranges from text interpreted and retained by Central. */
export class FileEvidence {
 constructor(private sources:SourceStore){}
 private current(captureId:string){const capture=this.sources.store.evidence([captureId])[0];const p=capture?.provenance;
  if(!p||p.deleted||!p.document?.fileIndex)throw new StoreError('File index not found',404);
  const source=this.sources.getSource(p.sourceId),head=this.sources.getItem(p.sourceId,p.externalId);
  if(!source.enabled||source.retention==='reference'||head?.revision!==p.revision||!p.document.fileIndex.allowRead)throw new StoreError('File version or permission changed',409);
  return {capture,p,index:p.document.fileIndex};
 }
 async read(id:string,offset:number,length:number){
  rangeSchema.parse({offset,length});const {capture,p,index}=this.current(id);
  if(index.mode==='catalog')return {status:'unavailable',reason:'catalog_only',location:p.uri};
  const retained=this.sources.store.db.prepare('SELECT object_hash FROM file_snapshot_text WHERE capture_id=?').get(id);
  if(!retained)return {status:'unavailable',reason:'central_text_unavailable',location:p.uri};
  const text=this.sources.store.assets.read(String(retained.object_hash)).toString('utf8').slice(offset,offset+length);
  const item={externalId:p.externalId+':excerpt:'+index.contentVersion+':'+offset+':'+length,revision:index.contentVersion,observedAt:capture.capturedAt,modifiedAt:p.modifiedAt,title:capture.windowTitle,text,kind:'file',layer:'snapshot',mimeType:'text/plain',document:{...p.document,fileIndex:{...index,coverage:'excerpt',status:'ready',offset,length:text.length,allowRead:false}}};
  const saved=await this.sources.upsert(p.sourceId,item,()=>{this.current(id);},saved=>{
   this.sources.store.db.prepare('INSERT OR IGNORE INTO file_evidence_links(parent_id,capture_id) VALUES(?,?)').run(id,saved.id);
  });
  // A queued source write may yield; revoke access to a late excerpt as well.
  this.current(id);
  return {status:'ready',record:this.sources.store.evidence([saved.id])[0]};
 }
}
