import {fileAttachmentAvailable,FileAttachments} from './file-attachments.js';
import type {Store} from './store.js';
import type {FileStore} from './files.js';

export type ImageInputRow={capture_id:string;adapter:string;source_id:string;hash:string|null;mime:string;revision:string;override_id:string|null;auto_eligible:number;generation:number;policy_json:string|null;created_at:number;understanding_enabled:number;reuse_allowed:number;semantic_withdrawn:number};
export type ImageOriginal={hash:string;mimeType:string;sizeBytes:number;read():AsyncIterable<Buffer>};
export type ImageInputAdapter={id:string;version:string;resolve(row:ImageInputRow):ImageOriginal|undefined};
/** Trusted adapters read accepted originals. Thumbnail/region outputs never enter
 * this registry. The durable host row is the scheduling authority. */
export class ImageInputRegistry {
 private adapters=new Map<string,ImageInputAdapter>();
 register(adapter:ImageInputAdapter){if(!/^[a-z][a-z0-9.-]{2,127}$/.test(adapter.id)||!adapter.version||this.adapters.has(adapter.id))throw Error('Invalid image input adapter');this.adapters.set(adapter.id,adapter);return ()=>{if(this.adapters.get(adapter.id)===adapter)this.adapters.delete(adapter.id);};}
 get(id:string){return this.adapters.get(id);}
 list(){return [...this.adapters.values()].map(({resolve,...metadata})=>metadata);}
}
export function screenImageSource(deviceId:string,hash:(text:string)=>string){return 'screen:'+hash(JSON.stringify(deviceId));}
export function installImageInputs(store:Store,files:FileStore,registry:ImageInputRegistry){
 const disposers=[registry.register({id:'mote.capture-image',version:'1',resolve:row=>{
  const image=store.db.prepare('SELECT blob_hash,mime FROM captures WHERE id=?').get(row.capture_id);
  if(image?.blob_hash!==row.hash||!store.isCurrentEvidence(row.capture_id))return;
  const bytes=store.assets.get(row.hash!).bytes;return {hash:row.hash!,mimeType:String(image.mime),sizeBytes:bytes,read:async function*(){yield store.image(row.capture_id).bytes;}};
 }}),registry.register({id:'mote.file-image',version:'1',resolve:row=>{
  if(!store.isCurrentEvidence(row.capture_id)||!fileAttachmentAvailable(store,row.capture_id))return;
  const version=files.version(row.capture_id),manifest=JSON.parse(version.manifest);
  const snapshot=store.db.prepare('SELECT object_hash,expires FROM file_snapshot_inputs WHERE capture_id=?').get(row.capture_id);
  const hash=version.object_hash??(snapshot&&Number(snapshot.expires)>Date.now()?String(snapshot.object_hash):null);
  if(!hash||hash!==row.hash)return;
  return {hash,mimeType:manifest.item.mimeType,sizeBytes:manifest.sizeBytes,read:async function*(){yield* files.processingBytes(row.capture_id);}};
 }})];
 return ()=>disposers.reverse().forEach(dispose=>dispose());
}
export function installImageSchema(store:Store){
 const db=store.db;
 db.exec(`CREATE TABLE IF NOT EXISTS image_inputs(
  capture_id TEXT PRIMARY KEY REFERENCES captures(id) ON DELETE CASCADE,adapter TEXT NOT NULL,source_id TEXT NOT NULL,
  hash TEXT,mime TEXT NOT NULL,revision TEXT NOT NULL,override_id TEXT,auto_eligible INTEGER NOT NULL DEFAULT 1,
  generation INTEGER NOT NULL DEFAULT 0,reuse_allowed INTEGER NOT NULL DEFAULT 1,understanding_enabled INTEGER NOT NULL DEFAULT 1,semantic_withdrawn INTEGER NOT NULL DEFAULT 0,policy_json TEXT,created_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS image_products(
  id TEXT PRIMARY KEY,capture_id TEXT NOT NULL REFERENCES image_inputs(capture_id) ON DELETE CASCADE,
  name TEXT NOT NULL,kind TEXT NOT NULL,fingerprint TEXT NOT NULL,json TEXT NOT NULL,current INTEGER NOT NULL DEFAULT 1);
 CREATE INDEX IF NOT EXISTS image_product_reuse ON image_products(fingerprint,current);
 CREATE TRIGGER IF NOT EXISTS image_policy_intake AFTER INSERT ON image_inputs BEGIN
  UPDATE image_inputs SET policy_json=mote_image_policy((SELECT value FROM settings WHERE key='image-file-policy'),new.source_id,new.mime,new.override_id) WHERE capture_id=new.capture_id;
 END;
 CREATE TABLE IF NOT EXISTS image_intake_overrides(capture_id TEXT PRIMARY KEY REFERENCES captures(id) ON DELETE CASCADE,profile_id TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS image_attachment_intents(
  parent_id TEXT NOT NULL REFERENCES captures(id) ON DELETE CASCADE,file_id TEXT NOT NULL REFERENCES archived_files(id) ON DELETE CASCADE,
  state TEXT NOT NULL DEFAULT 'waiting',error TEXT,available_at INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(parent_id,file_id));
 CREATE TRIGGER IF NOT EXISTS image_capture_intake AFTER INSERT ON captures WHEN new.blob_hash IS NOT NULL BEGIN
  INSERT INTO image_inputs(capture_id,adapter,source_id,hash,mime,revision,understanding_enabled,created_at)
   VALUES(new.id,'mote.capture-image','screen:'||mote_image_device_hash(new.device_id),new.blob_hash,new.mime,new.fingerprint,coalesce((SELECT json_extract(value,'$.understandingEnabled') FROM settings WHERE key='perception'),1),CAST(strftime('%s','now') AS INTEGER)*1000);
 END;
 CREATE TRIGGER IF NOT EXISTS image_file_intake AFTER INSERT ON file_versions
  WHEN json_extract(new.manifest,'$.item.mimeType') LIKE 'image/%' AND coalesce(json_extract(new.manifest,'$.item.deleted'),0)=0 BEGIN
  INSERT INTO image_inputs(capture_id,adapter,source_id,hash,mime,revision,override_id,understanding_enabled,created_at)
   VALUES(new.capture_id,'mote.file-image',new.source_id,coalesce(new.object_hash,json_extract(new.manifest,'$.sha256')),json_extract(new.manifest,'$.item.mimeType'),new.revision,json_extract(new.manifest,'$.processingProfileId'),coalesce((SELECT json_extract(value,'$.understandingEnabled') FROM settings WHERE key='perception'),1),CAST(strftime('%s','now') AS INTEGER)*1000);
 END;
 CREATE TRIGGER IF NOT EXISTS image_attachment_intake AFTER INSERT ON capture_files
  WHEN EXISTS(SELECT 1 FROM archived_files a WHERE a.id=new.file_id AND (json_extract(a.json,'$.mimeType') LIKE 'image/%' OR json_extract(a.json,'$.mimeType')='application/octet-stream' AND EXISTS(SELECT 1 FROM captures c,json_each(c.json,'$.provenance.document.attachments') d WHERE c.id=new.capture_id AND json_extract(d.value,'$.id')=new.file_id AND json_extract(d.value,'$.mimeType') LIKE 'image/%'))) BEGIN
  INSERT OR IGNORE INTO image_attachment_intents(parent_id,file_id) VALUES(new.capture_id,new.file_id);
 END;
 CREATE TRIGGER IF NOT EXISTS image_attachment_revoke AFTER DELETE ON capture_files BEGIN
  DELETE FROM image_attachment_intents WHERE parent_id=old.capture_id AND file_id=old.file_id;
 END;
 CREATE TRIGGER IF NOT EXISTS image_product_publish AFTER INSERT ON image_products BEGIN
  INSERT INTO changes(id,operation,changed_at) VALUES(new.capture_id,'upsert',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
 END;
 CREATE TRIGGER IF NOT EXISTS image_product_retire AFTER UPDATE OF current ON image_products WHEN new.current!=old.current BEGIN
  INSERT INTO changes(id,operation,changed_at) VALUES(new.capture_id,'supersede',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
 END;`);
}
/** Persisted attachment intents are replayable; a stopped/missing OCR plugin has
 * no effect on attachment admission or the parent retention policy. */
