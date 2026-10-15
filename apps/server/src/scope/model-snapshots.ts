import {createCipheriv,createDecipheriv,createHash,randomBytes,randomUUID} from 'node:crypto';
import {constants,closeSync,fchmodSync,fstatSync,fsyncSync,lstatSync,openSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import type {DatabaseSync} from 'node:sqlite';
import {privateDirectory} from '../private-storage.js';
import {validScopeId} from './baseline.js';

export class ModelSnapshotError extends Error{
  readonly code='model_snapshot_unavailable';
  readonly statusCode=503;
  constructor(){super('model_snapshot_unavailable');this.name='ModelSnapshotError';}
}
type SnapshotRow={version:number;key_hash:string;nonce:Uint8Array;ciphertext:Uint8Array;tag:Uint8Array};
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const owned=(uid:number)=>!process.getuid||uid===process.getuid();

/** Host-only durable model snapshots. Callers must authorize the host-issued
 * user context and current account/deletion/resource generations first. These
 * ciphertext records and their local keys are never portable user exports. */
export class ModelSnapshots{
  private readonly directory:string;
  private closed=false;
  constructor(private readonly options:{directory:string;db:DatabaseSync;deploymentId:string}){
    try{
      if(!validScopeId(options.deploymentId))throw Error();
      this.directory=resolve(options.directory);
      options.db.exec('CREATE TABLE IF NOT EXISTS user_model_snapshots(user_id TEXT NOT NULL,id TEXT NOT NULL,version INTEGER NOT NULL,key_hash TEXT NOT NULL,nonce BLOB NOT NULL,ciphertext BLOB NOT NULL,tag BLOB NOT NULL,PRIMARY KEY(user_id,id))');
    }catch{throw new ModelSnapshotError();}
  }
  private assertOwner(userId:string){if(this.closed||!validScopeId(userId))throw new ModelSnapshotError();}
  private paths(userId:string){
    const user=join(this.directory,'configuration','users',userId);
    return {directories:[this.directory,join(this.directory,'configuration'),join(this.directory,'configuration','users'),user],user,key:join(user,'snapshot-key')};
  }
  private directories(userId:string,create:boolean){
    const paths=this.paths(userId);
    for(const path of paths.directories){
      // Reads never recreate an erased account directory or missing key path.
      if(!create){const info=lstatSync(path);if(!info.isDirectory()||info.isSymbolicLink()||!owned(info.uid))throw Error();}
      privateDirectory(path);
    }
    return paths;
  }
  private readKey(path:string):Buffer{
    let handle:number|undefined,key:Buffer|undefined;
    try{
      handle=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
      let info=fstatSync(handle);
      if(!info.isFile()||info.nlink!==1||!owned(info.uid)||info.size!==32)throw Error();
      fchmodSync(handle,0o600);info=fstatSync(handle);
      key=readFileSync(handle);
      const after=fstatSync(handle),named=lstatSync(path);
      if(key.length!==32||after.size!==32||after.nlink!==1||info.mtimeMs!==after.mtimeMs||info.ctimeMs!==after.ctimeMs||named.isSymbolicLink()||named.dev!==after.dev||named.ino!==after.ino)throw Error();
      return key;
    }catch(error){key?.fill(0);throw error;}
    finally{if(handle!==undefined)closeSync(handle);}
  }
  private key(userId:string,create:boolean):Buffer{
    const paths=this.directories(userId,create);
    try{return this.readKey(paths.key);}
    catch(error){
      if(!create||(error as NodeJS.ErrnoException).code!=='ENOENT'||this.options.db.prepare('SELECT 1 FROM user_model_snapshots WHERE user_id=? LIMIT 1').get(userId))throw error;
    }
    let handle:number|undefined,key:Buffer|undefined;
    try{
      try{handle=openSync(paths.key,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);}
      catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')return this.readKey(paths.key);throw error;}
      key=randomBytes(32);writeFileSync(handle,key);fsyncSync(handle);
      const info=fstatSync(handle),named=lstatSync(paths.key);
      if(!info.isFile()||info.nlink!==1||!owned(info.uid)||info.size!==32||named.isSymbolicLink()||named.dev!==info.dev||named.ino!==info.ino)throw Error();
      const directory=openSync(paths.user,constants.O_RDONLY|constants.O_NOFOLLOW);
      try{fsyncSync(directory);}finally{closeSync(directory);}
      return key;
    }catch(error){key?.fill(0);throw error;}
    finally{if(handle!==undefined)closeSync(handle);}
  }
  private aad(userId:string,id:string){return Buffer.from(JSON.stringify(['mote-model-snapshot',1,this.options.deploymentId,userId,id]));}
  save(userId:string,payload:unknown):string{
    let plaintext:Buffer|undefined,key:Buffer|undefined,savepoint:string|undefined;
    try{
      this.assertOwner(userId);
      const json=JSON.stringify(payload);if(json===undefined)throw Error();plaintext=Buffer.from(json);
      const id=randomUUID();savepoint='model_snapshot_'+randomBytes(12).toString('hex');
      this.options.db.exec('SAVEPOINT '+savepoint);
      // Even an empty UPDATE promotes this savepoint to a write transaction.
      // Another host using this DB cannot read/create an unfinished key while
      // holding a competing write reservation. Existing caller transactions
      // retain ownership of their outer commit/rollback boundary.
      this.options.db.prepare('UPDATE user_model_snapshots SET version=version WHERE user_id=? AND id=(SELECT id FROM user_model_snapshots WHERE user_id=? LIMIT 1)').run(userId,userId);
      key=this.key(userId,true);
      const keyHash=createHash('sha256').update(key).digest('hex');
      const prior=this.options.db.prepare('SELECT DISTINCT key_hash FROM user_model_snapshots WHERE user_id=? LIMIT 2').all(userId) as {key_hash:string}[];
      if(prior.some(row=>row.key_hash!==keyHash))throw Error();
      const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,nonce,{authTagLength:16});
      cipher.setAAD(this.aad(userId,id));
      const ciphertext=Buffer.concat([cipher.update(plaintext),cipher.final()]),tag=cipher.getAuthTag();
      this.options.db.prepare('INSERT INTO user_model_snapshots(user_id,id,version,key_hash,nonce,ciphertext,tag) VALUES(?,?,1,?,?,?,?)').run(userId,id,keyHash,nonce,ciphertext,tag);
      this.options.db.exec('RELEASE SAVEPOINT '+savepoint);savepoint=undefined;return id;
    }catch{
      if(savepoint){try{this.options.db.exec('ROLLBACK TO SAVEPOINT '+savepoint);this.options.db.exec('RELEASE SAVEPOINT '+savepoint);}catch{/* Return only the fixed safe error. */}}
      throw new ModelSnapshotError();
    }finally{key?.fill(0);plaintext?.fill(0);}
  }
  read(userId:string,id:string):unknown|undefined{
    let key:Buffer|undefined,plaintext:Buffer|undefined;
    try{
      this.assertOwner(userId);if(typeof id!=='string'||!uuid.test(id))return undefined;
      const row=this.options.db.prepare('SELECT version,key_hash,nonce,ciphertext,tag FROM user_model_snapshots WHERE user_id=? AND id=?').get(userId,id) as SnapshotRow|undefined;
      if(!row)return undefined;
      if(row.version!==1||!(row.nonce instanceof Uint8Array)||row.nonce.length!==12||!(row.tag instanceof Uint8Array)||row.tag.length!==16||!(row.ciphertext instanceof Uint8Array)||!row.ciphertext.length)throw Error();
      key=this.key(userId,false);
      if(row.key_hash!==createHash('sha256').update(key).digest('hex'))throw Error();
      const decipher=createDecipheriv('aes-256-gcm',key,row.nonce,{authTagLength:16});decipher.setAAD(this.aad(userId,id));decipher.setAuthTag(row.tag);
      plaintext=Buffer.concat([decipher.update(row.ciphertext),decipher.final()]);return JSON.parse(plaintext.toString('utf8')) as unknown;
    }catch{throw new ModelSnapshotError();}
    finally{key?.fill(0);plaintext?.fill(0);}
  }
  deleteUser(userId:string):void{
    try{this.assertOwner(userId);this.options.db.prepare('DELETE FROM user_model_snapshots WHERE user_id=?').run(userId);}
    catch{throw new ModelSnapshotError();}
  }
  /** No keys are cached; each operation rechecks the owned, single-link file. */
  close():void{this.closed=true;}
}
