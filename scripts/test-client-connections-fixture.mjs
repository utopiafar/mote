// Temporary generated-only central node for native-client integration. Never reads environment credentials.
import {mkdtemp,writeFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {randomBytes} from 'node:crypto';
import {buildApp} from '../apps/server/dist/app.js';
const index=process.argv.indexOf('--connection-file');
if(index<0||!process.argv[index+1])throw Error('Pass --connection-file /absolute/private-fixture.json');
const output=resolve(process.argv[index+1]),directory=await mkdtemp(join(tmpdir(),'mote-native-connect-fixture-'));
const token=randomBytes(32).toString('hex');
const config={path:(join(directory,'data'))+'/mote.yaml',privateCredential:{token:token,tokenPath:'unused'},initialDocument:{version:1,revision:0,storage:{dataDir:join(directory,'data'),maxExportBytes:16*1024*1024},server:{profile:'test',host:'127.0.0.1',port:0,allowedOrigins:[]},execution:{insightIntervalHours:0},models:{deployment:{model:'',apiKey:'',allowUnauthenticatedLocal:false,protocol:'deepseek',reasoningEffort:'high'},embedding:{model:'',baseUrl:'',apiKey:''}},connectors:{mcpEnabled:true,mcpReadToken:randomBytes(32).toString('hex')}}};
let app,ownsOutput=false;
async function close(){if(app)await app.close();if(ownsOutput)await rm(output,{force:true});await rm(directory,{recursive:true,force:true});}
try{
  ({app}=await buildApp(config,{agent:{configured:false,query:async()=>{throw Error('No model in connection fixture');},close:async()=>{}}}));
  await app.listen({host:'127.0.0.1',port:0});
  await mkdir(dirname(output),{recursive:true,mode:0o700});
  await writeFile(output,JSON.stringify({serverUrl:app.listeningOrigin,token,generatedOnly:true}),{mode:0o600,flag:'wx'});ownsOutput=true;
  console.info(JSON.stringify({ready:true,port:app.server.address().port,connectionFile:output,generatedOnly:true}));
  let stopping=false;const stop=()=>{if(stopping)return;stopping=true;void close().then(()=>process.exit(0));};
  process.once('SIGTERM',stop);process.once('SIGINT',stop);
}catch(error){await close();throw error;}
