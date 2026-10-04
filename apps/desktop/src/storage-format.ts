import {mkdir,open,readFile,readdir,lstat,rename,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';

export const DESKTOP_STORAGE_VERSION = 3;
export const RESET_REQUIRED = 'Unsupported desktop storage format. Back up the existing directory, then reset it before starting this version. Existing files were preserved.';
/** Old personal data is never converted, adopted, or silently moved at startup. */
export async function ensureStorageFormat(directory:string,contentNames:readonly string[]):Promise<void>{
  const marker=join(directory,'storage-format.json');
  try{const value=JSON.parse(await readFile(marker,'utf8'));if(value.version!==DESKTOP_STORAGE_VERSION)throw Error(RESET_REQUIRED);return;}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  for(const name of contentNames){
    try{const path=join(directory,name),info=await lstat(path);if(!info.isDirectory()||(await readdir(path)).length)throw Error(RESET_REQUIRED);}
    catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  }
  await mkdir(directory,{recursive:true,mode:0o700});
  const temporary=marker+'.'+randomUUID()+'.tmp';
  try{const file=await open(temporary,'wx',0o600);try{await file.writeFile(JSON.stringify({version:DESKTOP_STORAGE_VERSION}));await file.sync();}finally{await file.close();}
    await rename(temporary,marker);
    if(process.platform!=='win32'){const folder=await open(directory,'r');try{await folder.sync();}finally{await folder.close();}}
  }finally{await unlink(temporary).catch(error=>{if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;});}
}
