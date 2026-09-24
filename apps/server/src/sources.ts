import type {SourcePipelineRuntime} from './source-pipelines.js';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {sourceCapabilities,sourceConnectionSchema,sourceItemSchema,type SourceConnection,type SourceItem,type SourceItemRecord,type CaptureRecord} from '@mote/shared';
import {Store,StoreError,sha256} from './store.js';

const uuid=(text:string)=>{const h=createHash('sha256').update(text).digest('hex');return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;};
type Head={capture_id:string;observed_at:string;deleted:number};
type Version={capture_id:string;hash:string};
export class SourceStore {
  private pending=new Map<string,Promise<unknown>>();
  readonly capabilities=sourceCapabilities.clone();
  constructor(public store:Store,public pipelines?:SourcePipelineRuntime){}
  listSources():SourceConnection[]{return (this.store.db.prepare('SELECT json FROM source_connections ORDER BY id').all() as {json:string}[]).map(r=>this.present(JSON.parse(r.json)));}
  getSource(id:string):SourceConnection {const row=this.store.db.prepare('SELECT json FROM source_connections WHERE id=?').get(id) as {json:string}|undefined;if(!row)throw new StoreError('Source not found',404);return this.present(JSON.parse(row.json));}
  register(raw:unknown):SourceConnection {
    const input=sourceConnectionSchema.parse(raw),existing=this.listSources().find(s=>s.id===input.id);
    if(!this.capabilities.has(input.kind))throw new StoreError('Source adapter is not installed',409);
    if(existing){if(existing.kind!==input.kind||existing.deviceId!==input.deviceId||existing.platform!==input.platform)throw new StoreError('Source identity cannot be changed',409);return existing;}
    if(this.listSources().length>=500)throw new StoreError('Maximum 500 sources',413);
    const now=new Date().toISOString(),value={...input,createdAt:now,updatedAt:now};this.store.reserveMetadata(Buffer.byteLength(JSON.stringify(value)));this.save(value);return this.present(value);
  }
  update(id:string,patch:{name?:string;enabled?:boolean;retention?:SourceConnection['retention'];initialSync?:'all'|'new_only'}):SourceConnection {
    const existing=this.getSource(id),{createdAt:_,updatedAt:__,status:___,capabilities:____,...fields}=existing,input=sourceConnectionSchema.parse({...fields,...patch});
    if(input.enabled&&!this.capabilities.has(input.kind))throw new StoreError('Source adapter is not installed',409);
    const value={...existing,...input,updatedAt:new Date().toISOString()};
    const growth=Buffer.byteLength(JSON.stringify(value))-Buffer.byteLength(JSON.stringify(existing));
    if(growth>0)this.store.reserveMetadata(growth);
    this.save(value);return this.present(value);
  }
  private present(value:SourceConnection):SourceConnection{return this.capabilities.has(value.kind)?{...value,capabilities:this.capabilities.describe(value)}:{...value,enabled:false,status:{...value.status,state:'error',code:'source_adapter_unavailable'}};}
  private save(value:SourceConnection){const {capabilities,...persisted}=value;this.store.db.prepare('INSERT INTO source_connections(id,json) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(value.id,JSON.stringify(persisted));}
  reportStatus(id:string,status:NonNullable<SourceConnection['status']>){const value=this.getSource(id);this.save({...value,status,updatedAt:new Date().toISOString()});}
  private item(c:CaptureRecord,current:boolean):SourceItemRecord {
    const p=c.provenance!;return {sourceId:p.sourceId,externalId:p.externalId,revision:p.revision,observedAt:c.capturedAt,modifiedAt:p.modifiedAt,title:c.windowTitle,text:p.layer==='reference'||p.deleted?'':c.ocrText,uri:p.uri,kind:c.source as SourceItem['kind'],layer:p.layer,calendar:p.calendar,mimeType:p.mimeType,deleted:p.deleted,metadata:p.metadata,document:p.document,captureId:c.id,receivedAt:c.receivedAt,current};
  }
  getItem(sourceId:string,externalId:string):SourceItemRecord|undefined {
    const head=this.store.db.prepare('SELECT * FROM source_heads WHERE source_id=? AND external_id=?').get(sourceId,externalId) as Head|undefined;
    if(!head)return;const c=this.store.evidence([head.capture_id])[0];return c?{...this.item(c,true),deleted:Boolean(head.deleted)}:undefined;
  }
  history(sourceId:string,externalId:string):SourceItemRecord[] {
    const head=this.getItem(sourceId,externalId);
    const rows=this.store.db.prepare('SELECT capture_id FROM source_versions WHERE source_id=? AND external_id=? ORDER BY rowid DESC LIMIT 100').all(sourceId,externalId) as {capture_id:string}[];
    return this.store.evidence(rows.map(r=>r.capture_id)).map(c=>this.item(c,c.id===head?.captureId));
  }
  private async serialized<T>(sourceId:string,run:()=>Promise<T>):Promise<T> {
    const prior=this.pending.get(sourceId)??Promise.resolve();
    const task=prior.catch(()=>{}).then(run);this.pending.set(sourceId,task);
    try{return await task;}finally{if(this.pending.get(sourceId)===task)this.pending.delete(sourceId);}
  }
  async upsert(sourceId:string,raw:unknown,authorize?:()=>void,transaction?:(result:{id:string;duplicate:boolean})=>void) {
    return (await this.serialized(sourceId,()=>this.commitBatch(sourceId,[sourceItemSchema.parse(raw)],authorize,transaction))).receipts[0];
  }
  async upsertBatch(sourceId:string,raw:unknown,authorize?:()=>void,transaction?:(result:{id:string;duplicate:boolean},index:number)=>void) {
    const items=z.array(sourceItemSchema).min(1).max(500).parse(raw);
    const identities=new Set<string>();
    for(const item of items){const key=JSON.stringify([item.externalId,item.revision]);if(identities.has(key))throw new StoreError('Batch contains duplicate source revisions',409);identities.add(key);}
    return this.serialized(sourceId,()=>this.commitBatch(sourceId,items,authorize,transaction));
  }
  private async commitBatch(sourceId:string,items:SourceItem[],authorize?:()=>void,transaction?:(result:{id:string;duplicate:boolean},index:number)=>void) {
    const source=this.getSource(sourceId);
    const validate=()=>{authorize?.();const current=this.getSource(sourceId);if(!current.enabled)throw new StoreError('Source is paused',409);for(const item of items){
      if(Date.parse(item.observedAt)>Date.now()+86400000)throw new StoreError('Observation cannot be in the future');
      if(current.retention==='reference'&&item.layer!=='reference')throw new StoreError('This source accepts references only',409);
    }};validate();
    if(this.pipelines){
      const selected=this.pipelines.select(source);
      if(selected?.storage==='archive'){
        if(transaction)throw new StoreError('Record transaction callbacks are unavailable for archive sources',409);
        return this.pipelines.receive(source,items,validate)!;
      }
    }
    const plans=items.map(item=>{
      const {observedAt,...semantic}=item,hash=sha256(JSON.stringify(semantic));
      const prior=this.store.db.prepare('SELECT capture_id,hash FROM source_versions WHERE source_id=? AND external_id=? AND revision=?').get(sourceId,item.externalId,item.revision) as Version|undefined;
      if(prior&&prior.hash!==hash)throw new StoreError('Revision already has different content',409);
      const id=prior?.capture_id??uuid(JSON.stringify([sourceId,item.externalId,item.revision]));
      const existing=prior?this.store.db.prepare('SELECT json FROM captures WHERE id=?').get(id):undefined;
      if(prior&&!existing)throw new StoreError('This revision was removed from the archive',410);
      const provenance={sourceId,externalId:item.externalId,revision:item.revision,layer:item.layer,mimeType:item.mimeType,uri:item.uri,modifiedAt:item.modifiedAt,calendar:item.calendar,deleted:item.deleted,metadata:item.metadata,document:item.document};
      return {item,hash,id,prior,capture:existing?JSON.parse(String(existing.json)):{id,deviceId:source.deviceId,deviceName:source.name,platform:source.platform,capturedAt:observedAt,durationMs:0,appId:`mote.source.${source.kind}`,appName:source.name,windowTitle:item.title,ocrText:item.deleted||item.layer==='reference'?'':item.text,source:item.kind,provenance,privacy:{excluded:false,redacted:false,mode:'none'}}};
    });
    const receipts=await this.store.ingestBatch(plans.map(p=>p.capture),(ack,index)=>{
      const {id,item,hash,prior}=plans[index];
      if(!prior){
        const head=this.store.db.prepare('SELECT * FROM source_heads WHERE source_id=? AND external_id=?').get(sourceId,item.externalId) as Head|undefined;
        this.store.db.prepare('INSERT INTO source_versions(source_id,external_id,revision,capture_id,hash) VALUES(?,?,?,?,?)').run(sourceId,item.externalId,item.revision,id,hash);
        if(!head||Date.parse(item.observedAt)>=Date.parse(head.observed_at)){
          this.store.db.prepare('INSERT INTO source_heads(source_id,external_id,capture_id,observed_at,deleted) VALUES(?,?,?,?,?) ON CONFLICT(source_id,external_id) DO UPDATE SET capture_id=excluded.capture_id,observed_at=excluded.observed_at,deleted=excluded.deleted').run(sourceId,item.externalId,id,new Date(item.observedAt).toISOString(),Number(item.deleted));
          if(head){this.store.invalidateMemoryEvidence(head.capture_id);this.store.db.prepare("INSERT INTO changes(id,operation,changed_at) VALUES(?,'supersede',?)").run(head.capture_id,new Date().toISOString());}
        }
      }
      transaction?.(ack,index);
    },validate);
    return {receipts:receipts.map((ack,index)=>({id:ack.id,sourceId,externalId:items[index].externalId,revision:items[index].revision,duplicate:ack.duplicate}))};
  }
  listItems(args:{sourceId?:string;deviceId?:string;kind?:string;after?:string;before?:string;limit?:number;cursor?:string;includeDeleted?:boolean}={}) {
    const clauses=['c.id=h.capture_id'],values:(string|number)[]=[];
    if(args.sourceId){clauses.push('h.source_id=?');values.push(args.sourceId);}
    if(args.deviceId){clauses.push('c.device_id=?');values.push(args.deviceId);}
    if(!args.includeDeleted)clauses.push('h.deleted=0');
    if(args.kind){clauses.push("json_extract(c.json,'$.source')=?");values.push(args.kind);}
    // Calendars use planned time; documents use explicit authored time, otherwise observation time.
    const start="COALESCE(json_extract(c.json,'$.provenance.calendar.start'),c.context_at)",end="COALESCE(json_extract(c.json,'$.provenance.calendar.end'),c.context_at)";
    if(args.after){clauses.push(`julianday(${end})>=julianday(?)`);values.push(args.after);}
    if(args.before){clauses.push(`julianday(${start})<julianday(?)`);values.push(args.before);}
    let position:{at:string;id:string}|undefined;
    if(args.cursor){try{position=z.object({at:z.string().datetime(),id:z.string().uuid()}).parse(JSON.parse(Buffer.from(args.cursor,'base64url').toString()));}catch{throw new StoreError('Invalid source cursor');}clauses.push('(c.context_at<? OR (c.context_at=? AND c.id>?))');values.push(position.at,position.at,position.id);}
    const limit=Math.max(1,Math.min(args.limit??50,200));
    const rows=this.store.db.prepare(`SELECT c.id,c.context_at,h.deleted FROM captures c JOIN source_heads h ON c.id=h.capture_id WHERE ${clauses.join(' AND ')} ORDER BY c.context_at DESC,c.id LIMIT ?`).all(...values,limit+1) as {id:string;context_at:string;deleted:number}[];
    const items=rows.slice(0,limit).flatMap(r=>this.store.evidence([r.id]).map(c=>({...this.item(c,true),deleted:Boolean(r.deleted)})));
    const last=rows.slice(0,limit).at(-1);return {items,nextCursor:rows.length>limit&&last?Buffer.from(JSON.stringify({at:last.context_at,id:last.id})).toString('base64url'):null};
  }
  summary(){const layers=this.store.db.prepare("SELECT COALESCE(json_extract(json,'$.provenance.layer'),'original') AS layer,COUNT(*) AS count FROM captures GROUP BY layer").all();return {sources:this.listSources().length,layers,originals:'Authored text and source snapshots are retained in SQLite; referenced remote originals are never fetched implicitly.',index:'FTS5 plus optional embeddings',history:'Immutable revisions with a current pointer; original source deletion is recorded separately.'};}
}
