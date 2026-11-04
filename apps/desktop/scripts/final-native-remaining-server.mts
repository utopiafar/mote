/** Generated, loopback-only fixture. No query agent, collector or background worker. */
import {buildApp} from '../../server/src/app.js';
import {materialId} from '../../server/src/materials.js';
import {join,resolve} from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {existsSync,writeFileSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';

const directory=process.argv[2];
if(!directory?.includes('/mote-native-remaining-'))throw Error('Private generated directory required');
const token=randomBytes(32).toString('hex');
const node=await buildApp({dataDir:join(directory,'central'),token,tokenPath:'fixture-only',host:'127.0.0.1',port:0,maxStorageBytes:20_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:''},{webRoot:resolve('apps/web/dist'),backgroundWorker:false,agent:{configured:false,query:async()=>{throw Error('No model permitted');},close:async()=>{}}});
let queryAdmissions=0,capturePosts=0,seed:unknown;
node.app.addHook('onRequest',async(req,reply)=>{
 if(req.method==='POST'&&req.url.startsWith('/api/query-runs')){queryAdmissions++;return reply.code(503).send({error:'fixture_no_model'});}
 if(req.method==='GET'&&req.url.startsWith('/api/capture-browser?'))while(existsSync(join(directory,'hold-content')))await delay(15);
 if(req.method==='GET'&&req.url.startsWith('/api/memories')&&existsSync(join(directory,'deny-memory')))return reply.code(403).send({error:'forbidden'});
 if(req.method==='GET'&&req.url==='/api/features'&&existsSync(join(directory,'fail-features')))return reply.code(503).send({error:'service_unavailable'});
 if(req.method==='POST'&&req.url==='/api/captures')capturePosts++;
 if(req.method==='GET'&&/^\/api\/capture-browser\/[a-f0-9-]{36}$/.test(req.url)&&existsSync(join(directory,'hide-capture')))return reply.code(503).send({error:'service_unavailable'});
});
node.app.addHook('onSend',async(req,reply,payload)=>{
 if(req.method==='POST'&&req.url==='/api/captures'&&reply.statusCode<300){
  const held=existsSync(join(directory,'hold-capture-ack'));
  if(held){writeFileSync(join(directory,'capture-committed'),'true');while(existsSync(join(directory,'hold-capture-ack')))await delay(15);}
  if(held||existsSync(join(directory,'fail-capture-ack'))){reply.code(503);return JSON.stringify({error:'service_unavailable'});}
 }
 return payload;
});
node.app.post('/__fixture/seed',async(req,reply)=>{
 if(req.headers.authorization!=='Bearer '+token)return reply.code(403).send({error:'forbidden'});
 if(seed)return seed;
 const id=randomUUID(),text='Generated M09 exact original. Scope navigation changes no original bytes.',at=new Date().toISOString();
 const saved=await node.app.inject({method:'POST',url:'/api/notes',headers:{authorization:'Bearer '+token},payload:{id,deviceId:'generated-scope-source',deviceName:'Generated scope source',platform:'import',capturedAt:at,text}});
 if(saved.statusCode!==201)throw Error('Generated note rejected');
 node.sources.register({id:'generated-scope-source',name:'Generated scope source',kind:'custom',deviceId:'generated-scope-source',platform:'import'});
 const material=node.materials.publish({id:materialId('generated-scope-source','scope-original'),kind:'mote.file',schemaVersion:1,title:'Generated exact scope original',origin:{sourceId:'generated-scope-source',externalId:'scope-original',deviceId:'generated-scope-source',firstAt:at,lastAt:at},members:[{id,kind:'capture',ref:'capture:'+id}],blocks:[{id:'original',kind:'text',format:'plain',text,memberIds:[id]}],coverage:{state:'complete'},fidelity:{state:'lossless'},retention:{original:'retained',policy:'keep'}},{expectedRevision:node.materials.revisionForWrite(materialId('generated-scope-source','scope-original'))});
 // This is an explicitly generated failed historical turn, never a fixture answer.
 const appended=node.conversations.appendFailure(undefined,{question:'Generated scope navigation history',anchorMaterialRef:material.ref},{code:'cancelled',message:'Generated cancelled history; no model was called.'});
 const conversation=node.conversations.get(appended.conversationId);
 seed={originalId:id,text,materialRef:material.ref,conversationId:conversation.id,title:conversation.title,turnId:conversation.turns[0].id};return seed;
});
node.app.get('/__fixture/counts',async(req,reply)=>req.headers.authorization==='Bearer '+token?{queryAdmissions,capturePosts,captures:node.store.db.prepare('SELECT count(*) AS n FROM captures').get()!.n}:reply.code(403).send({error:'forbidden'}));
await node.app.listen({host:'127.0.0.1',port:0});const address=node.app.server.address();if(!address||typeof address==='string')throw Error('Loopback port required');
writeFileSync(join(directory,'runtime.json'),JSON.stringify({origin:'http://127.0.0.1:'+address.port,token}),{mode:0o600});
process.once('SIGTERM',()=>{void node.app.close().then(()=>process.exit(0));});
