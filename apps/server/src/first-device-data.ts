import {formatEvidenceRef,type CaptureRecord} from '@mote/shared';
import type {Store} from './store.js';
import type {FileStore} from './files.js';
import type {EvidenceReader} from './evidence-reader.js';

const DEVICE_LIMIT=8,RECORD_LIMIT=4;
type Candidate={id:string;deviceId:string;deviceName:string;source:string;capturedAt:string;receivedAt:string};
/** A bounded, rebuildable owner view over existing ingress and original identities.
 * It does not attest checksum verification, model readiness or tutorial completion. */
export function firstDeviceData(store:Store,files:FileStore,reader:EvidenceReader){
 const devices=store.db.prepare(`SELECT id,json FROM devices
  WHERE json_extract(json,'$.platform') IN ('android','macos')
  ORDER BY json_extract(json,'$.lastSeenAt') DESC,id DESC LIMIT ?`).all(DEVICE_LIMIT+1);
 let checkedRecords=0,received:Candidate|undefined,windowLimited=devices.length>DEVICE_LIMIT;
 const fileAvailable=(id:string)=>{
  if(!reader.evidence([formatEvidenceRef('capture',id)]).length)return false;
  const version=files.version(id);
  if(!version.object_hash)return false;
  const manifest=JSON.parse(version.manifest) as {sizeBytes:number};
  return store.assets.get(version.object_hash).bytes===manifest.sizeBytes&&store.assets.retained(version.object_hash);
 };
 const retained=(record:CaptureRecord)=>{
  const file=store.db.prepare('SELECT 1 FROM file_versions WHERE capture_id=?').get(record.id);
  if(file)return fileAvailable(record.id);
  if(record.source==='screen'||record.blobHash){
   const image=reader.imageReference(formatEvidenceRef('capture',record.id));
   return Boolean(image&&record.blobHash&&store.assets.retained(record.blobHash));
  }
  const attachments=record.metadata?.attachments??[];
  if(attachments.some(id=>!fileAvailable(id)))return false;
  return Boolean(record.ocrText.trim()||record.metadata?.noteOrigin?.text?.trim()||attachments.length);
 };
 for(const device of devices.slice(0,DEVICE_LIMIT)){
  // Exclude observations without originals before limiting the candidate page,
  // so frequent media or activity records cannot hide an older original.
  const rows=store.db.prepare(`SELECT id,received_at,json_extract(json,'$.platform') platform,
   json_extract(json,'$.source') source,json_extract(json,'$.privacy.collection') collection,
   json_extract(json,'$.appId') app_id FROM captures WHERE device_id=?
   AND COALESCE(json_extract(json,'$.source'),'') NOT IN ('activity','media')
   AND COALESCE(json_extract(json,'$.privacy.collection'),'')!='activity'
   ORDER BY captured_at DESC,id DESC LIMIT ?`).all(device.id,RECORD_LIMIT+1);
  windowLimited ||= rows.length>RECORD_LIMIT;
  for(const row of rows.slice(0,RECORD_LIMIT)){
   checkedRecords++;
   if(!['android','macos'].includes(String(row.platform))||row.source==='activity'||row.collection==='activity'||row.app_id==='dev.mote.web.notes')continue;
   const record=reader.archivedEvidence([formatEvidenceRef('capture',String(row.id))])[0];
   if(!record||record.deviceId!==device.id)continue;
   const candidate:Candidate={id:record.id,deviceId:record.deviceId,deviceName:record.deviceName,source:record.source,capturedAt:record.capturedAt,receivedAt:String(row.received_at)};
   received??=candidate;
   try{if(retained(record))return {state:'ready' as const,originalAvailable:true,candidate,checkedAt:new Date().toISOString(),checkedDevices:Math.min(devices.length,DEVICE_LIMIT),checkedRecords,windowLimited};}
   catch{/* Missing/invalid retained input is a limited state, never success. */}
  }
 }
 return {state:received?'received_unavailable' as const:devices.length?'unverified' as const:'waiting' as const,originalAvailable:false,...(received?{candidate:received}:{}),checkedAt:new Date().toISOString(),checkedDevices:Math.min(devices.length,DEVICE_LIMIT),checkedRecords,windowLimited};
}
