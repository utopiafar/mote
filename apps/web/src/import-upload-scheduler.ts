import {type Api} from './api';
type Upload={id:string;partBytes:number;fileId?:string;parts:{part:number;hash:string;bytes?:number}[]};
const hex=(buffer:ArrayBuffer)=>Array.from(new Uint8Array(buffer),byte=>byte.toString(16).padStart(2,'0')).join('');
/** One part (at most 4 MiB) per file turn. Files keep their own session, offset and hash. */
export async function uploadImportFiles(api:Api,files:readonly File[],identities:WeakMap<File,string>,progress:(bytes:number)=>void,signal?:AbortSignal):Promise<string[]>{
 const request=async<T>(path:string,init:RequestInit)=>{signal?.throwIfAborted();const result=await api.request<T>(path,{...init,signal});signal?.throwIfAborted();return result;};
 const pending=files.map((file,index)=>{let id=identities.get(file);if(!id){id=crypto.randomUUID();identities.set(file,id);}return {file,index,id,offset:0,upload:undefined as Upload|undefined};}),result:string[]=[];
 let accepted=0;progress(0);
 while(pending.length){const job=pending.shift()!,{file,id}=job;
  if(!job.upload){const upload=await request<Upload>('/api/import-uploads',{method:'POST',body:JSON.stringify({id,name:file.webkitRelativePath||file.name,sizeBytes:file.size,mimeType:file.type||undefined})});
   if(upload.id!==id||!Number.isSafeInteger(upload.partBytes)||upload.partBytes<1||upload.partBytes>4*1024*1024||!Array.isArray(upload.parts))throw Error('Invalid import upload acknowledgement');job.upload=upload;
   if(upload.fileId){result[job.index]=upload.fileId;accepted+=file.size;progress(accepted);continue;}
  }
  const upload=job.upload;
  if(job.offset<file.size){const part=job.offset/upload.partBytes,body=await file.slice(job.offset,job.offset+upload.partBytes).arrayBuffer(),hash=hex(await crypto.subtle.digest('SHA-256',body)),existing=upload.parts.find(item=>item.part===part);
   if(!existing||existing.hash!==hash){const ack=await request<{part:number;hash:string;bytes:number}>('/api/import-uploads/'+id+'/parts/'+part,{method:'PUT',headers:{'Content-Type':'application/octet-stream'},body});if(ack.part!==part||ack.hash!==hash||ack.bytes!==body.byteLength)throw Error('Import part acknowledgement does not match the selected file');}
   job.offset+=body.byteLength;accepted+=body.byteLength;progress(accepted);
  }
  if(job.offset<file.size){pending.push(job);continue;}
  const saved=await request<{id:string}>('/api/import-uploads/'+id+'/commit',{method:'POST'});if(typeof saved.id!=='string'||!saved.id)throw Error('Invalid import archive acknowledgement');result[job.index]=saved.id;
 }
 return result;
}
