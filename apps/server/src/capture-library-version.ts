import {createHash} from 'node:crypto';
import type {Store} from './store.js';

/** Original facts only: derived OCR and local presentation never identify an original version. */
export function captureLibraryVersion(original:Record<string,any>,blobHash:string|null=null):string {
  const fields=['id','deviceId','deviceName','platform','capturedAt','durationMs','appId','appName','windowTitle','ocrText','source','stateSeries','ocr','mood','provenance','metadata','privacy'];
  const value:Record<string,any>={};for(const key of fields)if(original[key]!==undefined)value[key]=structuredClone(original[key]);
  for(const key of ['appId','appName','windowTitle','ocrText'])value[key]??='';value.source??='screen';
  value.privacy={excluded:false,redacted:false,mode:'local',...value.privacy};
  if(value.provenance)value.provenance.deleted??=false;
  value.capturedAt=new Date(value.capturedAt).toISOString();
  for(const sample of value.stateSeries?.samples??[])sample.at=new Date(sample.at).toISOString();
  if(value.metadata?.uiPage?.version===3){value.metadata.observedAt=new Date(value.metadata.observedAt).toISOString();value.metadata.uiPage.observations.firstAt=new Date(value.metadata.uiPage.observations.firstAt).toISOString();value.metadata.uiPage.observations.lastAt=value.capturedAt;}
  value.blobHash=blobHash;
  const canonical=(entry:any):string=>Array.isArray(entry)?'['+entry.map(canonical).join(',')+']':entry&&typeof entry==='object'?'{'+Object.keys(entry).sort().map(key=>JSON.stringify(key)+':'+canonical(entry[key])).join(',')+'}':JSON.stringify(entry);
  return createHash('sha256').update(canonical(value)).digest('hex');
}
export function storedCaptureLibraryVersion(store:Store,id:string):string|undefined {
  const row=store.db.prepare('SELECT json,blob_hash FROM captures WHERE id=?').get(id);
  return row?captureLibraryVersion(JSON.parse(String(row.json)),row.blob_hash===null?null:String(row.blob_hash)):undefined;
}
