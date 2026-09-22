import {createHash} from 'node:crypto';
import {closeSync,constants,fsyncSync,openSync,readSync,statSync,writeSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {crc32} from 'node:zlib';
import {Unzip,UnzipInflate,strFromU8} from 'fflate';
import {sourceItemSchema,type ArchivedFile} from '@mote/shared';
import {archiveRelativePath} from './archived-files.js';
import {privateDirectory,privateFile} from './private-storage.js';
import type {FormatTask} from './format-work.js';

const fail=(code:string):never=>{throw Error(code);};
function* bytes(path:string){privateFile(path);const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW),buffer=Buffer.alloc(65536);try{let size:number;while((size=readSync(fd,buffer,0,buffer.length,null))>0)yield buffer.subarray(0,size);}finally{closeSync(fd);}}
function* textParts(path:string,limit:number){const decoder=new TextDecoder('utf-8',{fatal:true});let pending='',offset=0,emitted=false;
 for(const chunk of bytes(path)){pending+=decoder.decode(chunk,{stream:true});while(pending.length>limit){let end=limit;if(pending.charCodeAt(end-1)>=0xd800&&pending.charCodeAt(end-1)<=0xdbff)end--;const text=pending.slice(0,end);yield {text,offset};emitted=true;offset+=text.length;pending=pending.slice(end);}}
 pending+=decoder.decode();if(pending.length||!emitted)yield {text:pending,offset};
}
function inspect(file:ArchivedFile,path:string){const hash=createHash('sha256');let total=0;for(const part of bytes(path)){hash.update(part);total+=part.length;}if(total!==file.sizeBytes||hash.digest('hex')!==file.hash)fail('original_changed');let characters=0;for(const part of textParts(path,24000))characters+=part.text.length;return characters;}
function plain(task:Extract<FormatTask,{kind:'plain'}>){
 privateFile(task.manifest,true);const fd=openSync(task.manifest,constants.O_WRONLY|constants.O_TRUNC|constants.O_NOFOLLOW),digest=createHash('sha256');let count=0,size=0;const samples:{title:string;text:string;kind:string;attachmentCount:number}[]=[];
 try{for(const input of task.inputs){const file=input.file,totalCharacters=inspect(file,input.path);
   let part=0;for(const {text,offset} of textParts(input.path,24000)){
    const item=sourceItemSchema.parse({externalId:file.relativePath+':'+part++,revision:createHash('sha256').update(JSON.stringify([file.hash,'utf8-v2'])).digest('hex'),observedAt:task.createdAt,title:file.name,text,kind:'file',layer:'original',mimeType:file.mimeType,document:{fileId:file.id,path:file.relativePath,contentRole:'other',timeBasis:'unknown',originalMetadata:{decoder:'utf8-v2',offset,length:text.length,totalCharacters}}});
    const line=Buffer.from(JSON.stringify({item,evidencePaths:[input.path],attachments:[]})+'\n');size+=line.length;if(++count>10000||size>32*1024*1024)fail('decoded_limit');writeSync(fd,line);digest.update(line);if(samples.length<12)samples.push({title:item.title,text:item.text.slice(0,1800),kind:'file',attachmentCount:0});
   }
   // Detect an edit between the inspection and decoding passes before publication.
   inspect(file,input.path);
  }fsyncSync(fd);return {count,samples,hash:digest.digest('hex')};
 }finally{closeSync(fd);}
}
function zip(task:Extract<FormatTask,{kind:'zip'}>){
 privateFile(task.path);const fd=openSync(task.path,constants.O_RDONLY|constants.O_NOFOLLOW),size=statSync(task.path).size;
 const metadata=new Map<string,{size:number;crc:number}>();
 try{
  const tail=Buffer.alloc(Math.min(size,65557));readSync(fd,tail,0,tail.length,size-tail.length);let end=-1;
  for(let i=tail.length-22;i>=0;i--)if(tail.readUInt32LE(i)===0x06054b50&&i+22+tail.readUInt16LE(i+20)===tail.length){end=i;break;}
  if(end<0)fail('zip_incomplete');const count=tail.readUInt16LE(end+10),length=tail.readUInt32LE(end+12),offset=tail.readUInt32LE(end+16);
  if(tail.readUInt32LE(end+4)!==0||tail.readUInt16LE(end+8)!==count||count>task.maxFiles||length>8*1024*1024||offset+length>size-tail.length+end)fail('zip_limits');
  const directory=Buffer.alloc(length);if(readSync(fd,directory,0,length,offset)!==length)fail('zip_incomplete');let cursor=0,total=0;const seen=new Set<string>();
  for(let i=0;i<count;i++){
   if(cursor+46>length||directory.readUInt32LE(cursor)!==0x02014b50)fail('zip_directory');
   const nameSize=directory.readUInt16LE(cursor+28),extra=directory.readUInt16LE(cursor+30),comment=directory.readUInt16LE(cursor+32),next=cursor+46+nameSize+extra+comment;if(next>length)fail('zip_directory');
   const name=strFromU8(directory.subarray(cursor+46,cursor+46+nameSize),!(directory.readUInt16LE(cursor+8)&2048)),path=archiveRelativePath(name.endsWith('/')?name.slice(0,-1):name);
   if(seen.has(path))fail('zip_duplicate');seen.add(path);const originalSize=directory.readUInt32LE(cursor+24);total+=originalSize;
   if(originalSize>64*1024*1024||total>task.maxBytes)fail('zip_limits');metadata.set(name,{size:originalSize,crc:directory.readUInt32LE(cursor+16)});cursor=next;
  }
 }finally{closeSync(fd);}
 privateDirectory(task.output);const outputs:{name:string;path:string;bytes:number}[]=[],openFiles=new Set<number>(),started=new Set<string>();let total=0,finished=0;
 const unzip=new Unzip(file=>{
  const expected=metadata.get(file.name)??fail('zip_directory');if(started.has(file.name))fail('zip_directory');started.add(file.name);
  if(file.name.endsWith('/')){finished++;return;}
  const path=join(task.output,archiveRelativePath(file.name));privateDirectory(dirname(path));const out=openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);openFiles.add(out);let length=0,crc=0;
  file.ondata=(error,data,final)=>{if(error)throw error;length+=data.length;total+=data.length;if(length>expected.size||total>task.maxBytes)fail('zip_limits');crc=crc32(data,crc);writeSync(out,data);if(final){if(length!==expected.size||crc!==expected.crc)fail('zip_checksum');fsyncSync(out);closeSync(out);openFiles.delete(out);outputs.push({name:file.name,path,bytes:length});finished++;}};file.start();
 });unzip.register(UnzipInflate);
 try{for(const part of bytes(task.path))unzip.push(part,false);unzip.push(new Uint8Array(),true);if(finished!==metadata.size)fail('zip_incomplete');return {files:outputs,bytes:total};}finally{for(const fd of openFiles)closeSync(fd);}
}
function text(task:Extract<FormatTask,{kind:'text'}>){if(statSync(task.path).size>task.maxBytes)fail('decoded_limit');return {durationMs:0,segments:[...textParts(task.path,task.chunkCharacters)].filter(part=>part.text.length).map(part=>({startMs:0,endMs:0,text:part.text}))};}
process.once('message',(task:FormatTask)=>{try{const result=task.kind==='zip'?zip(task):task.kind==='plain'?plain(task):text(task);process.send?.({ok:true,result},()=>process.exit(0));}catch(error){const code=error instanceof Error&&/^[a-z_]+$/.test(error.message)?error.message:'decode_failed';process.send?.({ok:false,code},()=>process.exit(1));}});
process.on('disconnect',()=>process.exit(1));
