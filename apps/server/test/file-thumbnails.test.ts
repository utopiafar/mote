import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import sharp from 'sharp';
import {FILE_PART_BYTES,type FileRevision} from '@mote/shared';
import {sha256} from '../src/store.js';
import {buildApp} from '../src/app.js';
import {configFromFile} from '../src/config.js';
import {serializeConfigDocument} from '@mote/shared/config-file';

function manifest(bytes:Buffer,mimeType:string,title:string,externalId:string,revision='v1',previousRevision:string|null=null):FileRevision{
  return {sourceId:'phone',previousRevision,item:{externalId,revision,observedAt:new Date().toISOString(),title,kind:'file',layer:'original',text:'',mimeType,deleted:false},relativePath:'generated/'+title,sizeBytes:bytes.length,sha256:sha256(bytes)};
}

async function upload(app:any,headers:any,input:FileRevision,bytes:Buffer){
  const started=await app.inject({method:'POST',url:'/api/file-sync/v1/uploads',headers,payload:input});
  assert.equal(started.statusCode,200,started.body);const session=started.json();
  for(let n=0;n<Math.ceil(bytes.length/FILE_PART_BYTES);n++)
    assert.equal((await app.inject({method:'PUT',url:`/api/file-sync/v1/uploads/${session.uploadId}/parts/${n}`,headers:{...headers,'content-type':'application/octet-stream'},payload:bytes.subarray(n*FILE_PART_BYTES,(n+1)*FILE_PART_BYTES)})).statusCode,200);
  const committed=await app.inject({method:'POST',url:`/api/file-sync/v1/uploads/${session.uploadId}/commit`,headers,payload:{}});
  assert.equal(committed.statusCode,200,committed.body);return committed.json();
}

test('file thumbnail honors the content-route access contract and caches by original identity',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'mote-thumbs-')),configFile=join(dir,'mote.yaml');
  writeFileSync(configFile,serializeConfigDocument({version:1,revision:0,server:{profile:'test',token:'generated-thumbs-owner-token-1234567'},storage:{dataDir:dir},models:{deployment:{model:''}},diagnostics:{level:'silent'}}),{mode:0o600});
  const config=configFromFile(configFile);
  const {app,connections,files}=await buildApp(config,{agent:{configured:false,query:async()=>{throw Error();},close:async()=>{}}});
  t.after(async()=>{await app.close();rmSync(dir,{recursive:true,force:true});});
  const headers={authorization:`Bearer ${config.token}`};
  await app.inject({method:'POST',url:'/api/sources',headers,payload:{id:'phone',name:'Generated',kind:'local-files',deviceId:'phone',platform:'android',retention:'archive'}});

  const png=await sharp({create:{width:3000,height:2000,channels:3,background:{r:40,g:80,b:160}}}).png().toBuffer();
  const ack=await upload(app,headers,manifest(png,'image/png','photo.png','content://generated/photo'),png);

  const original=files.stream.bind(files);let reads=0;
  files.stream=((id:string,start?:number,end?:number)=>{reads++;return original(id,start,end);}) as typeof files.stream;

  const first=await app.inject({url:`/api/files/${ack.id}/thumbnail`,headers});
  assert.equal(first.statusCode,200,first.body);assert.match(String(first.headers['content-type']),/^image\/jpeg/);
  const meta=await sharp(first.rawPayload).metadata();
  assert.ok(Math.max(meta.width!,meta.height!)<=480,`longest edge ${meta.width}x${meta.height}`);

  const second=await app.inject({url:`/api/files/${ack.id}/thumbnail`,headers});
  assert.equal(second.statusCode,200);assert.equal(reads,1,'second request must reuse the cached thumbnail');
  assert.deepEqual(second.rawPayload,first.rawPayload);

  const inventory=(await app.inject({url:'/api/features',headers})).json();
  assert.ok(inventory.capabilities.some((c:any)=>c.id==='http:GET:/api/files/:id/thumbnail'));

  const text=Buffer.from('generated plain text'),textAck=await upload(app,headers,manifest(text,'text/plain','note.txt','content://generated/note'),text);
  assert.equal((await app.inject({url:`/api/files/${textAck.id}/thumbnail`,headers})).statusCode,404);

  const big=Buffer.alloc(32*1024*1024+1,9),bigAck=await upload(app,headers,manifest(big,'image/png','huge.png','content://generated/huge'),big);
  assert.equal((await app.inject({url:`/api/files/${bigAck.id}/thumbnail`,headers})).statusCode,413);

  assert.equal((await app.inject({url:`/api/files/${ack.id}/thumbnail`})).statusCode,(await app.inject({url:`/api/files/${ack.id}/content`})).statusCode);
  assert.equal((await app.inject({url:`/api/files/${ack.id}/thumbnail?deviceId=other`,headers})).statusCode,(await app.inject({url:`/api/files/${ack.id}/content?deviceId=other`,headers})).statusCode);

  const {invitation}=connections.invite({label:'Generated device',serverUrl:'http://127.0.0.1:57569',deviceId:'other'});
  const device=await connections.redeem({code:invitation.code,deviceId:'other',deviceName:'Generated',platform:'android'});
  const deviceHeaders={authorization:`Bearer ${device.token}`};
  assert.equal((await app.inject({url:`/api/files/${ack.id}/thumbnail`,headers:deviceHeaders})).statusCode,(await app.inject({url:`/api/files/${ack.id}/content`,headers:deviceHeaders})).statusCode);
  await connections.revoke(device.credentialId);
  assert.equal((await app.inject({url:`/api/files/${ack.id}/thumbnail`,headers:deviceHeaders})).statusCode,(await app.inject({url:`/api/files/${ack.id}/content`,headers:deviceHeaders})).statusCode);

  await app.inject({method:'DELETE',url:`/api/files/${ack.id}`,headers});
  assert.equal((await app.inject({url:`/api/files/${ack.id}/thumbnail`,headers})).statusCode,(await app.inject({url:`/api/files/${ack.id}/content`,headers})).statusCode);
  assert.equal((await app.inject({url:`/api/files/${ack.id}/thumbnail`,headers})).statusCode,404);
});
