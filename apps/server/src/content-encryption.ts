import {createCipheriv,createDecipheriv,createHash,randomBytes,randomUUID} from 'node:crypto';
import {existsSync,readFileSync,writeFileSync,renameSync,unlinkSync,openSync,closeSync,fsyncSync} from 'node:fs';
import {join,dirname} from 'node:path';
import type {DatabaseSync} from 'node:sqlite';
import {privateFile} from './private-storage.js';

const fingerprint=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
export function replaceContentFile(path:string,bytes:Buffer) {
  const temporary=path+'.'+randomUUID()+'.tmp';
  try {
    writeFileSync(temporary,bytes,{mode:0o600,flag:'wx'});
    const fd=openSync(temporary,'r');try{fsyncSync(fd);}finally{closeSync(fd);}
    renameSync(temporary,path);
    const parent=openSync(dirname(path),'r');try{fsyncSync(parent);}finally{closeSync(parent);}
  }finally{if(existsSync(temporary))unlinkSync(temporary);}
}

/** Write policy and decryption identity are independent; mixed libraries remain readable. */
export class ContentEncryption {
  key?:Buffer;
  enabled:boolean;
  readonly legacyEncrypted:boolean;
  constructor(private directory:string,private db:DatabaseSync,options:{dataKey?:string;contentEncryptionEnabled?:boolean}) {
    const localKey=join(directory,'content-key');
    if(options.dataKey){if(!/^[a-f0-9]{64}$/i.test(options.dataKey))throw Error('MOTE_DATA_KEY must be 64 hexadecimal characters');this.key=Buffer.from(options.dataKey,'hex');}
    else if(existsSync(localKey)){privateFile(localKey);const value=readFileSync(localKey,'utf8').trim();if(!/^[a-f0-9]{64}$/i.test(value))throw Error('Invalid stored content encryption key');this.key=Buffer.from(value,'hex');}
    const setting=(key:string)=>(db.prepare('SELECT value FROM settings WHERE key=?').get(key) as {value:string}|undefined)?.value;
    const legacy=setting('encryption');this.legacyEncrypted=!!legacy&&legacy!=='none';
    const identity=setting('content-key-id')??(this.legacyEncrypted?legacy:undefined);
    if(identity&&(!this.key||fingerprint(this.key)!==identity))throw Error('Vault encryption key mismatch. Restore the original MOTE_DATA_KEY or content-key; existing encrypted data is retained.');
    // This marker describes pre-format file parts, never the current write policy.
    db.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)').run('encryption','none');
    this.enabled=setting('content-encryption-enabled')==='1'||(setting('content-encryption-enabled')===undefined&&options.contentEncryptionEnabled===true);
    if(this.enabled)this.ensureKey();
  }
  private ensureKey():Buffer {
    if(!this.key){this.key=randomBytes(32);replaceContentFile(join(this.directory,'content-key'),Buffer.from(this.key.toString('hex')+'\n'));}
    this.db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run('content-key-id',fingerprint(this.key));
    return this.key;
  }
  setEnabled(enabled:boolean){if(enabled)this.ensureKey();this.db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run('content-encryption-enabled',enabled?'1':'0');this.enabled=enabled;}
  finishDecryption(){
    if(this.enabled)throw Error('Disable content encryption before converting stored content');
    // Retain any locally generated key for future opt-in writes, but fully decrypted
    // libraries no longer require an environment key merely to start the service.
    this.db.prepare('DELETE FROM settings WHERE key=?').run('content-key-id');
    this.db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run('encryption','none');
  }
  seal(bytes:Buffer):Buffer {
    const key=this.ensureKey(),iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);
    return Buffer.concat([iv,cipher.update(bytes),cipher.final(),cipher.getAuthTag()]);
  }
  open(bytes:Buffer):Buffer {
    if(!this.key||bytes.length<28)throw Error('Encrypted content requires its original key');
    const decipher=createDecipheriv('aes-256-gcm',this.key,bytes.subarray(0,12));decipher.setAuthTag(bytes.subarray(-16));
    return Buffer.concat([decipher.update(bytes.subarray(12,-16)),decipher.final()]);
  }
  private selected(path:string):{path:string;encrypted:boolean} {
    if(existsSync(path+'.plain'))return {path:path+'.plain',encrypted:false};
    if(existsSync(path+'.aes'))return {path:path+'.aes',encrypted:true};
    return {path,encrypted:this.legacyEncrypted};
  }
  exists(path:string){return existsSync(path)||existsSync(path+'.plain')||existsSync(path+'.aes');}
  read(path:string):Buffer {const selected=this.selected(path);privateFile(selected.path);const bytes=readFileSync(selected.path);return selected.encrypted?this.open(bytes):bytes;}
  write(path:string,bytes:Buffer){
    const suffix=this.enabled?'.aes':'.plain';
    replaceContentFile(path+suffix,this.enabled?this.seal(bytes):bytes);
    // An upload may retry a write that reached disk before its DB row did, even
    // after the write policy changes. Publish the new bytes durably first, then
    // remove obsolete representations before the caller can acknowledge them.
    let removed=false;
    for(const old of ['', '.plain','.aes'])if(old!==suffix&&existsSync(path+old)){unlinkSync(path+old);removed=true;}
    if(removed){const parent=openSync(dirname(path),'r');try{fsyncSync(parent);}finally{closeSync(parent);}}
  }
  remove(path:string){for(const suffix of ['', '.plain','.aes'])if(existsSync(path+suffix))unlinkSync(path+suffix);}
  decrypt(path:string,validate:(bytes:Buffer)=>void=()=>{}):boolean {
    const selected=this.selected(path);
    privateFile(selected.path);const raw=readFileSync(selected.path),plain=selected.encrypted?this.open(raw):raw;validate(plain);
    const oldPaths=[path+'.aes',path].filter(old=>existsSync(old));
    // Validate every retained representation before replacing or removing any of
    // them. Interrupted writes must never discard a conflicting original copy.
    for(const old of oldPaths)if(old!==selected.path){
      privateFile(old);const bytes=readFileSync(old),decoded=old.endsWith('.aes')||this.legacyEncrypted?this.open(bytes):bytes;
      if(!decoded.equals(plain))throw Error('Interrupted content conversion has conflicting copies; both retained');
    }
    if(!selected.encrypted&&selected.path!==path+'.plain')return false;
    if(selected.path===path+'.plain'&&oldPaths.length===0)return false;
    replaceContentFile(path+'.plain',plain);
    // The plaintext replacement is durable before removing any original ciphertext.
    for(const old of oldPaths)unlinkSync(old);
    return true;
  }
}
