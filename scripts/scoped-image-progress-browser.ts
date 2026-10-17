import {createServer} from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildApp} from '../apps/server/src/app.js';
import {bytesHash} from '../apps/server/src/scope/originals.js';
import {defaultModelSettings} from '../apps/server/src/model-settings.js';
import {defaultProcessingSettings} from '../apps/server/src/scope/processing-schema.js';
const directory=mkdtempSync(join(tmpdir(),'mote-image-browser-')),password='Generated-image-browser-01';
const provider=createServer((req,res)=>{void(async()=>{for await(const _ of req){}await new Promise(r=>setTimeout(r,1200));res.setHeader('X-Mote-Execution','local');res.end(JSON.stringify({durationMs:0,segments:[{startMs:0,endMs:0,text:'GENERATED_BROWSER_IMAGE_OCR'}],coverage:'full',engine:'generated-browser'}));})().catch(()=>res.destroy());});
await new Promise<void>(r=>provider.listen(0,'127.0.0.1',r));const address=provider.address();if(!address||typeof address==='string')throw Error('No OCR address');
const node=await buildApp({dataDir:directory});await node.accounts!.initialize('generated-admin',password);
async function request(token:string|undefined,url:string,method:any='GET',payload?:any){const r=await node.app.inject({url,method,headers:{'x-mote-protocol-version':'2','x-mote-ingress-version':'3',...(token?{authorization:'Bearer '+token}:{})},...(payload===undefined?{}:{payload})});if(r.statusCode!==200)throw Error(r.statusCode+':'+r.body);return r.json();}
const login=(username:string)=>request(undefined,'/api/auth/login','POST',{username,password,mode:'client'}),admin=await login('generated-admin'),ids=[];
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
for(const label of ['a','b']){
 await request(admin.token,'/api/admin/accounts','POST',{username:'generated-'+label,password});const account=await login('generated-'+label);await request(account.token,'/api/ingress/sources','POST',{id:'same-source',name:'Generated image source',kind:'local-files',deviceId:'same-device',platform:'import',retention:'archive'});
 let v=await request(account.token,'/api/configuration');await request(account.token,'/api/configuration/processing','PUT',{revision:v.revision,value:{...defaultProcessingSettings(),automatic:false,summarize:false,understandingEnabled:false}});v=await request(account.token,'/api/configuration');await request(account.token,'/api/configuration/models','PUT',{revision:v.revision,value:{profiles:[{id:'generated-ocr',name:'Generated OCR',settings:{...defaultModelSettings(),provider:'custom',protocol:'mote-media',baseUrl:'http://127.0.0.1:'+address.port,model:'generated',apiKey:'GENERATED_BROWSER'}}],selections:{ocr:{kind:'personal',id:'generated-ocr'}}}});
 const upload=await request(account.token,'/api/ingress/sources/same-source/uploads','POST',{batchId:'same-image',revision:{sourceId:'same-source',previousRevision:null,sizeBytes:png.length,sha256:bytesHash(png),relativePath:'image.png',item:{externalId:'same-image',revision:'r1',observedAt:'2026-10-17T00:00:00Z',title:'Generated image progress fixture',text:'',kind:'file',layer:'original',mimeType:'image/png'}}});await request(account.token,'/api/ingress/uploads/'+upload.id+'/parts/0','PUT',{bytes:png.toString('base64'),checksum:bytesHash(png)});ids.push((await request(account.token,'/api/ingress/uploads/'+upload.id+'/commit','POST',{})).captures[0].id);
}
await node.app.listen({host:'127.0.0.1',port:0});const server=node.app.server.address();if(!server||typeof server==='string')throw Error('No web address');console.log(JSON.stringify({generatedOnly:true,origin:'http://127.0.0.1:'+server.port,id:ids[0],username:'generated-a',password}));
let closing=false;async function close(){if(closing)return;closing=true;provider.closeAllConnections();await node.app.close();await new Promise<void>(r=>provider.close(()=>r()));rmSync(directory,{recursive:true,force:true});process.exit(0);}process.on('SIGINT',close);process.on('SIGTERM',close);
