import {constants} from 'node:fs';
import {open,mkdir,rename,rm,realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {encodeLocalContent,readLocalContent} from './local-content';
export type OriginalSpool={directory:string;sha256:string;sizeBytes:number;partBytes:number};
export type OriginalIdentity={dev:number;ino:number;size:number;mtimeMs:number;ctimeMs:number};
const PART=4*1024*1024;
/** Called in the source worker. Every part is immutable and durable before the queue can reference it. */
export async function spoolOriginal(path:string,directory:string,expected:OriginalIdentity):Promise<OriginalSpool>{
 const matches=(s:OriginalIdentity)=>Object.entries(expected).every(([key,value])=>s[key as keyof OriginalIdentity]===value);
 if(expected.size>512*1024*1024||expected.size<0||await realpath(path)!==path)throw Error('Original outside snapshot bounds');
 await mkdir(directory,{recursive:true,mode:0o700});const id=randomUUID(),staging=join(directory,id+'.tmp'),destination=join(directory,id);await mkdir(staging,{mode:0o700});
 let input;
 try{
  input=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  if(!matches(await input.stat()))throw Error('Original changed before snapshot');
  const digest=createHash('sha256');
  for(let offset=0;offset<expected.size;offset+=PART){
   const bytes=Buffer.alloc(Math.min(PART,expected.size-offset));let read=0;
   while(read<bytes.length){const next=await input.read(bytes,read,bytes.length-read,offset+read);if(!next.bytesRead)throw Error('Original truncated during snapshot');read+=next.bytesRead;}
   digest.update(bytes);const output=await open(join(staging,String(offset/PART)),'wx',0o600);try{await output.writeFile(encodeLocalContent(bytes));await output.sync();}finally{await output.close();}
  }
  if(!matches(await input.stat())||await realpath(path)!==path)throw Error('Original changed during snapshot');
  const handle=await open(staging,'r');try{await handle.sync();}finally{await handle.close();}
  await rename(staging,destination);const parent=await open(directory,'r');try{await parent.sync();}finally{await parent.close();}
  return {directory:destination,sha256:digest.digest('hex'),sizeBytes:expected.size,partBytes:PART};
 }catch(error){await rm(staging,{force:true,recursive:true});throw error;}finally{await input?.close();}
}
export async function originalPart(spool:OriginalSpool,part:number){
 if(!Number.isSafeInteger(part)||part<0||part>=Math.ceil(spool.sizeBytes/PART)||spool.partBytes!==PART)throw Error('Invalid original part');
 const bytes=await readLocalContent(join(spool.directory,String(part)));if(bytes.length!==Math.min(PART,spool.sizeBytes-part*PART))throw Error('Incomplete original snapshot');return bytes;
}
