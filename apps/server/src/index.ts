import { configFromFile,configFromDocument,registerBuiltinDomains,ConfigError } from './config.js';
import { buildApp } from './app.js';
import {defaultDistribution} from './distribution/default.js';
import { readFileSync,writeFileSync,unlinkSync,existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeRuntimeListener, cleanupRuntimeListener } from './runtime-listener.js';
import { ConfigService } from './config-service.js';
async function main() {
const selected=configFromFile(undefined,{initializeCredentials:false});
const configService=new ConfigService({path:selected.configuration.configFile!});
registerBuiltinDomains(configService);
try{await configService.initialize();}catch(error){await configService.close();throw error;}
const config=configFromDocument(configService.document(),configService.path);
const configFile=config.configuration.configFile!,instanceId=randomUUID();
process.on('exit',()=>cleanupRuntimeListener(configFile,process.pid,instanceId));
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
const {app}=await buildApp(config,{backgroundWorker:true,configService,distribution:defaultDistribution});
app.addHook('onSend',async(req,reply,payload)=>{if(req.routeOptions.url==='/api/health')reply.header('X-Mote-Runtime-Instance',instanceId);return payload;});
try{
  await app.listen({host:config.host,port:config.port});
  const address=app.server.address();
  if(!address||typeof address==='string')throw Error('Invalid server listener');
  await writeRuntimeListener(configFile,{version:1,pid:process.pid,port:address.port,address:address.address,instanceId});
  console.info(JSON.stringify({event:'server.listening',port:address.port,tokenConfigured:true}));
}catch(error){await app.close();throw error;}
let closing=false;
for(const signal of ['SIGTERM','SIGINT'] as const)process.on(signal,async()=>{if(closing)return;closing=true;try{await app.close();console.info(JSON.stringify({event:'server.stopped'}));process.exit(0);}catch{console.error(JSON.stringify({event:'server.stop_failed',category:'shutdown'}));process.exit(1);}});
}
void main().catch(error=>{
  const code=(error as {code?:unknown})?.code;
  const category=code==='MOTE_DATA_IN_USE'?'data_directory_in_use':code==='EADDRINUSE'?'port_in_use':code==='EACCES'||code==='EPERM'?'permission':'startup';
  console.error(JSON.stringify({event:'server.start_failed',category:error instanceof ConfigError?'configuration':category,...(error instanceof ConfigError?{field:error.field}:{})}));process.exitCode=1;
});
