/** Isolated real Central for native/Web first-data acceptance. Generated data only.
 * Caller owns its private directory and process. No model, deployment or real data. */
import {buildApp} from '../dist/app.js';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {randomBytes} from 'node:crypto';
const directory=resolve(process.argv[2]??'');
if(!process.argv[2])throw Error('Pass a new generated-fixture directory');
mkdirSync(directory,{mode:0o700});
const token=randomBytes(32).toString('hex');
const node=await buildApp({path:(join(directory,'vault'))+'/mote.yaml',privateCredential:{token:token,tokenPath:'generated-fixture-only'},initialDocument:{version:1,revision:0,storage:{dataDir:join(directory,'vault'),maxExportBytes:1_000_000},server:{host:'127.0.0.1',port:0,allowedOrigins:[]},execution:{insightIntervalHours:0},models:{deployment:{model:'',apiKey:'',allowUnauthenticatedLocal:false,protocol:'deepseek',reasoningEffort:'high'},embedding:{model:'',baseUrl:'',apiKey:''}},diagnostics:{level:'silent'}}},
 {backgroundWorker:false,agent:{configured:false,query:async()=>{throw Error('No live model in first-data acceptance');},close:async()=>{}}});
await node.app.listen({host:'127.0.0.1',port:0});
writeFileSync(join(directory,'connection.json'),JSON.stringify({url:node.app.listeningOrigin,token}),{mode:0o600});
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,async()=>{await node.app.close();process.exit(0);});
