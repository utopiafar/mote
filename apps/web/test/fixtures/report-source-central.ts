/** Isolated real Central originals for the report pointer fixture; no model. */
import {join} from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {buildApp} from '../../../server/src/app.js';
const directory=process.argv[2];if(!directory)throw Error('Generated fixture directory required');
const token=randomBytes(32).toString('hex'),noteId=randomUUID(),when='2026-10-01T00:00:00.000Z',text='Generated exact report original: the planned review remains unverified.';
const node=await buildApp({path:(join(directory,'central'))+'/mote.yaml',privateCredential:{token:token,tokenPath:'fixture-only'},initialDocument:{version:1,revision:0,storage:{dataDir:join(directory,'central'),maxExportBytes:1_000_000},server:{host:'127.0.0.1',port:0,allowedOrigins:[]},execution:{insightIntervalHours:0},models:{deployment:{model:'',apiKey:'',allowUnauthenticatedLocal:false,protocol:'deepseek',reasoningEffort:'high'},embedding:{model:'',baseUrl:'',apiKey:''}}}},{backgroundWorker:false,agent:{configured:false,query:async()=>{throw Error('The report fixture must never call a model');},close:async()=>{}}});
const response=await node.app.inject({method:'POST',url:'/api/notes',headers:{authorization:'Bearer '+token},payload:{id:noteId,deviceId:'generated-report-device',deviceName:'Generated report device',platform:'android',capturedAt:when,text}});if(response.statusCode!==201)throw Error(response.body);
await node.app.listen({host:'127.0.0.1',port:0});const address=node.app.server.address();if(!address||typeof address==='string')throw Error('Expected loopback server');
console.log(JSON.stringify({origin:'http://127.0.0.1:'+address.port,token,noteId,text,generatedOnly:true,modelCalls:0}));
process.on('SIGTERM',()=>{void node.app.close().then(()=>process.exit(0));});
