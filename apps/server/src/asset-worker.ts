import {createHash,createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import {existsSync,readFileSync,openSync,closeSync,fsyncSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {privateDirectory,privateFile} from './private-storage.js';
import {replaceContentFile} from './content-encryption.js';
import type {AssetPreparation,PreparedAsset} from './asset-work.js';
import {readAssetParts,writeAssetPart,assetPartLine} from './asset-part-metadata.js';
const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
function prepare(task:AssetPreparation):PreparedAsset{
 const key=task.encryption.key?Buffer.from(task.encryption.key,'hex'):undefined;
 const read=(path:string)=>{const selected=existsSync(path+'.plain')?{path:path+'.plain',encrypted:false}:{path:path+'.aes',encrypted:true};privateFile(selected.path);if(statSync(selected.path).size>task.partBytes+(selected.encrypted?28:0))throw Error('invalid_part');const bytes=readFileSync(selected.path);if(!selected.encrypted)return bytes;if(!key||bytes.length<28)throw Error('missing_key');const decipher=createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));decipher.setAuthTag(bytes.subarray(-16));return Buffer.concat([decipher.update(bytes.subarray(12,-16)),decipher.final()]);};
 const write=(path:string,bytes:Buffer)=>{if(!task.encryption.enabled){replaceContentFile(path+'.plain',bytes);return;}if(!key)throw Error('missing_key');const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);replaceContentFile(path+'.aes',Buffer.concat([iv,cipher.update(bytes),cipher.final(),cipher.getAuthTag()]));};
 privateDirectory(task.directory);privateDirectory(task.staging);const digest=createHash('sha256'),metadata=createHash('sha256');let total=0,count=0;
 const metadataPath=join(task.staging,'verified-parts'),output=openSync(metadataPath,'wx',0o600);
 try{for(const part of readAssetParts(join(task.staging,'input-parts'))){
  const index=count++;if(part.bytes!==Math.min(task.partBytes,task.bytes-index*task.partBytes))throw Error('invalid_part');
  const bytes=read(join(task.directory,String(index))),checksum=hash(bytes);if(bytes.length!==part.bytes||checksum!==part.hash)throw Error('invalid_part');
  total+=bytes.length;digest.update(bytes);writeAssetPart(output,part);metadata.update(assetPartLine(part));write(join(task.staging,String(index)),bytes);
 }fsyncSync(output);}finally{closeSync(output);}
 if(count!==Math.ceil(task.bytes/task.partBytes))throw Error('invalid_part');
 const actualHash=digest.digest('hex');if(total!==task.bytes||task.hash&&actualHash!==task.hash)throw Error('invalid_hash');
 const destinationPath=join(task.destinationRoot,actualHash);
 const fd=openSync(task.staging,'r');try{fsyncSync(fd);}finally{closeSync(fd);}
 let destination:PreparedAsset['destination'];
 if(existsSync(destinationPath)){
  privateDirectory(destinationPath);const before=statSync(destinationPath),existing=createHash('sha256');let size=0;
  for(const part of readAssetParts(metadataPath)){const bytes=read(join(destinationPath,String(part.part)));if(bytes.length!==part.bytes||hash(bytes)!==part.hash)throw Error('invalid_existing');size+=bytes.length;existing.update(bytes);}
  const after=statSync(destinationPath);if(before.dev!==after.dev||before.ino!==after.ino||before.mtimeMs!==after.mtimeMs)throw Error('asset_changed');
  if(size!==task.bytes||existing.digest('hex')!==actualHash)throw Error('invalid_existing');destination={dev:after.dev,ino:after.ino,mtimeMs:after.mtimeMs};
 }
 return {hash:actualHash,parts:count,metadataHash:metadata.digest('hex'),destination};
}
process.once('message',(task:AssetPreparation)=>{try{process.send?.({ok:true,result:prepare(task)},()=>process.exit(0));}catch(error){process.send?.({ok:false,code:(error as NodeJS.ErrnoException).code??(error instanceof Error?error.message:'asset_failed')},()=>process.exit(1));}});
process.on('disconnect',()=>process.exit(1));
