import { configFromEnv } from './config.js';
import { buildApp } from './app.js';
import { readFileSync,writeFileSync,unlinkSync,existsSync } from 'node:fs';
import { join } from 'node:path';
const config=configFromEnv();
const pidPath=join(config.dataDir,'server.pid');
if(existsSync(pidPath)) {
  const pid=Number(readFileSync(pidPath,'utf8').trim());
  // We have not acquired this lock yet. A matching PID is an earlier process's
  // leftover (notably PID 1 after a container restart), rather than another node.
  if(pid!==process.pid) {
    try {process.kill(pid,0);throw new Error('This data directory is already in use by a running central node');}
    catch(e){if((e as NodeJS.ErrnoException).code!=='ESRCH')throw e;}
  }
  unlinkSync(pidPath);
}
writeFileSync(pidPath,String(process.pid),{mode:0o600,flag:'wx'});
process.on('exit',()=>{if(existsSync(pidPath)&&readFileSync(pidPath,'utf8').trim()===String(process.pid))unlinkSync(pidPath);});
const {app}=await buildApp(config);
await app.listen({host:config.host,port:config.port});
console.info(`Mote central node: http://${config.host}:${config.port}\nVault: ${config.dataDir}\nAccess token: ${process.env.MOTE_TOKEN?'configured through environment':config.tokenPath}\nCapture starts only from an explicitly enabled collector.`);
let closing=false;
for(const signal of ['SIGTERM','SIGINT'] as const)process.on(signal,async()=>{if(closing)return;closing=true;await app.close();process.exit(0);});
