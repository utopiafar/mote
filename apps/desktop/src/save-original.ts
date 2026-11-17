import {open,rename,rm} from 'node:fs/promises';
import {dirname,join,basename} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';

/** The destination is selected by the native owner dialog, never renderer input. */
export async function saveOriginal(destination:string,input:{bytes:AsyncIterable<Uint8Array>;sizeBytes:number;sha256?:string;close?:()=>void|Promise<void>},authorize:()=>void):Promise<void>{
  const temporary=join(dirname(destination),'.'+basename(destination)+'.'+randomUUID()+'.tmp');let size=0;const hash=createHash('sha256');
  try{authorize();const file=await open(temporary,'wx',0o600);try{for await(const bytes of input.bytes){authorize();size+=bytes.length;hash.update(bytes);if(size>input.sizeBytes)throw Error('Original size changed');await file.writeFile(bytes);authorize();}if(size!==input.sizeBytes)throw Error('Original size changed');if(input.sha256&&hash.digest('hex')!==input.sha256)throw Error('Original checksum changed');await file.sync();}finally{await file.close();}
    authorize();await rename(temporary,destination);if(process.platform!=='win32'){const directory=await open(dirname(destination),'r');try{await directory.sync();}finally{await directory.close();}}
  }finally{try{await input.close?.();}finally{await rm(temporary,{force:true});}}
}
