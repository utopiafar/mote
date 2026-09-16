import {join} from 'node:path';
import {readdirSync} from 'node:fs';
import {setImmediate} from 'node:timers/promises';
import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {Store,StoreError,sha256} from './store.js';
import type {FileStore} from './files.js';
import type {ArchivedFileStore} from './archived-files.js';
import {privateDirectory,privateFile} from './private-storage.js';

const hashName=/^[a-f0-9]{64}$/;
const uuidName='[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const uploadName=new RegExp('^'+uuidName+'$');
const objectName=new RegExp('^[a-f0-9]{64}(?:\\.'+uuidName+'\\.tmp)?$');

type Progress={state:'idle'|'running'|'completed'|'cancelled';total:number;processed:number;converted:number;skipped:number;failed:number};
/** Fixed managed object paths only. Never walks credentials, arbitrary directories or user paths. */
export class ContentStorageService {
  private progress:Progress={state:'idle',total:0,processed:0,converted:0,skipped:0,failed:0};
  private stopped=false;
  private work?:Promise<void>;
  constructor(private store:Store,private files:FileStore,private archived:ArchivedFileStore){}
  snapshot(){return {enabled:this.store.contentEncryption.enabled,keyConfigured:Boolean(this.store.key),job:{...this.progress}};}
  configure(enabled:boolean){if(this.progress.state==='running')throw new StoreError('批量解密期间请等待完成或取消后再修改加密设置',409);this.store.contentEncryption.setEnabled(enabled);return this.snapshot();}
  start(){
    if(this.progress.state==='running')return this.snapshot();
    if(this.store.contentEncryption.enabled)throw new StoreError('请先关闭内容加密，再批量解密已有文件',409);
    this.stopped=false;this.progress={state:'running',total:0,processed:0,converted:0,skipped:0,failed:0};
    this.work=this.run().catch(()=>{this.progress.failed++;this.progress.state='completed';});
    return this.snapshot();
  }
  cancel(){this.stopped=true;return this.snapshot();}
  async close(){this.stopped=true;await this.work;}
  private async run(){
    await setImmediate();
    const steps=new Map<string,()=>boolean>();
    // Verify every parent again when a step executes; inspecting only the final file
    // would follow a restored/symlinked object directory outside the managed vault.
    const directory=(...paths:string[])=>{privateDirectory(this.store.directory);for(const path of paths)privateDirectory(path);};
    const image=(hash:string)=>{
      if(!hashName.test(hash))throw Error('Invalid managed image');
      const path=join(this.store.blobsDir,hash);
      steps.set(path,()=>{directory(this.store.blobsDir);privateFile(path);return this.store.decryptImage(hash);});
    };
    const original=(hash:string)=>{
      if(!hashName.test(hash))throw Error('Invalid managed original');
      const path=join(this.archived.directory,hash);
      steps.set(path,()=>{directory(this.archived.directory);return this.archived.decrypt(hash);});
    };
    const part=(root:string,id:string,index:number,checksum?:string)=>{
      const parent=join(root,id),path=join(parent,String(index));
      if(steps.has(path))return;
      steps.set(path,()=>{directory(this.archived.directory,root,parent);return this.store.contentEncryption.decrypt(path,bytes=>{if(checksum&&sha256(bytes)!==checksum)throw Error('File part checksum mismatch');});});
    };
    for(const row of this.store.db.prepare('SELECT hash FROM blobs').all() as {hash:string}[])image(row.hash);
    for(const row of this.store.db.prepare('SELECT hash FROM file_blobs').all() as {hash:string}[])original(row.hash);
    for(const row of this.store.db.prepare('SELECT hash,parts,bytes FROM file_objects').all() as {hash:string;parts:number;bytes:number}[]){
      if(!/^[a-f0-9]{64}$/.test(row.hash)||!Number.isSafeInteger(row.parts)||row.parts<0||row.parts>100000)throw Error('Invalid managed object');
      for(let index=0;index<row.parts;index++)part(this.files.objects,row.hash,index);
    }
    for(const row of this.store.db.prepare('SELECT p.upload_id,p.part,p.hash FROM file_parts p JOIN file_uploads u ON u.id=p.upload_id WHERE u.ack IS NULL').all() as {upload_id:string;part:number;hash:string}[]){
      if(!uploadName.test(row.upload_id)||!Number.isSafeInteger(row.part)||row.part<0)throw Error('Invalid managed upload');
      part(this.files.uploads,row.upload_id,row.part,row.hash);
    }
    // A crash can leave a durable object before its DB transaction commits. Include
    // those files (and incomplete staging objects), or dropping the legacy key
    // marker would make a later retry interpret old ciphertext as plaintext.
    directory(this.store.blobsDir,this.archived.directory,this.files.objects,this.files.uploads);
    for(const name of readdirSync(this.store.blobsDir))if(hashName.test(name))image(name);
    for(const name of readdirSync(this.archived.directory)){
      const match=/^([a-f0-9]{64})(?:\.plain|\.aes)?$/.exec(name);if(match)original(match[1]);
    }
    for(const [root,pattern] of [[this.files.objects,objectName],[this.files.uploads,uploadName]] as const){
      for(const name of readdirSync(root))if(pattern.test(name)){
        await setImmediate();if(this.stopped){this.progress.state='cancelled';return;}
        const parent=join(root,name);
        try{
          directory(this.archived.directory,root,parent);
          for(const file of readdirSync(parent)){
            const match=/^(0|[1-9][0-9]*)(?:\.plain|\.aes)?$/.exec(file);
            if(match){const index=Number(match[1]);if(!Number.isSafeInteger(index))throw Error('Invalid managed part');part(root,name,index);}
          }
        }catch(error){steps.set(parent,()=>{throw error;});}
      }
    }
    this.progress.total=steps.size;
    for(const step of steps.values()){
      await setImmediate();if(this.stopped){this.progress.state='cancelled';return;}
      try{if(step())this.progress.converted++;else this.progress.skipped++;}catch{this.progress.failed++;}
      this.progress.processed++;
    }
    if(!this.stopped&&this.progress.failed===0)this.store.contentEncryption.finishDecryption();
    this.progress.state=this.stopped?'cancelled':'completed';
  }
}
export function registerContentStorage(app:FastifyInstance,service:ContentStorageService){
  app.get('/api/content-storage',async()=>service.snapshot());
  app.put('/api/content-storage',async req=>service.configure(z.object({enabled:z.boolean()}).strict().parse(req.body).enabled));
  app.post('/api/content-storage/decrypt',async(req,reply)=>{z.object({}).strict().parse(req.body??{});return reply.code(202).send(service.start());});
  app.post('/api/content-storage/decrypt/cancel',async()=>service.cancel());
}
