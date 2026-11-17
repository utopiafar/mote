import {createHash,createDecipheriv} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {lstat,readdir,readFile,realpath,open} from 'node:fs/promises';
import {join} from 'node:path';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const hash=/^[a-f0-9]{64}$/,uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const hasTable=(db,name)=>Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
const failure=()=>Error('Native application backup/restore requires complete sealed state and its original key when encrypted; inputs were preserved');
const keys=(value,allowed)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(key=>allowed.includes(key));
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const relativePath=value=>typeof value==='string'&&value.length>0&&!value.includes('\\')&&!/[\x00-\x1f\x7f]/.test(value)&&value.split('/').every(part=>part&&part!=='.'&&part!=='..');

/** Only the dedicated, sealed APP tree. SDK working directories and the owner's
 * HOME/credential stores are never inferred as backup inputs. */
export function safeNativeApplicationBackupPath(path){
 const match=/^native-applications\/([a-f0-9]{64})\/generations\/([^/]+)\/(manifest|0|[1-9][0-9]*)\.(plain|aes)$/.exec(path);
 return Boolean(match&&uuid.test(match[2])&&(match[3]==='manifest'||Number.isSafeInteger(Number(match[3]))));
}
async function directory(path){const value=await lstat(path);if(!value.isDirectory()||value.isSymbolicLink()||await realpath(path)!==path)throw failure();return value;}
async function ordinary(path){const value=await lstat(path);if(!value.isFile()||value.nlink!==1||value.isSymbolicLink()||await realpath(path)!==path||(value.mode&0o077)!==0)throw failure();return value;}
async function children(path){try{await directory(path);return await readdir(path);}catch(error){if(error.code==='ENOENT')return [];throw error;}}
export async function assertNativeApplicationBackupLock(path){
 if(!path)throw Error('Native application backups require the profile backup entry and its lifecycle lock');
 try{await ordinary(path);}catch(error){if(error.code==='ENOENT')throw Error('Native application backups require the profile backup entry and its held lifecycle lock');throw error;}
 const owner=(await readFile(path,'utf8')).trim();
 if(process.env.MOTE_DEPLOY_DOCKER_CLI==='1'){
  let value;try{value=JSON.parse(owner);}catch{throw failure();}
  const hostname=process.env.HOSTNAME;if(!keys(value,['container'])||Object.keys(value).length!==1||!hash.test(value.container)||!hostname||!/^[a-f0-9]{12,64}$/.test(hostname)||!value.container.startsWith(hostname))throw failure();
 }else if(owner!==String(process.ppid))throw Error('Native application backup lifecycle lock is not held by this command owner');
 return owner;
}
async function originalKey(source,db,dataKey){
 if(dataKey!==undefined&&dataKey!==''){if(!/^[a-f0-9]{64}$/i.test(dataKey))throw failure();return Buffer.from(dataKey,'hex');}
 const path=join(source,'content-key');try{await ordinary(path);const value=(await readFile(path,'utf8')).trim();if(!/^[a-f0-9]{64}$/i.test(value))throw failure();return Buffer.from(value,'hex');}catch(error){if(error.code==='ENOENT')return;throw error;}
}
async function selected(source,logical){
 const found=[];for(const suffix of ['plain','aes']){const path=logical+'.'+suffix;try{const info=await ordinary(join(source,path));found.push({path,encrypted:suffix==='aes',size:info.size});}catch(error){if(error.code!=='ENOENT')throw error;}}
 if(found.length!==1)throw failure();return found[0];
}
async function content(source,file,key,{body=false}={}){
 if(body&&file.size>16*1024*1024+28)throw failure();
 if(body){const raw=await readFile(join(source,file.path));if(!file.encrypted)return raw;if(!key||raw.length<28)throw failure();const decipher=createDecipheriv('aes-256-gcm',key,raw.subarray(0,12));decipher.setAuthTag(raw.subarray(-16));return Buffer.concat([decipher.update(raw.subarray(12,-16)),decipher.final()]);}
 const digest=createHash('sha256');let decipher;
 if(file.encrypted){if(!key||file.size<28)throw failure();const fd=await open(join(source,file.path),'r');try{const iv=Buffer.alloc(12),tag=Buffer.alloc(16);await fd.read(iv,0,12,0);await fd.read(tag,0,16,file.size-16);decipher=createDecipheriv('aes-256-gcm',key,iv);decipher.setAuthTag(tag);}finally{await fd.close();}}
 if(!file.encrypted||file.size>28)for await(const part of createReadStream(join(source,file.path),file.encrypted?{start:12,end:file.size-17}:{}))digest.update(decipher?decipher.update(part):part);
 if(decipher)digest.update(decipher.final());return digest.digest('hex');
}
function controlRow(row){
 const match=/^dsh-app\/([a-f0-9]{64})\/control$/.exec(String(row.key));if(!match)throw failure();
 const value=JSON.parse(String(row.json));
 if(!keys(value,['version','identity','accepted','pending','writer'])||value.version!==1||value.identity!==match[1]||!value.accepted&&!value.pending||[value.accepted,value.pending].some(token=>token!==undefined&&!uuid.test(token)))throw failure();
 if(value.writer!==undefined&&(!keys(value.writer,['pid','token'])||Object.keys(value.writer).length!==2||!Number.isSafeInteger(value.writer.pid)||value.writer.pid<1||!uuid.test(value.writer.token)))throw failure();
 if(!Number.isSafeInteger(row.revision)||row.revision<1||Number(row.bytes)!==Buffer.byteLength(String(row.json)))throw failure();
 return {...row,value};
}

