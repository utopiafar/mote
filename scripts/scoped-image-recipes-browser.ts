/** Generated-only original Web UI fixture. No external model or private input. */
import {createServer} from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import sharp from 'sharp';
import {buildApp} from '../apps/server/src/app.js';
import {bytesHash} from '../apps/server/src/scope/originals.js';
import {defaultModelSettings} from '../apps/server/src/model-settings.js';
import type {Transcript} from '@mote/shared';

const directory=mkdtempSync(join(tmpdir(),'mote-image-recipes-browser-'));
const password='Generated-custom-image-browser-01';
const calls:string[]=[];
const provider=createServer(async(req,res)=>{
 for await(const _ of req){}
 calls.push(String(req.headers.authorization));await delay(1500);
 res.setHeader('X-Mote-Execution','local');
 res.end(JSON.stringify({durationMs:0,engine:'generated-browser-ocr',segments:[{startMs:0,endMs:0,text:'GENERATED_BROWSER_OCR_A'}]}));
});
await new Promise<void>(r=>provider.listen(0,'127.0.0.1',r));
const address=provider.address();if(!address||typeof address==='string')throw Error('No generated OCR address');
const node=await buildApp({dataDir:directory});
const registry=node.processing!.processors.imageRecipes;
registry.registerStage({id:'generated.browser-interpretation',version:'1',kind:'derived',run:async input=>{
 const image=await input.readImage({view:'image'});if(image.imageView?.original.width!==2)throw Error('Unexpected generated original');
 await delay(1500,undefined,{signal:input.signal});
 const ocr=input.dependencies.ocr as Transcript|undefined;
 return {text:ocr?'Generated interpretation of '+ocr.segments[0].text:'Generated interpretation from original pixels without OCR',regions:[{x:0,y:0,width:1,height:1,description:''}]};
}});
for(const withOcr of [true,false])registry.registerRecipe({id:withOcr?'generated.browser-with-ocr':'generated.browser-no-ocr',version:'1',steps:[
 ...(withOcr?[{name:'ocr',stage:{id:'mote.image-ocr',version:'1'},dependsOn:[]}]:[]),
 {name:'interpretation',stage:{id:'generated.browser-interpretation',version:'1'},dependsOn:withOcr?['ocr']:[]}
]});
registry.registerRecipe({id:'generated.browser-snapshot',version:'1',steps:[{name:'ocr',stage:{id:'mote.image-ocr',version:'1'},dependsOn:[]},{name:'first',stage:{id:'generated.browser-interpretation',version:'1'},dependsOn:['ocr']},{name:'last',stage:{id:'generated.browser-interpretation',version:'1'},dependsOn:['first']}]});
await node.accounts!.initialize('generated-admin',password);
async function request(token:string|undefined,url:string,method:any='GET',payload?:any){
 const response=await node.app.inject({url,method,headers:{'x-mote-protocol-version':'2','x-mote-ingress-version':'3',...(token?{authorization:'Bearer '+token}:{})},...(payload===undefined?{}:{payload})});
 if(response.statusCode!==200)throw Error(response.statusCode+':'+response.body);return response.json();
}
const login=(username:string)=>request(undefined,'/api/auth/login','POST',{username,password,mode:'client'});
const admin=await login('generated-admin'),ids:string[]=[];
const png=await sharp({create:{width:2,height:2,channels:3,background:'#447733'}}).png().toBuffer();
for(const label of ['a','b','snapshot']){
 const snapshot=label==='snapshot',withOcr=label!=='b';await request(admin.token,'/api/admin/accounts','POST',{username:'generated-'+label,password});
 const account=await login('generated-'+label);
 await request(account.token,'/api/ingress/sources','POST',{id:'same-source',name:'Generated custom image source',kind:'local-files',deviceId:'same-device',platform:'import',retention:snapshot?'snapshot':'archive'});
 const page=await request(account.token,'/api/file-processing');
 await request(account.token,'/api/file-processing','PUT',{
  revision:page.revision,settings:{...page.settings,automatic:false,summarize:false,understandingEnabled:!withOcr},
  policy:{version:1,services:withOcr?[{id:'ocr',name:'Generated OCR',kind:'image',reference:{kind:'personal',id:'same-ocr'}}]:[],profiles:[
   {id:'custom-image',name:withOcr?'Generated OCR and interpretation':'Generated pixels-only interpretation',processorId:'image.http',...(withOcr?{serviceId:'ocr'}:{}),parameters:{},summarize:false,imageRecipe:{id:snapshot?'generated.browser-snapshot':withOcr?'generated.browser-with-ocr':'generated.browser-no-ocr',version:'1'}},
   {id:'archive',name:'Generated archive',processorId:'archive',parameters:{},summarize:false}
  ],rules:[{type:'image/*',profileId:'custom-image'},{type:'*/*',profileId:'archive'}]},
  models:{profiles:withOcr?[{id:'same-ocr',name:'Generated local OCR',settings:{...defaultModelSettings(),provider:'custom',protocol:'mote-media',baseUrl:'http://127.0.0.1:'+address.port+'/ocr',apiKey:'GENERATED_BROWSER_A',model:''}}]:[],selections:{}}
 });
 const upload=await request(account.token,'/api/ingress/sources/same-source/uploads','POST',{batchId:'same-custom-image',revision:{sourceId:'same-source',previousRevision:null,processingProfileId:'custom-image',sizeBytes:png.length,sha256:bytesHash(png),relativePath:'generated.png',item:{externalId:'same-custom-image',revision:'r1',observedAt:'2026-10-17T00:00:00Z',title:'Generated custom image progress',text:'',kind:'file',layer:snapshot?'snapshot':'original',mimeType:'image/png',...(snapshot?{document:{fileIndex:{version:1,fileId:'same-custom-image',contentVersion:bytesHash(png),mode:'index',coverage:'none',parser:'central-pending',status:'pending',totalCharacters:0,offset:0,length:0,maxIndexCharacters:100000,allowRead:true}}}:{})}}});
 await request(account.token,'/api/ingress/uploads/'+upload.id+'/parts/0','PUT',{bytes:png.toString('base64'),checksum:bytesHash(png)});
 ids.push((await request(account.token,'/api/ingress/uploads/'+upload.id+'/commit','POST',{})).captures[0].id);
}
if(ids[0]!==ids[1])throw Error('Generated equal-image fixture IDs differ');
await node.app.listen({host:'127.0.0.1',port:0});
const web=node.app.server.address();if(!web||typeof web==='string')throw Error('No generated Web address');
console.log(JSON.stringify({generatedOnly:true,origin:'http://127.0.0.1:'+web.port,id:ids[0],users:['generated-a','generated-b','generated-snapshot'],password}));
let closing=false;
async function close(){if(closing)return;closing=true;provider.closeAllConnections();await node.app.close();await new Promise<void>(r=>provider.close(()=>r()));rmSync(directory,{recursive:true,force:true});console.log(JSON.stringify({generatedOnly:true,ocrCalls:calls.length}));process.exit(0);}
process.on('SIGINT',close);process.on('SIGTERM',close);
