import {constants} from 'node:fs';
import {lstat,open,realpath} from 'node:fs/promises';
import {basename,isAbsolute,join,relative} from 'node:path';
import type {LocalFileCheckpoint,LocalSource} from './source-types';

/** The product passes identities, never a model-provided path or URI. */
export type LocalFileLocator={sourceId:string;externalId:string;revision:string};
type Selection={source:LocalSource;checkpoint:LocalFileCheckpoint};

/** Open the registered device file for a host consumer. The source registry and
 * Central authorization are checked again before each chunk is disclosed. */
export async function* openRegisteredFile(locator:LocalFileLocator,select:()=>Selection|undefined,authorize:()=>Promise<void>):AsyncGenerator<Buffer>{
  if(!locator.sourceId||!locator.externalId||!locator.revision)throw Error('Invalid file identity');
  const first=select();if(!first||first.source.id!==locator.sourceId||first.source.kind!=='local-files'||!first.source.enabled||!first.source.path)throw Error('File source is unavailable');
  const checkpoint=first.checkpoint,entries=Object.values(checkpoint.catalog).filter(entry=>entry.entryId===locator.externalId);
  if(entries.length!==1||!checkpoint.initialized||checkpoint.identityVerificationPending||checkpoint.degradedReason==='root_unavailable'||checkpoint.degradedReason==='root_changed')throw Error('File location is unavailable');
  const entry=entries[0],root=checkpoint.root;
  if(entry.syncState!=='synced'||entry.identityRoot!==checkpoint.identityScope||!checkpoint.identityScope)throw Error('File location is not current');
  await authorize();
  const [rootStat,selectedStat]=await Promise.all([lstat(root),lstat(first.source.path)]);
  if(rootStat.isSymbolicLink()||selectedStat.isSymbolicLink()||selectedStat.dev!==rootStat.dev||selectedStat.ino!==rootStat.ino||!checkpoint.identityScope.startsWith(`${rootStat.dev}:${rootStat.ino}:`)||await realpath(first.source.path)!==root)throw Error('File root changed');
  const path=rootStat.isFile()&&entry.relativePath===basename(root)?root:join(root,entry.relativePath),rel=relative(root,path);
  if(path!==root&&(rel===''||rel==='..'||rel.startsWith('../')||isAbsolute(rel)))throw Error('File location is outside its source');
  const identity=(info:Awaited<ReturnType<typeof lstat>>)=>info.isFile()&&!info.isSymbolicLink()&&`${info.dev}:${info.ino}`===entry.fileId&&info.birthtimeMs===entry.birthtimeMs&&info.size===entry.size&&info.mtimeMs===entry.mtimeMs&&info.ctimeMs===entry.ctimeMs;
  const input=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{
    const check=async()=>{
      await authorize();
      const current=select(),currentEntries=current?Object.values(current.checkpoint.catalog).filter(value=>value.entryId===locator.externalId):[];
      if(!current||current.source.id!==first.source.id||current.source.path!==first.source.path||!current.source.enabled||current.checkpoint.identityScope!==checkpoint.identityScope||currentEntries.length!==1||JSON.stringify(currentEntries[0])!==JSON.stringify(entry))throw Error('File authorization or version changed');
      const [rootNow,selectedNow,pathNow,handleNow,resolved]=await Promise.all([lstat(root),lstat(first.source.path!),lstat(path),input.stat(),realpath(path)]);
      if(rootNow.isSymbolicLink()||selectedNow.isSymbolicLink()||rootNow.dev!==rootStat.dev||rootNow.ino!==rootStat.ino||selectedNow.dev!==rootStat.dev||selectedNow.ino!==rootStat.ino||resolved!==path||!identity(pathNow)||!identity(handleNow))throw Error('File location changed');
    };
    await check();
    for(let offset=0;offset<entry.size;){
      const bytes=Buffer.alloc(Math.min(65536,entry.size-offset)),result=await input.read(bytes,0,bytes.length,offset);
      if(!result.bytesRead)throw Error('File changed while reading');
      await check();offset+=result.bytesRead;yield bytes.subarray(0,result.bytesRead);
    }
    await check();
  }finally{await input.close();}
}