/** Called only after the profile owner has stopped writers. It reads current
 * StateStore control/receipt facts and validates the original sealed SDK format,
 * without running an application, reading arbitrary HOME, or changing a grant. */
export async function nativeApplicationBackup(source,db,{dataKey}={}){
 const root=join(source,'native-applications'),identities=await children(root);
 const rows=hasTable(db,'plugin_instance_state')?db.prepare("SELECT package_id,installation_id,instance_id,key,json,bytes,revision,updated_at FROM plugin_instance_state WHERE key LIKE 'dsh-app/%'").all():[];
 const controls=rows.filter(row=>String(row.key).endsWith('/control')).map(controlRow);
 if(new Set(controls.map(row=>row.value.identity)).size!==controls.length)throw failure();
 if(identities.some(id=>!hash.test(id)||!controls.some(row=>row.value.identity===id))||controls.some(row=>!identities.includes(row.value.identity)))throw failure();
 for(const row of rows){const match=/^dsh-app\/([a-f0-9]{64})\/(control|exposure\/([a-f0-9]{64}))$/.exec(String(row.key));if(!match||!controls.some(control=>control.value.identity===match[1]&&control.package_id===row.package_id&&control.installation_id===row.installation_id&&control.instance_id===row.instance_id))throw failure();if(match[3]&&sha(JSON.stringify(JSON.parse(String(row.json))))!==match[3])throw failure();}
 if(!controls.length)return {paths:[],controls};
 const key=await originalKey(source,db,dataKey),keyId=hasTable(db,'settings')?db.prepare("SELECT value FROM settings WHERE key='content-key-id'").get()?.value:undefined;
 if(keyId&&key&&sha(key)!==keyId)throw failure();
 const paths=[];
 for(const row of controls){
  const {identity,accepted,pending}=row.value,base='native-applications/'+identity;
  const entries=await children(join(source,base));if(entries.some(name=>name!=='generations'))throw failure();
  const tokens=[...new Set([accepted,pending].filter(Boolean))],retained=await children(join(source,base,'generations'));
  if(retained.some(token=>!tokens.includes(token))||tokens.some(token=>!retained.includes(token)))throw failure();
  const receipts=new Set(rows.filter(receipt=>receipt.package_id===row.package_id&&receipt.installation_id===row.installation_id&&receipt.instance_id===row.instance_id&&String(receipt.key).startsWith('dsh-app/'+identity+'/exposure/')).map(receipt=>String(receipt.key).split('/').at(-1)));
  for(const token of tokens){
   const generation=base+'/generations/'+token,manifestFile=await selected(source,generation+'/manifest');
   const manifest=JSON.parse((await content(source,manifestFile,key,{body:true})).toString());
   if(!keys(manifest,['version','identity','token','receiptHashes','files','unsupported'])||manifest.version!==1||manifest.identity!==identity||manifest.token!==token||!Array.isArray(manifest.receiptHashes)||manifest.receiptHashes.some(value=>!hash.test(value)||!receipts.has(value))||new Set(manifest.receiptHashes).size!==manifest.receiptHashes.length||!Array.isArray(manifest.files)||!Array.isArray(manifest.unsupported)||manifest.unsupported.length)throw failure();
   const seen=new Set(),selectedFiles=[manifestFile];
   for(const [index,file]of manifest.files.entries()){
    if(!keys(file,['path','hash'])||Object.keys(file).length!==2||!relativePath(file.path)||!['home','workspace','interaction'].includes(file.path.split('/')[0])||seen.has(file.path)||!hash.test(file.hash))throw failure();seen.add(file.path);
    const stored=await selected(source,generation+'/'+index);if(await content(source,stored,key)!==file.hash)throw failure();
    if(file.path==='interaction'){const marker=JSON.parse((await content(source,stored,key,{body:true})).toString());if(!keys(marker,['version','identity','token','receiptHashes'])||marker.version!==1||marker.identity!==identity||marker.token!==token||!same(marker.receiptHashes,manifest.receiptHashes))throw failure();}
    selectedFiles.push(stored);
   }
   if(!seen.has('interaction'))throw failure();
   const names=await children(join(source,generation));if(names.length!==selectedFiles.length||names.some(name=>!selectedFiles.some(file=>file.path===generation+'/'+name)))throw failure();
   paths.push(...selectedFiles.map(file=>file.path));
  }
 }
 return {paths,controls};
}

/** Only the copied SQLite snapshot may lose an obsolete process-local lease.
 * All retained APP tokens, exposure facts and every authority row stay intact. */
export function sanitizeNativeApplicationSnapshot(db,descriptor){
 if(!db.isTransaction)throw failure();
 for(const row of descriptor.controls){
  const found=db.prepare('SELECT json,bytes,revision FROM plugin_instance_state WHERE package_id=? AND installation_id=? AND instance_id=? AND key=?').get(row.package_id,row.installation_id,row.instance_id,row.key);
  if(!found||found.json!==row.json||found.revision!==row.revision||found.bytes!==row.bytes)throw failure();
  if(row.value.writer===undefined)continue;
  const {writer:_,...value}=row.value,json=JSON.stringify(value);
  const result=db.prepare('UPDATE plugin_instance_state SET json=?,bytes=? WHERE package_id=? AND installation_id=? AND instance_id=? AND key=? AND revision=? AND json=?').run(json,Buffer.byteLength(json),row.package_id,row.installation_id,row.instance_id,row.key,row.revision,row.json);
  if(result.changes!==1)throw failure();
 }
}
