import {FILE_PART_BYTES} from '@mote/shared';
import {INGRESS_VERSION_HEADERS,requireIngressReceipt} from '@mote/shared/collector-receipt';
import {uploadFilePart,uploadHash,type PartReceipt} from './upload-part';
import type {Api} from './api';
/** Attachment transport ends at durable receipt; ordinary central processors own OCR/ASR. */
async function uploadAttachment(api:Api,file:File,deviceId:string,sourcePrefix:string,sourceName:string,signal?:AbortSignal):Promise<string>{
  const request=async<T>(path:string,init:RequestInit)=>{signal?.throwIfAborted();const result=await api.request<T>(path,{...init,headers:{...INGRESS_VERSION_HEADERS,...init.headers},signal});signal?.throwIfAborted();return result;};
  const sourceId=sourcePrefix+deviceId.replace(/[^a-zA-Z0-9_.:-]/g,'').slice(0,100);
  const source=await request<{id:string}>('/api/sources',{method:'POST',body:JSON.stringify({id:sourceId,name:sourceName,kind:'upload',deviceId,platform:'import',retention:'archive',enabled:true})});
  if(source.id!==sourceId)throw Error('Attachment source acknowledgement does not match');
  const sha256=await uploadHash(await file.arrayBuffer());signal?.throwIfAborted();
  const identity=await uploadHash(new TextEncoder().encode(JSON.stringify([sha256,file.name,file.lastModified])).buffer as ArrayBuffer);
  const manifest={sourceId,item:{externalId:'attachment:'+identity,revision:sha256,observedAt:new Date(file.lastModified).toISOString(),title:file.name,kind:'file',layer:'original',text:'',mimeType:file.type},sha256,sizeBytes:file.size};
  const validate=(value:unknown)=>{
    const receipt=requireIngressReceipt(value,{kind:'file-revision',sourceId,externalId:manifest.item.externalId,revision:sha256});
    const ack=value as {captureId?:unknown;sha256?:unknown;sizeBytes?:unknown};
    if(ack.captureId!==receipt.id||ack.sha256!==sha256||ack.sizeBytes!==file.size)throw Error('Attachment archive acknowledgement does not match');
    return receipt.id;
  };
  const upload=await request<{uploadId:string;ack?:unknown;partBytes:number;parts:PartReceipt[]}>('/api/file-sync/v1/uploads',{method:'POST',body:JSON.stringify(manifest)});
  if(upload.ack)return validate(upload.ack);
  if(typeof upload.uploadId!=='string'||!upload.uploadId||upload.partBytes!==FILE_PART_BYTES||!Array.isArray(upload.parts))throw Error('Invalid attachment upload acknowledgement');
  for(let part=0;part*FILE_PART_BYTES<file.size;part++){
    await uploadFilePart(file,part,FILE_PART_BYTES,upload.parts.find(p=>p.part===part),body=>request(`/api/file-sync/v1/uploads/${encodeURIComponent(upload.uploadId)}/parts/${part}`,{method:'PUT',headers:{'Content-Type':'application/octet-stream'},body}),signal);
  }
  return validate(await request(`/api/file-sync/v1/uploads/${encodeURIComponent(upload.uploadId)}/commit`,{method:'POST'}));
}
export async function uploadNoteAttachment(api:Api,file:File,deviceId:string,signal?:AbortSignal):Promise<string>{
  if(!/^(image|audio)\//.test(file.type)||file.size>50*1024*1024||file.size===0)throw Error('Image/audio attachment must be at most 50 MiB');
  return uploadAttachment(api,file,deviceId,'notes-','Note attachments',signal);
}
export async function uploadChatImage(api:Api,file:File,deviceId:string,signal?:AbortSignal):Promise<string>{
  if(!['image/png','image/jpeg','image/webp'].includes(file.type)||file.size>8*1024*1024||file.size===0)throw Error('Chat image must be PNG, JPEG or WebP and at most 8 MiB');
  return uploadAttachment(api,file,deviceId,'chat-','Chat images',signal);
}
