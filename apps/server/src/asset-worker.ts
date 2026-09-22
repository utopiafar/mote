import {createHash,createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import {existsSync,readFileSync,openSync,closeSync,fsyncSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {privateDirectory,privateFile} from './private-storage.js';
import {replaceContentFile} from './content-encryption.js';
import type {AssetPreparation,PreparedAsset} from './asset-work.js';
const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
function prepare(task:AssetPreparation):PreparedAsset{
 const key=task.encryption.key?Buffer.from(task.encryption.key,'hex'):undefined;
 const read=(path:string)=>{const selected=existsSync(path+'.plain')?{path:path+'.plain',encrypted:false}:existsSync(path+'.aes')?{path:path+'.aes',encrypted:true}:{path,encrypted:task.encryption.legacyEncrypted};privateFile(selected.path);const bytes=readFileSync(selected.path);if(!selected.encrypted)return bytes;if(!key||bytes.length<28)throw Error('missing_key');const decipher=createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));decipher.setAuthTag(bytes.subarray(-16));return Buffer.concat([decipher.update(bytes.subarray(12,-16)),decipher.final()]);};
 const write=(path:string,bytes:Buffer)=>{if(!task.encryption.enabled){replaceContentFile(path+'.plain',bytes);return;}if(!key)throw Error('missing_key');const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);replaceContentFile(path+'.aes',Buffer.concat([iv,cipher.update(bytes),cipher.final(),cipher.getAuthTag()]));};
 privateDirectory(task.directory);privateDirectory(task.staging);const digest=createHash('sha256'),checksums:string[]=[];let total=0;
 for(const [index,part] of task.parts.entries()){
  if(part.part!==index||part.bytes!==Math.min(task.partBytes,task.bytes-index*task.partBytes))throw Error('invalid_part');
  const bytes=read(join(task.directory,String(index))),checksum=hash(bytes);if(bytes.length!==part.bytes||checksum!==part.hash)throw Error('invalid_part');
  total+=bytes.length;digest.update(bytes);checksums.push(checksum);write(join(task.staging,String(index)),bytes);
 }
 const actualHash=digest.digest('hex');if(total!==task.bytes||task.hash&&actualHash!==task.hash)throw Error('invalid_hash');
 const destinationPath=join(task.destinationRoot,actualHash);
 const fd=openSync(task.staging,'r');try{fsyncSync(fd);}finally{closeSync(fd);}
 let destination:PreparedAsset['destination'];
 if(existsSync(destinationPath)){
  privateDirectory(destinationPath);const before=statSync(destinationPath),existing=createHash('sha256');let size=0;
  for(let index=0;index<task.parts.length;index++){const bytes=read(join(destinationPath,String(index)));if(bytes.length!==task.parts[index].bytes||hash(bytes)!==checksums[index])throw Error('invalid_existing');size+=bytes.length;existing.update(bytes);}
  const after=statSync(destinationPath);if(before.dev!==after.dev||before.ino!==after.ino||before.mtimeMs!==after.mtimeMs)throw Error('asset_changed');
  if(size!==task.bytes||existing.digest('hex')!==actualHash)throw Error('invalid_existing');destination={dev:after.dev,ino:after.ino,mtimeMs:after.mtimeMs};
 }
 return {hash:actualHash,checksums,destination};
}
process.once('message',(task:AssetPreparation)=>{try{process.send?.({ok:true,result:prepare(task)},()=>process.exit(0));}catch(error){process.send?.({ok:false,code:(error as NodeJS.ErrnoException).code??(error instanceof Error?error.message:'asset_failed')},()=>process.exit(1));}});
process.on('disconnect',()=>process.exit(1));
