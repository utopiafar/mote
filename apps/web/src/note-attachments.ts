import {FILE_PART_BYTES} from '@mote/shared';
import type {Api} from './api';
/** The ordinary file pipeline performs OCR/transcription; no duplicate processor. */
async function uploadAttachment(api:Api,file:File,deviceId:string,sourcePrefix:string,sourceName:string):Promise<string>{
  const sourceId=sourcePrefix+deviceId.replace(/[^a-zA-Z0-9_.:-]/g,'').slice(0,100);
  await api.request('/api/sources',{method:'POST',body:JSON.stringify({id:sourceId,name:sourceName,kind:'upload',deviceId,platform:'import',retention:'archive',enabled:true})});
  const bytes=await file.arrayBuffer(),sha256=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),v=>v.toString(16).padStart(2,'0')).join('');
  const identity=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([sha256,file.name,file.lastModified])))),v=>v.toString(16).padStart(2,'0')).join('');
  const manifest={sourceId,item:{externalId:'attachment:'+identity,revision:sha256,observedAt:new Date(file.lastModified||Date.now()).toISOString(),title:file.name,kind:'file',layer:'original',text:'',mimeType:file.type},sha256,sizeBytes:file.size};
  const upload=await api.request<{uploadId:string;ack?:{captureId:string};parts:{part:number}[]}>('/api/file-sync/v1/uploads',{method:'POST',body:JSON.stringify(manifest)});
  if(upload.ack)return upload.ack.captureId;
  for(let start=0,part=0;start<bytes.byteLength;start+=FILE_PART_BYTES,part++){
    if(upload.parts.some(p=>p.part===part))continue;
    await api.raw(`/api/file-sync/v1/uploads/${upload.uploadId}/parts/${part}`,{method:'PUT',headers:{'Content-Type':'application/octet-stream'},body:bytes.slice(start,start+FILE_PART_BYTES)});
  }
  const ack=await api.request<{captureId:string}>(`/api/file-sync/v1/uploads/${upload.uploadId}/commit`,{method:'POST'});
  return ack.captureId;
}

export async function uploadNoteAttachment(api:Api,file:File,deviceId:string):Promise<string>{
  if(!/^(image|audio)\//.test(file.type)||file.size>50*1024*1024)throw Error('Image/audio attachment must be at most 50 MiB');
  return uploadAttachment(api,file,deviceId,'notes-','Note attachments');
}

export async function uploadChatImage(api:Api,file:File,deviceId:string):Promise<string>{
  if(!['image/png','image/jpeg','image/webp'].includes(file.type)||file.size>8*1024*1024||file.size===0)throw Error('Chat image must be PNG, JPEG or WebP and at most 8 MiB');
  return uploadAttachment(api,file,deviceId,'chat-','Chat images');
}
