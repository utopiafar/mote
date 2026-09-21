import { configFromEnv,ConfigError } from './config.js';
import { buildApp } from './app.js';
import { readFileSync,writeFileSync,unlinkSync,existsSync } from 'node:fs';
import { join } from 'node:path';
async function main() {
const config=configFromEnv();
const pidPath=join(config.dataDir,'server.pid');
if(existsSync(pidPath)) {
  const pid=Number(readFileSync(pidPath,'utf8').trim());
  // We have not acquired this lock yet. A matching PID is an earlier process's
  // leftover (notably PID 1 after a container restart), rather than another node.
  if(pid!==process.pid) {
    try {process.kill(pid,0);throw Object.assign(new Error('Central data directory already in use'),{code:'MOTE_DATA_IN_USE'});}
    catch(e){if((e as NodeJS.ErrnoException).code!=='ESRCH')throw e;}
  }
  unlinkSync(pidPath);
}
writeFileSync(pidPath,String(process.pid),{mode:0o600,flag:'wx'});
process.on('exit',()=>{try{if(existsSync(pidPath)&&readFileSync(pidPath,'utf8').trim()===String(process.pid))unlinkSync(pidPath);}catch{/* Never print a filesystem exception containing private paths. */}});
const {app}=await buildApp(config,{backgroundWorker:true});
try{await app.listen({host:config.host,port:config.port});}catch(error){await app.close();throw error;}
console.info(JSON.stringify({event:'server.listening',port:config.port,tokenConfigured:true}));
let closing=false;
for(const signal of ['SIGTERM','SIGINT'] as const)process.on(signal,async()=>{if(closing)return;closing=true;try{await app.close();console.info(JSON.stringify({event:'server.stopped'}));process.exit(0);}catch{console.error(JSON.stringify({event:'server.stop_failed',category:'shutdown'}));process.exit(1);}});
}
void main().catch(error=>{
  const code=(error as {code?:unknown})?.code;
  const category=code==='MOTE_DATA_IN_USE'?'data_directory_in_use':code==='EADDRINUSE'?'port_in_use':code==='EACCES'||code==='EPERM'?'permission':'startup';
  console.error(JSON.stringify({event:'server.start_failed',category:error instanceof ConfigError?'configuration':category,...(error instanceof ConfigError?{field:error.field}:{})}));process.exitCode=1;
});
