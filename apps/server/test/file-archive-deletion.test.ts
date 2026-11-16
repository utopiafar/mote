import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {type FileRevision,FILE_PART_BYTES} from '@mote/shared';
import {serializeConfigDocument} from '@mote/shared/config-file';
import {buildApp} from '../src/app.js';
import {configFromFile} from '../src/config.js';
import {sha256} from '../src/store.js';

async function fixture(t:TestContext){
 const directory=await mkdtemp(join(tmpdir(),'mote-archive-deletion-')),token='generated-archive-deletion-owner',path=join(directory,'mote.yaml');
 await writeFile(path,serializeConfigDocument({version:1,revision:0,server:{profile:'test',token},storage:{dataDir:join(directory,'data')},models:{deployment:{model:''}},diagnostics:{level:'silent'}}),{mode:0o600});
 const start=()=>buildApp(configFromFile(path),{backgroundWorker:false,agent:{configured:false,async query(){throw Error('No model in archive deletion fixture');},async close(){}}});
 let node=await start(),origin=await node.app.listen({host:'127.0.0.1',port:0});
 const owner={authorization:'Bearer '+token,'x-mote-ingress-version':'2'},cleanup=new Set<()=>void>();
 t.after(async()=>{for(const release of cleanup)release();await node.app.close();await rm(directory,{recursive:true,force:true});});
 const request=async(method:'GET'|'POST'|'PUT'|'PATCH'|'DELETE',url:string,payload?:unknown,headers:Record<string,string>=owner)=>{
  const response=await fetch(origin+url,{method,headers:{...headers,...(payload===undefined?{}:{'content-type':Buffer.isBuffer(payload)?'application/octet-stream':'application/json'})},...(payload===undefined?{}:{body:Buffer.isBuffer(payload)?payload:JSON.stringify(payload)})}),rawPayload=Buffer.from(await response.arrayBuffer()),body=rawPayload.toString('utf8');
  return {statusCode:response.status,body,rawPayload,json:()=>JSON.parse(body)};
 };
 for(const [id,deviceId]of [['visible','generated-device'],['other','other-device']] as const){const response=await request('POST','/api/sources',{id,name:'Generated '+id,kind:'local-files',deviceId,platform:'macos',retention:'archive'});assert.equal(response.statusCode,200,response.body);}
 const invitation=await request('POST','/api/connections/collector-invitations',{serverUrl:origin,label:'Generated archive collector',deviceId:'generated-device'});assert.equal(invitation.statusCode,200,invitation.body);
 const collector=await request('POST','/api/connections/redeem',{code:invitation.json().invitation.code,deviceId:'generated-device',deviceName:'Generated archive device',platform:'macos'});assert.equal(collector.statusCode,200,collector.body);
 const collectorHeaders={authorization:'Bearer '+collector.json().token,'x-mote-ingress-version':'2'};
 const begin=(input:FileRevision,headers=collectorHeaders)=>request('POST','/api/file-sync/v1/uploads',input,headers);
 const upload=async(input:FileRevision,bytes:Buffer,headers=collectorHeaders)=>{
  const response=await begin(input,headers);assert.equal(response.statusCode,200,response.body);const session=response.json();if(session.ack)return session.ack;
  for(let part=0;part<Math.ceil(bytes.length/FILE_PART_BYTES);part++){const chunk=bytes.subarray(part*FILE_PART_BYTES,(part+1)*FILE_PART_BYTES),received=await request('PUT',`/api/file-sync/v1/uploads/${session.uploadId}/parts/${part}`,chunk,headers);assert.equal(received.statusCode,200,received.body);assert.deepEqual(received.json(),{part,hash:sha256(chunk),bytes:chunk.length});}
  const committed=await request('POST',`/api/file-sync/v1/uploads/${session.uploadId}/commit`,{},headers);assert.equal(committed.statusCode,200,committed.body);const ack=committed.json();assert.equal(ack.receipt.state,'received');assert.equal(ack.sourceId,input.sourceId);assert.equal(ack.externalId,input.item.externalId);assert.equal(ack.revision,input.item.revision);assert.equal(ack.sha256,input.sha256);return ack;
 };
 return {get node(){return node;},request,owner,collectorHeaders,begin,upload,cleanup,async restart(){await node.app.close();node=await start();origin=await node.app.listen({host:'127.0.0.1',port:0});}};
}
function manifest(bytes:Buffer,revision='v1',previousRevision:string|null=null,sourceId='visible',externalId='generated-report'):FileRevision{return {sourceId,previousRevision,item:{externalId,revision,observedAt:'2026-11-17T00:00:00Z',title:'Generated report.txt',kind:'file',layer:'original',text:'',mimeType:'text/plain',deleted:false},relativePath:'generated/report.txt',sizeBytes:bytes.length,sha256:sha256(bytes)};}

test('owner HTTP archive deletion rejects old retries and still receives the next revision after restart',async t=>{
 const f=await fixture(t),bytes=Buffer.from('Generated old report'),first=manifest(bytes),ack=await f.upload(first,bytes);
 assert.equal((await f.request('DELETE','/api/files/'+ack.id,undefined,f.collectorHeaders)).statusCode,403,'collectors cannot delete Central archives');
 const deleted=await f.request('DELETE','/api/files/'+ack.id);assert.equal(deleted.statusCode,200,deleted.body);assert.deepEqual(deleted.json(),{deleted:1});
 assert.equal((await f.request('GET','/api/files/'+ack.id+'/content')).statusCode,404);
 assert.equal((await f.begin(first)).statusCode,410,'an old queue cannot recreate its deleted revision');
 await f.restart();
 assert.equal((await f.begin(first)).statusCode,410,'the same immutable revision stays deleted across restart');
 const head=await f.request('GET','/api/file-sync/v1/head?sourceId=visible&externalId=generated-report',undefined,f.collectorHeaders);assert.equal(head.statusCode,200,head.body);assert.deepEqual(head.json(),{revision:'v1',forgotten:false});
 const next=Buffer.from('Generated next report'),received=await f.upload(manifest(next,'v2',head.json().revision),next);
 assert.notEqual(received.id,ack.id);assert.equal((await f.request('GET','/api/files/'+received.id+'/content')).body,next.toString());assert.equal((await f.begin(first)).statusCode,410);
});
