import {constants} from 'node:fs';
import {lstat,open,realpath} from 'node:fs/promises';
import {relative,extname,isAbsolute} from 'node:path';
import {fileReadRequestSchema,type FileReadRequest} from '@mote/shared';
import type {LocalSource} from './source-types';
import {redactSourceText} from './source-types';
import {fileDigest,fileMime} from './file-index';
export async function readSourceEvidence(source:LocalSource,raw:FileReadRequest,locations:Map<string,string>,signal?:AbortSignal){
 const request=fileReadRequestSchema.parse(raw);const denied={status:'denied',text:'',contentVersion:request.contentVersion};
 if(!source.enabled||!source.allowRead||source.retention!=='snapshot'||request.sourceId!==source.id)return denied;
 const path=locations.get(request.externalId);if(!path)return {...denied,status:'unavailable'};
 let file;try{
  const root=await realpath(source.path!),info=await lstat(root),rel=relative(root,path);
  if((!info.isDirectory()&&path!==root)||(info.isDirectory()&&(isAbsolute(rel)||rel==='..'||rel.startsWith('../')))||await realpath(path)!==path||!source.extensions.includes(extname(path).toLowerCase())||rel.split('/').some(v=>v.startsWith('.'))||source.excludedPaths.some(v=>rel===v||rel.startsWith(v+'/')))return denied;
  file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);const before=await file.stat();if(!before.isFile()||before.size>16*1024*1024)return {...denied,status:'unavailable'};
  const buffer=Buffer.alloc(before.size+1),{bytesRead}=await file.read(buffer,0,buffer.length,0);if(bytesRead!==before.size)return {...denied,status:'version_changed'};
  const bytes=buffer.subarray(0,bytesRead),digest=fileDigest(bytes);if(digest!==request.contentVersion)return {...denied,status:'version_changed',contentVersion:digest};
  signal?.throwIfAborted();return {...denied,status:'unavailable'}; // Range interpretation now happens centrally.

 }catch{signal?.throwIfAborted();return {...denied,status:'unavailable'};}finally{await file?.close();}
}