export class ImageAttachmentIntake {
 private active?:Promise<void>;private closed=false;private attachments:FileAttachments;
 constructor(private store:Store,files:FileStore){this.attachments=new FileAttachments(files);}
 prepare(){if(!this.active&&!this.closed)this.active=this.drain().finally(()=>{this.active=undefined;});return this.active??Promise.resolve();}
 private async drain(){
  for(const row of this.store.db.prepare("SELECT parent_id,file_id FROM image_attachment_intents WHERE state='waiting' AND available_at<=? LIMIT 100").all(Date.now())){
   if(this.closed)return;
   const parent=String(row.parent_id),file=String(row.file_id);
   try{const override=this.store.db.prepare('SELECT profile_id FROM image_intake_overrides WHERE capture_id=?').get(parent),declared=this.store.evidence([parent])[0]?.provenance?.document?.attachments?.find(a=>a.id===file)?.mimeType;await this.attachments.prepare(parent,file,{...(override?{processingProfileId:String(override.profile_id)}:{}),...(declared?.startsWith('image/')?{mimeType:declared}:{})},()=>{});if(this.closed)return;this.store.db.prepare("UPDATE image_attachment_intents SET state='succeeded',error=NULL WHERE parent_id=? AND file_id=?").run(parent,file);}
   catch{if(this.closed)return;this.store.db.prepare("UPDATE image_attachment_intents SET error='attachment_unavailable',available_at=? WHERE parent_id=? AND file_id=?").run(Date.now()+60000,parent,file);}
  }
 }
 async close(){this.closed=true;await this.active;}
}
declare module '@deepseek-ai/cordis' {interface Context {moteImageInputs:ImageInputRegistry;}}
