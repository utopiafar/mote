import {lstat,readdir,readFile,realpath} from 'node:fs/promises';
import {join} from 'node:path';

const hasTable=(db,name)=>Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
const safeId=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/.test(value)&&!['.','..'].includes(value);
const safeSegment=part=>Boolean(part)&&!['.','..'].includes(part)&&!/[\\\x00-\x1f\x7f]/.test(part);
export const safePluginBackupPath=name=>{
 const packageFile=/^plugins\/packages\/[a-f0-9]{64}\/(.+)$/.exec(name);
 if(packageFile)return safeSegment(packageFile[1])&&packageFile[1].split('/').every(safeSegment);
 const instanceFile=/^plugins\/instances\/[A-Za-z0-9][A-Za-z0-9_.-]{0,159}\/configuration-[a-f0-9]{64}\/(.+)$/.exec(name);
 if(!instanceFile)return false;
 const parts=instanceFile[1].split('/');
 return parts.every(safeSegment)&&!parts.some(part=>part.includes('credentials')||part.includes('sdk-state'))&&parts[parts.length-1]!=='provider.lock';
};
async function plainDirectory(path){const info=await lstat(path);if(!info.isDirectory()||await realpath(path)!==path)throw Error('Plugin backup links and special files are not allowed');}
async function ordinary(path){const info=await lstat(path);if(!info.isFile()||info.nlink!==1||await realpath(path)!==path)throw Error('Plugin backup links and special files are not allowed');}
async function entriesOrEmpty(path){try{await plainDirectory(path);return await readdir(path);}catch(error){if(error.code==='ENOENT')return [];throw error;}}
async function artifactFiles(source,relative){await plainDirectory(join(source,relative));const result=[];for(const name of await readdir(join(source,relative))){const file=relative+'/'+name;if(!safePluginBackupPath(file))throw Error('Invalid plugin artifact path');const info=await lstat(join(source,file));if(info.isDirectory()){await plainDirectory(join(source,file));result.push(...await artifactFiles(source,file));}else{await ordinary(join(source,file));result.push(file);}}return result;}
async function stoppedProvider(directory){try{await ordinary(join(directory,'provider.lock'));const owner=JSON.parse(await readFile(join(directory,'provider.lock'),'utf8'));if(!Number.isSafeInteger(owner.pid)||owner.pid<1)throw Error('Invalid Memory provider lock; inspect it before backing up');try{process.kill(owner.pid,0);throw Error('A Memory provider worker is still running. Stop Central and its provider workers before backup.');}catch(error){if(error.code!=='ESRCH')throw error;}}catch(error){if(error.code!=='ENOENT')throw error;}}
/** Reads the stopped host's generic plugin instances. It never starts an SDK,
 * resolves a credential, invokes a model, or substitutes a control SQL body. */
export async function pluginMemoryBackup(source,db){
 const paths=[],databases=[],providers=[];
 if(!hasTable(db,'memory_plan_binding'))return {paths,databases,providers};
 const configurations=hasTable(db,'memory_provider_configurations')?db.prepare('SELECT json FROM memory_provider_configurations').all().map(row=>JSON.parse(String(row.json))):[];
 const builds=hasTable(db,'plugin_build_instances')?db.prepare('SELECT json FROM plugin_build_instances ORDER BY rowid').all().map(row=>JSON.parse(String(row.json))):[];
 const packages=[...new Map([...builds.filter(value=>value.kind==='package'&&value.package).map(value=>value.package),...configurations.map(value=>value.package)].map(value=>[value.view.id+':'+value.view.source.digest,value])).values()];
 const storedInstances=builds.filter(value=>value.kind==='instance'&&value.instance).map(value=>value.instance);
 const instances=storedInstances.map(value=>value.view);
 // Provider-owned storage is copied opaquely from its instance configuration
 // directory. Remote services without a stopped snapshot protocol remain the
 // provider's responsibility and are never replaced with SQL control bodies.
 for(const instance of instances){const pkg=packages.find(value=>value.view.id===instance.packageId);if(!pkg)throw Error('A retained plugin instance has no package');}
 for(const pkg of packages){if(pkg.view.state!=='installed')continue;const digest=pkg.view.source?.digest;if(!/^[a-f0-9]{64}$/.test(digest))throw Error('Invalid fixed plugin artifact digest');const relative='plugins/packages/'+digest;await plainDirectory(join(source,relative));const lock=JSON.parse(await readFile(join(source,relative,'mote-install-lock.json'),'utf8'));if(lock.digest!==digest||JSON.stringify(lock.source)!==JSON.stringify(pkg.view.source))throw Error('The fixed plugin artifact lock does not match its retained package');paths.push(...await artifactFiles(source,relative));}
 const instanceRoot='plugins/instances';
 for(const id of await entriesOrEmpty(join(source,instanceRoot))){if(!safeId(id))throw Error('Invalid Memory provider storage path');const instanceDirectory=join(source,instanceRoot,id);await plainDirectory(instanceDirectory);
  for(const configuration of await readdir(instanceDirectory)){if(!/^configuration-[a-f0-9]{64}$/.test(configuration))throw Error('Invalid Memory provider configuration path');const relative=instanceRoot+'/'+id+'/'+configuration,directory=join(source,relative);await plainDirectory(directory);await stoppedProvider(directory);
   for(const filename of ['vectors.db','vectors_entities.db','history.db','operations.db']){const path=relative+'/'+filename;try{await ordinary(join(source,path));databases.push(path);}catch(error){if(error.code!=='ENOENT')throw error;}}
   const databasePaths=databases.filter(path=>path.startsWith(relative+'/')),genericFiles=[];
   const collect=async(folder,nameBase)=>{
    for(const name of await readdir(folder)){
     if(name==='provider.lock'||name.includes('credentials')||name.includes('sdk-state')||['runtime','provider','vectors.db','vectors_entities.db','history.db','operations.db'].includes(name))continue;
     const path=nameBase+'/'+name,info=await lstat(join(source,path));
     if(info.isSymbolicLink()||!info.isFile()&&!info.isDirectory())throw Error('Plugin backup links and special files are not allowed');
     if(info.isDirectory()){await plainDirectory(join(source,path));await collect(join(source,path),path);continue;}
     if(!safePluginBackupPath(path))throw Error('Invalid plugin artifact path');
     genericFiles.push(path);
    }
   };
   await collect(directory,relative);
   if(databasePaths.length&&databasePaths.length!==4)throw Error('A retained Memory provider database is missing; recover it before taking a complete backup');
   paths.push(...genericFiles);
   providers.push({instanceId:id,configuration,databasePaths,paths:genericFiles});
  }
 }
 return {paths:[...new Set(paths)],databases:[...new Set(databases)],providers};
}
