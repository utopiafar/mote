import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {lstat,readdir,readFile,realpath} from 'node:fs/promises';
import {join} from 'node:path';

const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const bodyDigest=memory=>{const {status:_,staleReason:__,updatedAt:___,...body}=memory;return hash(body);};
const hostState=(memory,expected)=>{const {status:_,staleReason:__,updatedAt:___,...body}=memory;return {...body,status:expected.status,...(expected.staleReason===undefined?{}:{staleReason:expected.staleReason}),...(expected.updatedAt===undefined?{}:{updatedAt:expected.updatedAt})};};
const hasTable=(db,name)=>Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
const retainedRows=(db,active,retired)=>{const selected=new Map();for(const table of [active,retired])if(hasTable(db,table))for(const row of db.prepare('SELECT id,json FROM '+table).all())if(!selected.has(row.id))selected.set(row.id,JSON.parse(String(row.json)));return [...selected.values()];};
const safeId=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/.test(value)&&!['.','..'].includes(value);
export const safePluginBackupPath=name=>{
 const packageFile=/^plugins\/packages\/[a-f0-9]{64}\/(.+)$/.exec(name);
 if(packageFile)return !packageFile[1].includes('\\')&&packageFile[1].split('/').every(part=>part&&!['.','..'].includes(part)&&!/[\x00-\x1f\x7f]/.test(part));
 return /^plugins\/instances\/[A-Za-z0-9][A-Za-z0-9_.-]{0,159}\/configuration-[a-f0-9]{64}\/(?:(?:vectors|vectors_entities|operations|history)\.db|hindsight-backup\/(?:manifest\.json|runtime-descriptor\.json|provider-control\.json|canonical-records\.json|volume\.tar))$/.test(name)||name==='memory-provider-export.json';
};
async function plainDirectory(path){const info=await lstat(path);if(!info.isDirectory()||await realpath(path)!==path)throw Error('Plugin backup links and special files are not allowed');}
async function ordinary(path){const info=await lstat(path);if(!info.isFile()||info.nlink!==1||await realpath(path)!==path)throw Error('Plugin backup links and special files are not allowed');}
async function entriesOrEmpty(path){try{await plainDirectory(path);return await readdir(path);}catch(error){if(error.code==='ENOENT')return [];throw error;}}
async function artifactFiles(source,relative){await plainDirectory(join(source,relative));const result=[];for(const name of await readdir(join(source,relative))){const file=relative+'/'+name;if(!safePluginBackupPath(file))throw Error('Invalid plugin artifact path');const info=await lstat(join(source,file));if(info.isDirectory()){await plainDirectory(join(source,file));result.push(...await artifactFiles(source,file));}else{await ordinary(join(source,file));result.push(file);}}return result;}
async function stoppedProvider(directory){try{await ordinary(join(directory,'provider.lock'));const owner=JSON.parse(await readFile(join(directory,'provider.lock'),'utf8'));if(!Number.isSafeInteger(owner.pid)||owner.pid<1)throw Error('Invalid Memory provider lock; inspect it before backing up');try{process.kill(owner.pid,0);throw Error('A Memory provider worker is still running. Stop Central and its provider workers before backup.');}catch(error){if(error.code!=='ESRCH')throw error;}}catch(error){if(error.code!=='ENOENT')throw error;}}
const namespace=value=>{if(!value||typeof value.ownerId!=='string'||!value.ownerId||!safeId(value.instanceId)||!Number.isSafeInteger(value.bindingRevision)||value.bindingRevision<1)throw Error('Invalid Memory backup namespace');return {ownerId:value.ownerId,instanceId:value.instanceId,bindingRevision:value.bindingRevision};};
const key=memory=>{if(!memory||typeof memory.id!=='string'||!/^[a-f0-9-]{36}$/i.test(memory.id)||!Number.isSafeInteger(memory.version)||memory.version<1||!/^[a-f0-9]{64}$/.test(memory.fingerprint))throw Error('Invalid Memory backup revision');return {memoryId:memory.id,version:memory.version,fingerprint:memory.fingerprint};};
export function canonicalNativeExport(binding,controlMemories,records,providers){
 const ns=namespace(binding.namespace),selected=new Map();
 for(const record of records){if(JSON.stringify(namespace(record.namespace))!==JSON.stringify(ns))continue;const expected=controlMemories.find(memory=>JSON.stringify(key(memory))===JSON.stringify(record.key));if(!expected)continue;
  if(selected.has(expected.id)||bodyDigest(record.memory)!==bodyDigest(expected)||JSON.stringify(key(record.memory))!==JSON.stringify(record.key))throw Error('The native Memory export does not match the current immutable catalog');
  selected.set(expected.id,hostState(record.memory,expected));
 }
 if(selected.size!==controlMemories.length)throw Error('The native Memory export is missing an exact current body; the backup cannot fall back to SQL bodies');
 return {version:1,binding,memories:controlMemories.map(memory=>selected.get(memory.id)),providers};
}

