import {createHash} from 'node:crypto';
import {sourceConnectionSchema,sourceItemSchema,type SourceConnection,type SourceItem,type SourceItemRecord,type CaptureRecord} from '@mote/shared';
import {Store,StoreError,sha256} from './store.js';

const uuid=(text:string)=>{const h=createHash('sha256').update(text).digest('hex');return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;};
type Head={capture_id:string;observed_at:string;deleted:number};
type Version={capture_id:string;hash:string};
export class SourceStore {
  private pending=new Map<string,Promise<unknown>>();
  constructor(public store:Store){}
  listSources():SourceConnection[]{return (this.store.db.prepare('SELECT json FROM source_connections ORDER BY id').all() as {json:string}[]).map(r=>JSON.parse(r.json));}
  getSource(id:string):SourceConnection {const row=this.store.db.prepare('SELECT json FROM source_connections WHERE id=?').get(id) as {json:string}|undefined;if(!row)throw new StoreError('Source not found',404);return JSON.parse(row.json);}
  register(raw:unknown):SourceConnection {
    const input=sourceConnectionSchema.parse(raw),existing=this.listSources().find(s=>s.id===input.id);
    if(existing){if(existing.kind!==input.kind||existing.deviceId!==input.deviceId||existing.platform!==input.platform)throw new StoreError('Source identity cannot be changed',409);return existing;}
    if(this.listSources().length>=500)throw new StoreError('Maximum 500 sources',413);
    const now=new Date().toISOString(),value={...input,createdAt:now,updatedAt:now};this.store.reserveMetadata(Buffer.byteLength(JSON.stringify(value)));this.save(value);return value;
  }
  update(id:string,patch:{name?:string;enabled?:boolean;retention?:SourceConnection['retention']}):SourceConnection {
    const existing=this.getSource(id),{createdAt:_,updatedAt:__,status:___,...fields}=existing,input=sourceConnectionSchema.parse({...fields,...patch});
    const value={...existing,...input,updatedAt:new Date().toISOString()};
    const growth=Buffer.byteLength(JSON.stringify(value))-Buffer.byteLength(JSON.stringify(existing));
    if(growth>0)this.store.reserveMetadata(growth);
    this.save(value);return value;
  }
  private save(value:SourceConnection){this.store.db.prepare('INSERT INTO source_connections(id,json) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(value.id,JSON.stringify(value));}
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
  async upsert(sourceId:string,raw:unknown,authorize?:()=>void,transaction?:(result:{id:string;duplicate:boolean})=>void) {
    const item=sourceItemSchema.parse(raw),key=JSON.stringify([sourceId,item.externalId]);
    const prior=this.pending.get(key)??Promise.resolve();
    const task=prior.catch(()=>{}).then(()=>this.commit(sourceId,item,authorize,transaction));this.pending.set(key,task);
    try{return await task;}finally{if(this.pending.get(key)===task)this.pending.delete(key);}
  }
  private async commit(sourceId:string,raw:unknown,authorize?:()=>void,transaction?:(result:{id:string;duplicate:boolean})=>void) {
    authorize?.();
    const source=this.getSource(sourceId);if(!source.enabled)throw new StoreError('Source is paused',409);
    const item=sourceItemSchema.parse(raw);
    if(Date.parse(item.observedAt)>Date.now()+86400000)throw new StoreError('Observation cannot be in the future');
    if(source.retention==='reference'&&item.layer!=='reference')throw new StoreError('This source accepts references only',409);
    const {observedAt,...semantic}=item,hash=sha256(JSON.stringify(semantic));
    const prior=this.store.db.prepare('SELECT capture_id,hash FROM source_versions WHERE source_id=? AND external_id=? AND revision=?').get(sourceId,item.externalId,item.revision) as Version|undefined;
    const response=(id:string,duplicate:boolean)=>({id,sourceId,externalId:item.externalId,revision:item.revision,duplicate});
    if(prior){if(prior.hash!==hash)throw new StoreError('Revision already has different content',409);if(!this.store.evidence([prior.capture_id]).length)throw new StoreError('This revision was removed from the archive',410);if(transaction){this.store.db.exec('BEGIN IMMEDIATE');try{authorize?.();transaction({id:prior.capture_id,duplicate:true});this.store.db.exec('COMMIT');}catch(error){this.store.db.exec('ROLLBACK');throw error;}}return response(prior.capture_id,true);}
    const id=uuid(JSON.stringify([sourceId,item.externalId,item.revision]));
    const provenance={sourceId,externalId:item.externalId,revision:item.revision,layer:item.layer,mimeType:item.mimeType,uri:item.uri,modifiedAt:item.modifiedAt,calendar:item.calendar,deleted:item.deleted,metadata:item.metadata,document:item.document};
    const text=item.deleted||item.layer==='reference'?'':item.text;
    const result=await this.store.ingest({id,deviceId:source.deviceId,deviceName:source.name,platform:source.platform,capturedAt:observedAt,durationMs:0,appId:`mote.source.${source.kind}`,appName:source.name,windowTitle:item.title,ocrText:text,source:item.kind,provenance,privacy:{excluded:false,redacted:false,mode:'none'}},ack=>{
      authorize?.();
      const head=this.store.db.prepare('SELECT * FROM source_heads WHERE source_id=? AND external_id=?').get(sourceId,item.externalId) as Head|undefined;
      this.store.db.prepare('INSERT INTO source_versions(source_id,external_id,revision,capture_id,hash) VALUES(?,?,?,?,?)').run(sourceId,item.externalId,item.revision,id,hash);
      // Older observations remain history; late retries never roll the current pointer backwards.
      if(!head||Date.parse(observedAt)>=Date.parse(head.observed_at)){
        this.store.db.prepare('INSERT INTO source_heads(source_id,external_id,capture_id,observed_at,deleted) VALUES(?,?,?,?,?) ON CONFLICT(source_id,external_id) DO UPDATE SET capture_id=excluded.capture_id,observed_at=excluded.observed_at,deleted=excluded.deleted').run(sourceId,item.externalId,id,new Date(observedAt).toISOString(),Number(item.deleted));
        if(head){this.store.invalidateMemoryEvidence(head.capture_id);this.store.db.prepare("INSERT INTO changes(id,operation,changed_at) VALUES(?,'supersede',?)").run(head.capture_id,new Date().toISOString());}
      }
      transaction?.(ack);
    });
    return response(result.id,result.duplicate);
  }
  listItems(args:{sourceId?:string;deviceId?:string;kind?:string;after?:string;before?:string;limit?:number;cursor?:string;includeDeleted?:boolean}={}) {
    const clauses=['c.id=h.capture_id'],values:(string|number)[]=[];
    if(args.sourceId){clauses.push('h.source_id=?');values.push(args.sourceId);}
    if(args.deviceId){clauses.push('c.device_id=?');values.push(args.deviceId);}
    if(!args.includeDeleted)clauses.push('h.deleted=0');
    if(args.kind){clauses.push("json_extract(c.json,'$.source')=?");values.push(args.kind);}
    // Calendars use planned time; documents use explicit authored time, otherwise observation time.
    const start="COALESCE(json_extract(c.json,'$.provenance.calendar.start'),mote_context_time(c.json))",end="COALESCE(json_extract(c.json,'$.provenance.calendar.end'),mote_context_time(c.json))";
    if(args.after){clauses.push(`julianday(${end})>=julianday(?)`);values.push(args.after);}
    if(args.before){clauses.push(`julianday(${start})<julianday(?)`);values.push(args.before);}
    let offset=0;if(args.cursor){if(!/^\d{1,9}$/.test(args.cursor))throw new StoreError('Invalid source cursor');offset=Number(args.cursor);}
    const limit=Math.max(1,Math.min(args.limit??50,200));
    const rows=this.store.db.prepare(`SELECT c.id,h.deleted FROM captures c JOIN source_heads h ON c.id=h.capture_id WHERE ${clauses.join(' AND ')} ORDER BY mote_context_time(c.json) DESC,c.id LIMIT ? OFFSET ?`).all(...values,limit+1,offset) as {id:string;deleted:number}[];
    const items=rows.slice(0,limit).flatMap(r=>this.store.evidence([r.id]).map(c=>({...this.item(c,true),deleted:Boolean(r.deleted)})));
    return {items,nextCursor:rows.length>limit?String(offset+limit):null};
  }
  summary(){const layers=this.store.db.prepare("SELECT COALESCE(json_extract(json,'$.provenance.layer'),'original') AS layer,COUNT(*) AS count FROM captures GROUP BY layer").all();return {sources:this.listSources().length,layers,originals:'Authored text and source snapshots are retained in SQLite; referenced remote originals are never fetched implicitly.',index:'FTS5 plus optional embeddings',history:'Immutable revisions with a current pointer; original source deletion is recorded separately.'};}
}
