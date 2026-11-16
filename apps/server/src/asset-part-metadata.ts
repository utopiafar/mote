import {constants,openSync,closeSync,readSync,writeSync,fstatSync} from 'node:fs';
import {FILE_PART_BYTES} from '@mote/shared';
import {privateFile} from './private-storage.js';

export type AssetPart={part:number;hash:string;bytes:number};
/** Rebuildable worker metadata, never an alternative original/storage format. */
export const assetPartLine=(part:AssetPart)=>JSON.stringify({part:part.part,hash:part.hash,bytes:part.bytes})+'\n';
export function writeAssetPart(fd:number,part:AssetPart){const bytes=Buffer.from(assetPartLine(part));let offset=0;while(offset<bytes.length){const written=writeSync(fd,bytes,offset,bytes.length-offset);if(!written)throw Error('Incomplete asset metadata write');offset+=written;}}
export function *readAssetParts(path:string):Generator<AssetPart>{
 privateFile(path);const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW),buffer=Buffer.alloc(64*1024);let pending='',index=0;
 try{
  const info=fstatSync(fd);if(!info.isFile()||info.nlink!==1)throw Error('Invalid asset part metadata');
  while(true){const count=readSync(fd,buffer,0,buffer.length,null);if(!count)break;pending+=buffer.toString('utf8',0,count);
   let end:number;while((end=pending.indexOf('\n'))>=0){
    if(end>512)throw Error('Asset part metadata line is too large');const raw=JSON.parse(pending.slice(0,end));pending=pending.slice(end+1);
    if(!raw||Object.keys(raw).length!==3||!Number.isSafeInteger(raw.part)||raw.part!==index++||typeof raw.hash!=='string'||!/^[a-f0-9]{64}$/.test(raw.hash)||!Number.isSafeInteger(raw.bytes)||raw.bytes<1||raw.bytes>FILE_PART_BYTES)throw Error('Invalid asset part metadata');
    yield {part:raw.part,hash:raw.hash,bytes:raw.bytes};
   }
   if(pending.length>512)throw Error('Asset part metadata line is too large');
  }
  if(pending)throw Error('Incomplete asset part metadata');
 }finally{closeSync(fd);}
}