/** Reads the stopped host's real fixed mem0 databases. It never starts an SDK,
 * resolves a credential, invokes a model, or substitutes the control SQL body. */
export async function pluginMemoryBackup(source,db){
 const paths=[],databases=[],providers=[],nativeSnapshots=[];
 if(!hasTable(db,'memory_plan_binding'))return {paths,databases,providers,nativeSnapshots};
 const binding=JSON.parse(String(db.prepare('SELECT json FROM memory_plan_binding WHERE id=1').get()?.json??'null'));
 const configurations=hasTable(db,'memory_provider_configurations')?db.prepare('SELECT json FROM memory_provider_configurations').all().map(row=>JSON.parse(String(row.json))):[];
 const packages=[...new Map([...retainedRows(db,'plugin_packages','plugin_retired_packages'),...configurations.map(value=>value.package)].map(value=>[value.view.id+':'+value.view.source.digest,value])).values()];
 const storedInstances=retainedRows(db,'plugin_instances','plugin_retired_instances');
 const instances=storedInstances.map(value=>value.view);
 // Remote/generic code can retain authoritative data outside this vault. A
 // complete backup needs that provider's declared native snapshot protocol.
 for(const instance of instances){const pkg=packages.find(value=>value.view.id===instance.packageId);if(!pkg)throw Error('A retained plugin instance has no package');if(!['mote.mem0@1','mote.hindsight@1'].includes(pkg.hostAdapter))throw Error('Complete backup for this external Memory provider requires its native service snapshot and restore procedure; no verified protocol is available. Existing data was preserved.');}
 if(configurations.some(value=>!['mote.mem0@1','mote.hindsight@1'].includes(value.package.hostAdapter)))throw Error('Complete backup for a retained external Memory configuration requires its verified native service snapshot and restore procedure');
 for(const pkg of packages){if(pkg.view.state!=='installed')continue;const digest=pkg.view.source?.digest;if(!/^[a-f0-9]{64}$/.test(digest))throw Error('Invalid fixed plugin artifact digest');const relative='plugins/packages/'+digest;await plainDirectory(join(source,relative));const lock=JSON.parse(await readFile(join(source,relative,'mote-install-lock.json'),'utf8'));if(lock.digest!==digest||JSON.stringify(lock.source)!==JSON.stringify(pkg.view.source))throw Error('The fixed plugin artifact lock does not match its retained package');paths.push(...await artifactFiles(source,relative));}
 const instanceRoot='plugins/instances';
 for(const id of await entriesOrEmpty(join(source,instanceRoot))){if(!safeId(id))throw Error('Invalid Memory provider storage path');const instanceDirectory=join(source,instanceRoot,id);await plainDirectory(instanceDirectory);
  for(const configuration of await readdir(instanceDirectory)){if(!/^configuration-[a-f0-9]{64}$/.test(configuration))throw Error('Invalid Memory provider configuration path');const relative=instanceRoot+'/'+id+'/'+configuration,directory=join(source,relative);await plainDirectory(directory);await stoppedProvider(directory);
   const contents=await readdir(directory);
   if(contents.includes('runtime')||contents.includes('provider')){
    const runtimeDirectory=join(directory,'runtime'),providerDirectory=join(directory,'provider');await plainDirectory(runtimeDirectory);await plainDirectory(providerDirectory);await ordinary(join(runtimeDirectory,'runtime-descriptor.json'));await ordinary(join(providerDirectory,'provider-control.json'));
    const archiveRelative=relative+'/hindsight-backup';nativeSnapshots.push({runtimeDirectory,providerDirectory,relative:archiveRelative});providers.push({instanceId:id,configuration,provider:'mote.hindsight',archiveRelative});continue;
   }
   for(const filename of ['vectors.db','vectors_entities.db','history.db','operations.db']){const path=relative+'/'+filename;try{await ordinary(join(source,path));databases.push(path);}catch(error){if(error.code!=='ENOENT')throw error;}}
   const databasePaths=databases.filter(path=>path.startsWith(relative+'/'));if(databasePaths.length&&databasePaths.length!==4)throw Error('A retained Memory provider database is missing; recover it before taking a complete backup');
   providers.push({instanceId:id,configuration,databasePaths});
  }
 }
 let canonical;
 if(binding?.namespace){
  const ns=namespace(binding.namespace),pinned=configurations.find(value=>JSON.stringify(namespace(value.namespace))===JSON.stringify(ns)),stored=storedInstances.find(value=>value.view.id===ns.instanceId),instance=pinned?.instance??stored?.view;if(!instance)throw Error('The active Memory provider instance is missing');const configuration='configuration-'+createHash('sha256').update(pinned?.identity??stored.configurationId??hash(instance.configuration)).digest('hex'),relative=instanceRoot+'/'+ns.instanceId+'/'+configuration,pkg=pinned?.package??packages.find(value=>value.view.id===instance.packageId);
  if(pkg.hostAdapter==='mote.hindsight@1'){
   if(!nativeSnapshots.some(value=>value.relative===relative+'/hindsight-backup'))throw Error('The active Hindsight native snapshot is missing; the backup cannot fall back to SQL bodies');
   // The authoritative canonical bodies and native history are in PostgreSQL.
   // A stopped service snapshot never treats the Central control mirror as a
   // portable provider export and never starts the API to synthesize one.
   return {paths:[...new Set(paths)],databases:[...new Set(databases)],providers,nativeSnapshots,canonicalFromNative:{binding,controlMemories:db.prepare('SELECT json FROM memories ORDER BY id').all().map(row=>JSON.parse(String(row.json))),relative:relative+'/hindsight-backup'}};
  }
  for(const filename of ['vectors.db','vectors_entities.db','history.db','operations.db'])if(!databases.includes(relative+'/'+filename))throw Error('The active Memory provider database is missing; the backup cannot fall back to SQL bodies');
  const vectorDb=new DatabaseSync(join(source,relative,'vectors.db'),{readOnly:true}),journal=new DatabaseSync(join(source,relative,'operations.db'),{readOnly:true});
  try{
   const records=db.prepare('SELECT json FROM memories ORDER BY id').all().map(row=>JSON.parse(String(row.json))),resolved=[];
   for(const memory of records){const expectedKey=key(memory),mapping=journal.prepare('SELECT external_id,digest,fingerprint,removed FROM provider_records WHERE namespace=? AND memory_id=? AND version=?').get(JSON.stringify(ns),expectedKey.memoryId,expectedKey.version);if(!mapping||mapping.removed||mapping.fingerprint!==expectedKey.fingerprint)throw Error('The Memory provider has no exact current history receipt; the backup cannot fall back to SQL bodies');
    const row=vectorDb.prepare('SELECT payload FROM vectors WHERE id=?').get(mapping.external_id);if(!row)throw Error('The bound Memory provider body is missing; the backup cannot fall back to SQL bodies');const payload=JSON.parse(String(row.payload)),record=payload.mote_record;
    if(!record||JSON.stringify(namespace(record.namespace))!==JSON.stringify(ns)||JSON.stringify(record.key)!==JSON.stringify(expectedKey)||bodyDigest(record.memory)!==bodyDigest(memory)||hash(record)!==mapping.digest||payload.mote_digest!==mapping.digest||payload.data!==record.memory.title+'\n'+record.memory.statement)throw Error('The bound Memory provider body does not match the complete canonical revision');resolved.push(hostState(record.memory,memory));
   }
   canonical={version:1,binding,memories:resolved,providers};
  }finally{vectorDb.close();journal.close();}
 }
 return {paths:[...new Set(paths)],databases:[...new Set(databases)],providers,nativeSnapshots,canonical};
}
