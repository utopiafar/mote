import {join} from 'node:path';
import {writeFileSync,rmSync} from 'node:fs';
import type {Store} from '../../src/store.js';
/** Generate authentic previous-format storage without reading any personal content. */
export function legacyAsset(store:Store,hash:string,format:'image-legacy'|'archive-legacy',unsuffixed=false){
 const bytes=store.assets.read(hash);
 if(format==='image-legacy'){
  const sealed=store.contentEncryption.seal(bytes),raw=Buffer.concat([Buffer.from('MOTE1'),sealed.subarray(0,12),sealed.subarray(-16),sealed.subarray(12,-16)]);
  writeFileSync(join(store.blobsDir,hash),raw,{mode:0o600});
 }else{
  const path=join(store.directory,'files',hash);
  if(unsuffixed)writeFileSync(path,store.contentEncryption.seal(bytes),{mode:0o600});else store.contentEncryption.write(path,bytes);
 }
 store.db.prepare('UPDATE assets SET format=?,parts=0 WHERE hash=?').run(format,hash);
 rmSync(join(store.assets.directory,hash),{force:true,recursive:true});
}
