// Generated, IPC-controlled writers. Never use a real profile or a timing race.
import {promises as fs} from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';

const [directory,mode,family='central']=process.argv.slice(2);
const command=name=>new Promise(resolve=>{
  const receive=message=>{if(message===name){process.off('message',receive);resolve();}};
  process.on('message',receive);
});
const send=event=>process.send?.({event});
if(mode==='published'){
  const original=fs.link;
  fs.link=async function(...args){const result=await original.apply(this,args);send('published');await command('continue');return result;};
  syncBuiltinESMExports();
}
if(mode==='publishing'){
  const original=fs.open;
  fs.open=async function(path,...args){
    const handle=await original.call(this,path,...args);
    if(String(path).includes('retention')&&args[0]==='wx'){
      const write=handle.writeFile.bind(handle);
      handle.writeFile=async(...values)=>{send('publishing');await command('publish');return write(...values);};
    }
    return handle;
  };
  syncBuiltinESMExports();
}
const {DiagnosticLogStore}=await import('../../src/diagnostic-log-store.mjs');
const store=new DiagnosticLogStore(directory,{family,minFreeBytes:0});
try{
  if(mode==='legacy'){
    const path=join(directory,'retention.lock'),handle=await fs.open(path,'wx',0o600);
    send('entered');await command('release');
    await handle.writeFile(JSON.stringify({pid:process.pid,startedAt:Date.now()-process.uptime()*1000}));
    await handle.close();await fs.unlink(path);
  }else if(mode==='hold'||mode==='publishing'||mode==='published'){
    await store.exclusive(async()=>{send('entered');await command('release');});
  }else if(mode==='copies'){
    const {DiagnosticLogStore:Second}=await import('../../src/diagnostic-log-store.mjs?copy='+randomUUID());
    let release,entered;
    const firstEntered=new Promise(resolve=>{entered=resolve;});
    const first=store.exclusive(async()=>{
      const proof=await fs.open(join(directory,'critical-section'),'wx',0o600);
      try{entered();await new Promise(resolve=>{release=resolve;});}
      finally{await proof.close();await fs.unlink(join(directory,'critical-section'));}
    });
    await firstEntered;
    let secondEntered=false,blocked;
    const contention=new Promise(resolve=>{blocked=resolve;});
    const execute=DatabaseSync.prototype.exec;
    DatabaseSync.prototype.exec=function(sql){
      try{return execute.call(this,sql);}
      catch(error){if(sql==='BEGIN IMMEDIATE'&&error.errcode===5)blocked();throw error;}
    };
    const second=new Second(directory,{minFreeBytes:0}).exclusive(async()=>{
      secondEntered=true;
      const proof=await fs.open(join(directory,'critical-section'),'wx',0o600);
      await proof.close();await fs.unlink(join(directory,'critical-section'));
    }).then(()=>null,error=>error);
    // Observe an actual failed SQLite acquisition before releasing the owner.
    // On the old implementation, entry completes/fails while the owner holds
    // the proof file instead, deterministically exposing stolen ownership.
    try{
      await Promise.race([contention,second]);
      const overlapped=secondEntered;release();
      await first;const error=await second;if(error)throw error;
      if(overlapped)throw Error('A second module stole a live lock');
    }finally{release();DatabaseSync.prototype.exec=execute;}
  }else if(mode==='append'){
    await store.init();send('ready');await command('append');
    for(let index=0;index<24;index++){
      const at=new Date().toISOString();
      await store.append([{channel:'info',at,line:JSON.stringify({writer:process.pid,index})+'\n'}]);
    }
  }else throw Error('Unknown generated writer mode');
  send('done');
}catch(error){process.send?.({event:'failed',error:error.stack});process.exitCode=1;}
finally{process.disconnect?.();}
