/** Generated loopback Central. Controlled receipt failures are fixture-only. */
import {join,resolve} from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {buildApp} from '../../server/src/app.js';
const [directory,webRoot]=process.argv.slice(2);if(!directory||!webRoot)throw Error('Private profile and isolated Web build required');
const token=randomBytes(32).toString('hex'),headers={authorization:'Bearer '+token};let modelCalls=0;
const node=await buildApp({dataDir:join(directory,'data'),token,tokenPath:'fixture-only',host:'127.0.0.1',port:0,maxExportBytes:1_000_000,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:''},{webRoot:resolve(webRoot),backgroundWorker:false,agent:{configured:false,query:async()=>{modelCalls++;throw Error('No model in original deletion fixture');},close:async()=>{}}});
const control={mode:'normal',writes:0};
node.app.get('/fixture/deletion-control',async()=>({...control,modelCalls}));
node.app.post('/fixture/deletion-control',async req=>{control.mode=String((req.body as {mode:string}).mode);return control;});
node.app.addHook('preHandler',async(req,reply)=>{if(req.method==='DELETE'&&req.url.startsWith('/api/captures/')){control.writes++;if(control.mode==='zero')return reply.code(200).send({deleted:0});}});
node.app.addHook('onSend',async(req,reply,payload)=>{if(req.method==='DELETE'&&req.url.startsWith('/api/captures/')&&control.mode==='unknown'){reply.code(503);return JSON.stringify({error:'generated_transport_response_lost_after_real_commit'});}return payload;});
const notes=[];
for(let i=0;i<3;i++){
 const id=randomUUID(),text='  Generated exact original '+i+'\nLiteral note retained until a confirmed deletion.  ';
 const created=await node.app.inject({method:'POST',url:'/api/notes',headers,payload:{id,text,deviceId:'generated-reader',deviceName:'Generated Mac',platform:'macos',capturedAt:'2026-10-29T01:00:00Z',metadata:{version:1,observedAt:'2026-10-29T01:00:00Z',noteOrigin:{kind:'share',text:'Generated shared reference '+i}}}});if(created.statusCode!==201)throw Error(created.body);
 await node.materialOrganizer.tick(100);const material=node.materials.list({kind:'mote.note'}).items.find(m=>m.origin.externalId===id)!;
 notes.push({id,text,anchor:node.materials.evidenceIds(material.ref,['record'])[0],shared:node.materials.evidenceIds(material.ref,['shared-original'])[0]});
}
await node.app.listen({host:'127.0.0.1',port:0});const address=node.app.server.address();if(!address||typeof address==='string')throw Error('Loopback port required');console.log(JSON.stringify({origin:'http://127.0.0.1:'+address.port,token,notes,generatedOnly:true,modelCalls:0}));
process.on('SIGTERM',()=>{void node.app.close().then(()=>process.exit(0));});
