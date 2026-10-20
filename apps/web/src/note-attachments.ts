import {FILE_PART_BYTES} from '@mote/shared';
import {INGRESS_VERSION_HEADERS,requireIngressReceipt} from '@mote/shared/collector-receipt';
import {uploadFilePart,uploadHash,type PartReceipt} from './upload-part';
import type {Api} from './api';
import {isWebConnection} from './api';
import type {FileRevision} from '@mote/shared';
import {sourceItemCaptureId,requireWebSourceItemReceipt,type WebSourceItemReceipt} from './web-source-receipt';
/** Version-3 transport preserves the existing upload/chunk algorithm, while
 * checking every acknowledgement against the immutable Web account. */
async function uploadWebAttachment(api:Api,file:File,deviceId:string,sourcePrefix:string,sourceName:string,signal?:AbortSignal):Promise<string>{
 const owner=api.connection;if(!owner||!isWebConnection(owner))throw Error('Missing Web attachment owner');
 const request=async<T>(path:string,init:RequestInit)=>{signal?.throwIfAborted();const value=await api.request<T>(path,{...init,signal});signal?.throwIfAborted();return value;};
 const sourceId=sourcePrefix+deviceId.replace(/[^a-zA-Z0-9_.:-]/g,'').slice(0,100);
 await request('/api/ingress/devices',{method:'POST',body:JSON.stringify({id:deviceId,name:sourceName,platform:'import'})});
 await request('/api/ingress/sources',{method:'POST',body:JSON.stringify({id:sourceId,name:sourceName,kind:'upload',deviceId,platform:'import',retention:'archive'})});
 const sha256=await uploadHash(await file.arrayBuffer());signal?.throwIfAborted();
 const batchId=await uploadHash(new TextEncoder().encode(JSON.stringify([sha256,file.name,file.lastModified])).buffer as ArrayBuffer);
 const revision:FileRevision={sourceId,previousRevision:null,relativePath:'',item:{externalId:'attachment:'+batchId,revision:sha256,observedAt:new Date(file.lastModified).toISOString(),title:file.name,kind:'file',layer:'original',text:'',mimeType:file.type,deleted:false},sha256,sizeBytes:file.size};
 type Receipt=WebSourceItemReceipt;
 const captureId=await sourceItemCaptureId(sourceId,revision.item.externalId,revision.item.revision);
 const originalRef='original:'+await uploadHash(new TextEncoder().encode(JSON.stringify([owner.userId,sourceId,captureId,sha256,file.type,'archive'])).buffer as ArrayBuffer);
 const owned=(value:{deploymentId:string;userId:string;sourceId:string})=>{if(value.deploymentId!==owner.deploymentId||value.userId!==owner.userId||value.sourceId!==sourceId)throw Error('Attachment owner acknowledgement does not match');};
 const validate=(value:Receipt)=>{const item=requireWebSourceItemReceipt(value,{...owner,sourceId,batchId,captureId,externalId:revision.item.externalId,revision:revision.item.revision},'Attachment archive'),original=item.original;if(!original||original.ref!==originalRef||original.sourceId!==sourceId||original.captureId!==captureId||original.hash!==sha256||original.bytes!==file.size||original.mime!==file.type||original.retention!=='archive')throw Error('Attachment archive acknowledgement does not match');return item.id;};
 const upload=await request<{id:string;deploymentId:string;userId:string;sourceId:string;partBytes:number;parts:{part:number;checksum:string;bytes:number}[];receipt?:Receipt}>('/api/ingress/sources/'+encodeURIComponent(sourceId)+'/uploads',{method:'POST',body:JSON.stringify({batchId,revision})});
 owned(upload);if(upload.receipt)return validate(upload.receipt);
 if(!upload.id||upload.partBytes!==FILE_PART_BYTES||!Array.isArray(upload.parts))throw Error('Invalid attachment upload acknowledgement');
 for(let part=0;part*FILE_PART_BYTES<file.size;part++){
  const prior=upload.parts.find(value=>value.part===part);
  await uploadFilePart(file,part,FILE_PART_BYTES,prior?{...prior,hash:prior.checksum}:undefined,async (body,checksum)=>{
   const bytes=new Uint8Array(body);let binary='';for(let offset=0;offset<bytes.length;offset+=32768)binary+=String.fromCharCode(...bytes.subarray(offset,offset+32768));
   signal?.throwIfAborted();
   const ack=await request<{part:number;checksum:string;bytes:number}>('/api/ingress/uploads/'+encodeURIComponent(upload.id)+'/parts/'+part,{method:'PUT',body:JSON.stringify({bytes:btoa(binary),checksum})});return {...ack,hash:ack.checksum};
  },signal);
 }
 return validate(await request<Receipt>('/api/ingress/uploads/'+encodeURIComponent(upload.id)+'/commit',{method:'POST',body:'{}'}));
}
/** Attachment transport ends at durable receipt; ordinary central processors own OCR/ASR. */
async function uploadAttachment(api:Api,file:File,deviceId:string,sourcePrefix:string,sourceName:string,signal?:AbortSignal):Promise<string>{
  if(api.connection&&isWebConnection(api.connection))return uploadWebAttachment(api,file,deviceId,sourcePrefix,sourceName,signal);
  const request=async<T>(path:string,init:RequestInit)=>{signal?.throwIfAborted();const result=await api.request<T>(path,{...init,headers:{...INGRESS_VERSION_HEADERS,...init.headers},signal});signal?.throwIfAborted();return result;};
  const sourceId=sourcePrefix+deviceId.replace(/[^a-zA-Z0-9_.:-]/g,'').slice(0,100);
  const source=await request<{id:string}>('/api/sources',{method:'POST',body:JSON.stringify({id:sourceId,name:sourceName,kind:'upload',deviceId,platform:'import',retention:'archive',enabled:true})});
  if(source.id!==sourceId)throw Error('Attachment source acknowledgement does not match');
  const sha256=await uploadHash(await file.arrayBuffer());signal?.throwIfAborted();
  const identity=await uploadHash(new TextEncoder().encode(JSON.stringify([sha256,file.name,file.lastModified])).buffer as ArrayBuffer);
  const manifest={sourceId,item:{externalId:'attachment:'+identity,revision:sha256,observedAt:new Date(file.lastModified).toISOString(),title:file.name,kind:'file',layer:'original',text:'',mimeType:file.type,deleted:false},sha256,sizeBytes:file.size};
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
