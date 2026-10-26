import type {ActionGrant,CaptureRecord} from '@mote/shared';
import {sha256,type Store} from './store.js';
import type {SourceStore} from './sources.js';

type Identity=ActionGrant['inputs']['sources'][number];
/** Structural transport identity, never intent classification or fuzzy source matching. */
export class ActionInputScope {
 constructor(private store:Store,private sources:SourceStore){}
 private capture(source:string,deviceId:string,platform:Identity['platform']):Identity{return {sourceId:'capture:'+sha256(JSON.stringify([deviceId,platform,source])),kind:'capture:'+source,deviceId,platform};}
 identity(record:CaptureRecord):Identity{
  if(record.provenance?.sourceId){const source=this.sources.getSource(record.provenance.sourceId);return {sourceId:source.id,kind:source.kind,deviceId:source.deviceId,platform:source.platform};}
  return this.capture(record.source,record.deviceId,record.platform);
 }
 valid(identity:Identity){
  if(identity.kind.startsWith('capture:'))return identity.sourceId===this.capture(identity.kind.slice(8),identity.deviceId,identity.platform).sourceId;
  try{const source=this.sources.getSource(identity.sourceId);return source.kind===identity.kind&&source.deviceId===identity.deviceId&&source.platform===identity.platform;}catch{return false;}
 }
 catalog(){
  const sources=this.sources.listSources().map(source=>({sourceId:source.id,kind:source.kind,deviceId:source.deviceId,platform:source.platform,name:source.name}));
  const raw=this.store.db.prepare("SELECT DISTINCT device_id,json_extract(json,'$.platform') platform,json_extract(json,'$.source') source FROM captures WHERE json_extract(json,'$.provenance.sourceId') IS NULL LIMIT 500").all();
  return [...sources,...raw.map(row=>({...this.capture(String(row.source),String(row.device_id),String(row.platform) as Identity['platform']),name:String(row.source)+' · '+String(row.device_id)}))];
 }
 allows(grant:ActionGrant,record:CaptureRecord){
  if(record.privacy.excluded||record.provenance?.layer==='reference')return false;
  let identity:Identity;try{identity=this.identity(record);}catch{return false;}
  if(!grant.inputs.sources.some(source=>source.sourceId===identity.sourceId&&source.kind===identity.kind&&source.deviceId===identity.deviceId&&source.platform===identity.platform))return false;
  const captureId=(record as CaptureRecord&{fileEvidence?:{captureId:string}}).fileEvidence?.captureId??record.id;
  // The first durable Central intake, including imports, determines the range.
  // OCR/transcript updates cannot turn an old original into a future input.
  const first=this.store.db.prepare("SELECT MIN(seq) seq FROM changes WHERE id=? AND operation='upsert'").get(captureId)?.seq;
  if(first===null||first===undefined)return false;
  return Number(first)<=grant.inputCursor?grant.inputs.existingArchived:grant.inputs.futureInputs;
 }
}
