import {existsSync,lstatSync,readFileSync,rmSync} from 'node:fs';
import {resolve,join,parse} from 'node:path';

const paths=['mote.sqlite','mote.sqlite-wal','mote.sqlite-shm','mote.sqlite-journal','blobs','files','source-archive','imports','import-uploads'];

export function resetBackendV2(directory,{confirm=false}={}){
  if(!confirm)throw Error('Pass --confirm-clear to erase the old MVP evidence vault.');
  const root=resolve(directory);
  if(root===parse(root).root||!existsSync(root)||!lstatSync(root).isDirectory()||lstatSync(root).isSymbolicLink())throw Error('Expected an existing, non-symlink Mote data directory.');
  const pidFile=join(root,'server.pid');
  if(existsSync(pidFile)){
    const pid=Number(readFileSync(pidFile,'utf8').trim());
    if(Number.isSafeInteger(pid)&&pid>0){
      try{process.kill(pid,0);throw Error('Stop the Mote server before clearing its vault.');}
      catch(error){if(error.code!=='ESRCH')throw error;}
    }
  }
  const connectors=join(root,'connectors');
  if(existsSync(connectors)&&(!lstatSync(connectors).isDirectory()||lstatSync(connectors).isSymbolicLink()))throw Error('Connector storage must be an ordinary directory.');
  const removed=[];
  for(const name of paths){const target=join(root,name);if(!existsSync(target))continue;rmSync(target,{recursive:true,force:true});removed.push(name);}
  if(existsSync(connectors)){
    const clientConnections=join(connectors,'client-connections.json');
    if(existsSync(clientConnections)){rmSync(clientConnections,{force:true});removed.push('connectors/client-connections.json');}
  }
  return {dataDir:root,removed,preserved:['access-token','content-key','other connector credentials','logs','media-models']};
}

if(process.argv[1]&&resolve(process.argv[1])===new URL(import.meta.url).pathname){
  const index=process.argv.indexOf('--data-dir');
  if(index!==2||!process.argv[index+1]||process.argv.length!==5||process.argv[4]!=='--confirm-clear'){
    console.error('Usage: node scripts/reset-backend-v2.mjs --data-dir <directory> --confirm-clear');process.exitCode=2;
  }else{
    try{console.log(JSON.stringify(resetBackendV2(process.argv[index+1],{confirm:true})));}
    catch(error){console.error(error.message);process.exitCode=1;}
  }
}
