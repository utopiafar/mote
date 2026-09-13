import {constants} from 'node:fs';
import {mkdir,lstat,chmod,open,rename,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {ConnectorError} from './types.js';

/** Credentials remain outside capture/source JSON, in a single owned private directory. */
export class PrivateFile<T> {
  private writes: Promise<void>=Promise.resolve();
  constructor(readonly directory:string,readonly name:string){}
  private async init() {
    await mkdir(this.directory,{recursive:true,mode:0o700});
    const info=await lstat(this.directory);
    if(!info.isDirectory()||info.isSymbolicLink()||(process.getuid&&info.uid!==process.getuid()))throw new ConnectorError('credential_directory_invalid',503);
    await chmod(this.directory,0o700);
  }
  async read():Promise<T|undefined> {
    await this.init();let fd;
    try {
      fd=await open(join(this.directory,this.name),constants.O_RDONLY|constants.O_NOFOLLOW);
      const info=await fd.stat();
      if(!info.isFile()||(info.mode&0o077)!==0||info.size>2*1024*1024||(process.getuid&&info.uid!==process.getuid()))throw new Error();
      return JSON.parse(await fd.readFile('utf8')) as T;
    }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw new ConnectorError('credential_file_invalid',503);}
    finally{await fd?.close();}
  }
  write(value:T):Promise<void> {
    const json=JSON.stringify(value);
    const run=this.writes.catch(()=>{}).then(async()=>{
      await this.init();const temp=join(this.directory,`.${this.name}.${randomUUID()}.tmp`);
      try{const fd=await open(temp,'wx',0o600);try{await fd.writeFile(json);await fd.sync();}finally{await fd.close();}await rename(temp,join(this.directory,this.name));}
      finally{await rm(temp,{force:true});}
    });this.writes=run;return run;
  }
  async clear(){await this.writes.catch(()=>{});await rm(join(this.directory,this.name),{force:true});}
  async flush(){await this.writes;}
}
