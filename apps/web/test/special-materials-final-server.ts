/** Private generated Central. No model responses, personal devices or external services. */
import {join,resolve} from 'node:path';
import {writeFileSync} from 'node:fs';
import {randomBytes,randomUUID} from 'node:crypto';
import {createServer,request} from 'node:http';
import sharp from 'sharp';
import {buildApp} from '../../server/src/app.js';
const directory=process.argv[2],webRoot=process.argv[3];
if(!directory||!webRoot)throw Error('Private generated profile and isolated Web build required');
const token=randomBytes(32).toString('hex'),headers={authorization:'Bearer '+token,'x-mote-ingress-version':'2'};
let modelCalls=0;
const node=await buildApp({path:(join(directory,'data'))+'/mote.yaml',privateCredential:{token:token,tokenPath:'fixture-only'},initialDocument:{version:1,revision:0,storage:{dataDir:join(directory,'data'),maxExportBytes:1_000_000},server:{host:'127.0.0.1',port:0,allowedOrigins:[]},execution:{insightIntervalHours:0},models:{deployment:{model:'',apiKey:'',allowUnauthenticatedLocal:false,protocol:'deepseek',reasoningEffort:'high'},embedding:{model:'',baseUrl:'',apiKey:''}}}},{webRoot:resolve(webRoot),backgroundWorker:false,agent:{configured:false,query:async()=>{modelCalls++;throw Error('Inference forbidden in generated presenter fixture');},close:async()=>{}}});
const today=new Date(),localDay=new Date(today.getFullYear(),today.getMonth(),today.getDate(),10),day=[today.getFullYear(),String(today.getMonth()+1).padStart(2,'0'),String(today.getDate()).padStart(2,'0')].join('-');
const at=(minutes:number,seconds=0)=>new Date(+localDay+minutes*60000+seconds*1000).toISOString();
const add=async(payload:object)=>{const response=await node.app.inject({method:'POST',url:'/api/captures',headers,payload});if(response.statusCode!==201)throw Error('Generated capture rejected '+response.body);};
const base={deviceId:'generated-special',deviceName:'Generated review device',platform:'android',windowTitle:'',ocrText:'',privacy:{collection:'content',mode:'none'}};
const image=(await sharp({create:{width:320,height:200,channels:3,background:'#d6c6ab'}}).png().toBuffer()).toString('base64');
const screenIds:string[]=[];
for(let i=0;i<22;i++){
 const id=randomUUID();screenIds.push(id);
 await add({...base,id,capturedAt:at(0,i),durationMs:0,appId:'generated.screens',appName:'Generated screenshot application',source:'screen',imageMime:'image/png',imageBase64:image,ocrText:'Generated exact screenshot original '+i,ocr:{status:'completed'}});
}
for(let i=1;i<22;i++)await add({...base,id:randomUUID(),capturedAt:at(i*6),durationMs:0,appId:'generated.app.'+i,appName:'Generated application '+i,source:'screen',imageMime:'image/png',imageBase64:image,ocrText:'Generated separate session '+i,ocr:{status:'completed'}});
for(const [offset,duration,app] of [[180,120000,'Writing'],[184,60000,'Reading']] as const)await add({...base,id:randomUUID(),capturedAt:at(offset),durationMs:duration,appId:'generated.'+app,appName:'Generated '+app,source:'activity',privacy:{collection:'activity',mode:'none'},metadata:{version:1,observedAt:at(offset)}});
for(const [offset,state] of [[200,'playing'],[201,'paused']] as const)await add({...base,id:randomUUID(),capturedAt:at(offset),durationMs:state==='playing'?20000:0,appId:'generated.player',appName:'Generated player',source:'media',metadata:{version:1,observedAt:at(offset),media:{status:'available',sessions:[{sessionId:'generated-playback',appId:'generated.player',appName:'Generated player',playbackState:state,appVisibility:'background',playbackType:'local',title:'Generated media observation'}]}}});
const sourceId='generated-coding';
for(let i=0;i<21;i++)node.sources.register({id:i?sourceId+'-'+i:sourceId,name:i?'Generated Coding source '+i:'Generated Coding review',kind:'coding-agent',deviceId:'generated-special',platform:'macos'});
for(let i=0;i<6;i++)await node.sources.upsert(sourceId,{externalId:'generated-event-'+i,revision:'1',observedAt:at(220+i),kind:'message',layer:'snapshot',text:'Generated Coding exact original '+i+' — this body is published from a real generated source event.',document:{contentRole:'transcript',coding:{version:1,provider:'codex',sessionId:'generated-session-'+i,projectKey:'generated-project',eventId:'generated-event-'+i,role:'user',attribution:'human',part:0,parts:1}}});
await node.sourcePipelines.tick();
const coding=await node.app.inject({url:'/api/coding/uploads?offset=0&limit=20',headers});
if(coding.statusCode!==200)throw Error('Coding receipt unavailable '+coding.body);
const receipt=coding.json().items.find((item:any)=>item.source.id===sourceId);
if(receipt?.received.events!==6||receipt?.materials!==6)throw Error('Real source publication did not produce six bodies '+JSON.stringify(receipt));
const browse=await node.app.inject({url:'/api/library/browse?sourceId='+sourceId+'&type=coding&limit=5',headers});
if(browse.statusCode!==200||browse.json().items.length!==5||!browse.json().nextCursor)throw Error('Real Coding browse pagination unavailable '+browse.body);
await node.app.listen({host:'127.0.0.1',port:0});
const upstream=node.app.server.address();if(!upstream||typeof upstream==='string')throw Error('Loopback required');
let bodyFailure=0;
const proxy=createServer((incoming,outgoing)=>{
 const url=new URL(incoming.url!,'http://generated.invalid');
 if(url.pathname==='/__fixture/body-failure'){bodyFailure=Number(url.searchParams.get('status'));outgoing.writeHead(200,{'content-type':'application/json'});outgoing.end('{}');return;}
 if(url.pathname==='/api/library/browse'&&url.searchParams.get('sourceId')===sourceId&&url.searchParams.get('limit')==='5'&&bodyFailure){outgoing.writeHead(bodyFailure,{'content-type':'application/json'});outgoing.end(JSON.stringify({error:'generated_read_failure',message:'Generated explicit body read fault'}));return;}
 const target=request({host:'127.0.0.1',port:upstream.port,path:incoming.url,method:incoming.method,headers:{...incoming.headers,host:'127.0.0.1:'+upstream.port}},response=>{outgoing.writeHead(response.statusCode!,response.headers);response.pipe(outgoing);});
 target.on('error',()=>{outgoing.writeHead(502);outgoing.end();});incoming.pipe(target);
});
await new Promise<void>(done=>proxy.listen(0,'127.0.0.1',done));const address=proxy.address();if(!address||typeof address==='string')throw Error('Loopback required');
console.log(JSON.stringify({origin:'http://127.0.0.1:'+address.port,token,sourceId,day,screenIds,generatedOnly:true}));
process.on('SIGTERM',()=>{proxy.close(()=>void node.app.close().then(()=>{writeFileSync(join(directory,'model-calls.json'),JSON.stringify({modelCalls}),{mode:0o600});process.exit(0);}));});
