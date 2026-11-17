/** Generated saved reports and one real note; no personal profile or model. */
import {join} from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {buildApp} from '../apps/server/src/app.js';
const directory=process.argv[2];if(!directory)throw Error('Fixture directory required');
const token=randomBytes(32).toString('hex'),when='2026-10-01T00:00:00.000Z',noteId=randomUUID();
const runtime=await buildApp({path:(join(directory,'data'))+'/mote.yaml',privateCredential:{token:token,tokenPath:'fixture-only'},initialDocument:{version:1,revision:0,storage:{dataDir:join(directory,'data'),maxExportBytes:1_000_000},server:{host:'127.0.0.1',port:0,allowedOrigins:[]},execution:{insightIntervalHours:0},models:{deployment:{model:'',apiKey:'',allowUnauthenticatedLocal:false,protocol:'deepseek',reasoningEffort:'high'},embedding:{model:'',baseUrl:'',apiKey:''}}}},{backgroundWorker:false,agent:{configured:false,query:async()=>{throw Error('No model calls allowed');},close:async()=>{}}});
const created=await runtime.app.inject({method:'POST',url:'/api/notes',headers:{authorization:'Bearer '+token},payload:{id:noteId,deviceId:'generated-discovery-device',deviceName:'Generated discovery device',platform:'android',capturedAt:when,text:'Generated discovery original: the plan is still unverified.',mood:'Generated explicit mood'}});
if(created.statusCode!==201)throw Error(created.body);
const ids=Array.from({length:67},()=>randomUUID()).sort().reverse();
for(const [index,id] of ids.entries())runtime.store.saveInsight({runId:id,answer:'Generated discovery '+index,citations:[{id:noteId,appName:'Generated original',capturedAt:when,excerpt:'The plan is still unverified.'}],trace:[]},id);
runtime.store.db.prepare('UPDATE insights SET created_at=?').run(when);
await runtime.app.listen({host:'127.0.0.1',port:0});
console.log(JSON.stringify({server:runtime.app.server.address(),token,noteId,oldId:ids[66],latestId:ids[0],generatedOnly:true,modelCalls:0}));
process.on('SIGTERM',()=>{void runtime.app.close().then(()=>process.exit(0));});
