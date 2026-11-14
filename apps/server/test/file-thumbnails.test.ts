import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {get as httpGet} from 'node:http';
import sharp from 'sharp';
import {FILE_PART_BYTES,type FileRevision} from '@mote/shared';
import {sha256} from '../src/store.js';
import {buildApp} from '../src/app.js';
import {configFromFile} from '../src/config.js';
import {serializeConfigDocument} from '@mote/shared/config-file';
import {FILE_THUMBNAIL_MAX_CONCURRENT} from '../src/file-thumbnails.js';

function manifest(bytes:Buffer,mimeType:string,title:string,externalId:string,revision='v1',previousRevision:string|null=null):FileRevision{
  return {sourceId:'phone',previousRevision,item:{externalId,revision,observedAt:new Date().toISOString(),title,kind:'file',layer:'original',text:'',mimeType,deleted:false},relativePath:'generated/'+title,sizeBytes:bytes.length,sha256:sha256(bytes)};
}

async function upload(app:any,headers:any,input:FileRevision,bytes:Buffer){
  const started=await app.inject({method:'POST',url:'/api/file-sync/v1/uploads',headers,payload:input});
  assert.equal(started.statusCode,200,started.body);const session=started.json();
  if(session.ack){
    assert.equal(session.ack.sha256,input.sha256);assert.equal(session.ack.sizeBytes,bytes.length);
    return session.ack;
  }
  for(let n=0;n<Math.ceil(bytes.length/FILE_PART_BYTES);n++)
    assert.equal((await app.inject({method:'PUT',url:`/api/file-sync/v1/uploads/${session.uploadId}/parts/${n}`,headers:{...headers,'content-type':'application/octet-stream'},payload:bytes.subarray(n*FILE_PART_BYTES,(n+1)*FILE_PART_BYTES)})).statusCode,200);
  const committed=await app.inject({method:'POST',url:`/api/file-sync/v1/uploads/${session.uploadId}/commit`,headers,payload:{}});
  assert.equal(committed.statusCode,200,committed.body);return committed.json();
}

async function setup(t:any){
  const dir=mkdtempSync(join(tmpdir(),'mote-thumbs-')),configFile=join(dir,'mote.yaml');
  writeFileSync(configFile,serializeConfigDocument({version:1,revision:0,server:{profile:'test',token:'generated-thumbs-owner-token-1234567'},storage:{dataDir:dir},models:{deployment:{model:''}},diagnostics:{level:'silent'}}),{mode:0o600});
  const config=configFromFile(configFile);
  const {app,connections,files}=await buildApp(config,{agent:{configured:false,query:async()=>{throw Error();},close:async()=>{}}});
  t.after(async()=>{await app.close();rmSync(dir,{recursive:true,force:true});});
  const headers={authorization:`Bearer ${config.token}`};
  await app.inject({method:'POST',url:'/api/sources',headers,payload:{id:'phone',name:'Generated',kind:'local-files',deviceId:'phone',platform:'android',retention:'archive'}});
  return {app,connections,files,headers};
}

/** Wraps files.stream so each original read suspends on control.gate at 'start' (before any byte)
 * or 'end' (after the last byte is delivered). control is mutable so one wrap serves several holds. */
function gateOriginalReads(files:any,control:{position:'start'|'end';gate:Promise<void>}){
  const original=files.stream.bind(files);
  const stats={byId:new Map<string,number>(),live:0,peak:0,held:0};
  files.stream=((id:string,start?:number,end?:number)=>{
    stats.byId.set(id,(stats.byId.get(id)??0)+1);stats.live++;stats.peak=Math.max(stats.peak,stats.live);
    const real=original(id,start,end);
    return Readable.from((async function*(){
      try{
        if(control.position==='start'){stats.held++;await control.gate;}
        for await(const chunk of real)yield chunk;
        if(control.position==='end'){stats.held++;await control.gate;}
      }finally{stats.live--;}
    })());
  }) as typeof files.stream;
  return {stats,restore:()=>{files.stream=original;}};
}

const defer=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return{promise,resolve};};
async function until(condition:()=>boolean,what:string){const deadline=Date.now()+10000;while(!condition()){assert.ok(Date.now()<deadline,'timed out waiting for '+what);await new Promise(r=>setTimeout(r,10));}}

test('file thumbnail honors the content-route access contract and caches by original identity',async t=>{
  const {app,connections,files,headers}=await setup(t);

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

test('file thumbnail applies EXIF orientation before resizing',async t=>{
  const {app,headers}=await setup(t);

  const rotated=await sharp({create:{width:3000,height:2000,channels:3,background:{r:40,g:80,b:160}}}).jpeg().withMetadata({orientation:6}).toBuffer();
  const rotatedAck=await upload(app,headers,manifest(rotated,'image/jpeg','rotated.jpg','content://generated/rotated'),rotated);
  const rotatedRes=await app.inject({url:`/api/files/${rotatedAck.id}/thumbnail`,headers});
  assert.equal(rotatedRes.statusCode,200,rotatedRes.body);
  const rotatedMeta=await sharp(rotatedRes.rawPayload).metadata();
  assert.equal(Math.max(rotatedMeta.width!,rotatedMeta.height!),480);
  assert.ok(rotatedMeta.height!>rotatedMeta.width!,`orientation 6 must produce a portrait thumbnail, got ${rotatedMeta.width}x${rotatedMeta.height}`);

  const width=600,height=400,raster=Buffer.alloc(width*height*3);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){const i=(y*width+x)*3;if(x<width/2){raster[i]=220;raster[i+1]=20;raster[i+2]=20;}else{raster[i]=20;raster[i+1]=20;raster[i+2]=220;}}
  const mirrored=await sharp(raster,{raw:{width,height,channels:3}}).jpeg().withMetadata({orientation:2}).toBuffer();
  const mirroredAck=await upload(app,headers,manifest(mirrored,'image/jpeg','mirrored.jpg','content://generated/mirrored'),mirrored);
  const mirroredRes=await app.inject({url:`/api/files/${mirroredAck.id}/thumbnail`,headers});
  assert.equal(mirroredRes.statusCode,200,mirroredRes.body);
  const mirroredMeta=await sharp(mirroredRes.rawPayload).metadata();
  const left=await sharp(mirroredRes.rawPayload).extract({left:0,top:0,width:20,height:mirroredMeta.height!}).resize(1,1).raw().toBuffer();
  const right=await sharp(mirroredRes.rawPayload).extract({left:mirroredMeta.width!-20,top:0,width:20,height:mirroredMeta.height!}).resize(1,1).raw().toBuffer();
  assert.ok(left[2]>left[0]+50,`EXIF flip must put the blue half on the left, got ${Array.from(left)}`);
  assert.ok(right[0]>right[2]+50,`EXIF flip must put the red half on the right, got ${Array.from(right)}`);
});

test('file thumbnail rejects originals whose decoded format does not match the declared image type',async t=>{
  const {app,headers}=await setup(t);
  const png=await sharp({create:{width:64,height:32,channels:3,background:{r:10,g:20,b:30}}}).png().toBuffer();
  const jpeg=await sharp({create:{width:64,height:32,channels:3,background:{r:10,g:20,b:30}}}).jpeg().toBuffer();
  const tiff=await sharp({create:{width:64,height:32,channels:3,background:{r:10,g:20,b:30}}}).tiff().toBuffer();
  const svg=Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="32"><rect width="64" height="32" fill="#0a141e"/></svg>');
  for(const [bytes,mime,title]of[[jpeg,'image/png','jpeg-as-png.png'],[tiff,'image/png','tiff-as-png.png'],[svg,'image/png','svg-as-png.png'],[png,'image/jpeg','png-as-jpeg.jpg']]as[Buffer,string,string][]){
    const ack=await upload(app,headers,manifest(bytes,mime,title,'content://generated/'+title),bytes);
    const res=await app.inject({url:`/api/files/${ack.id}/thumbnail`,headers});
    assert.equal(res.statusCode,404,`${title} must not render, got ${res.statusCode}`);
  }
  const okAck=await upload(app,headers,manifest(png,'image/png','declared-png.png','content://generated/declared-png'),png);
  assert.equal((await app.inject({url:`/api/files/${okAck.id}/thumbnail`,headers})).statusCode,200,'a matching PNG must still render');
});

test('file thumbnail shares same-original misses and bounds concurrent renders',async t=>{
  const {app,files,headers}=await setup(t);
  const ids:string[]=[];
  for(let n=0;n<5;n++){
    const png=await sharp({create:{width:40+n,height:30,channels:3,background:{r:20+n*30,g:40,b:60}}}).png().toBuffer();
    ids.push((await upload(app,headers,manifest(png,'image/png',`miss-${n}.png`,`content://generated/miss-${n}`),png)).id);
  }
  const control:{position:'start'|'end';gate:Promise<void>}={position:'start',gate:Promise.resolve()};
  const {stats,restore}=gateOriginalReads(files,control);
  t.after(restore);
  const gate=defer();control.gate=gate.promise;

  const pending=[ids[0],ids[0],ids[0],ids[1],ids[2],ids[3],ids[4]].map(id=>app.inject({url:`/api/files/${id}/thumbnail`,headers}));
  await until(()=>stats.held>=FILE_THUMBNAIL_MAX_CONCURRENT,'render slots to fill');
  await new Promise(r=>setTimeout(r,150));
  assert.equal(stats.held,FILE_THUMBNAIL_MAX_CONCURRENT,'queued misses must wait for a render slot before reading originals');
  assert.equal(stats.byId.get(ids[0]),1,'concurrent misses for one original share a single read+render');
  gate.resolve();
  const responses=await Promise.all(pending);
  for(const res of responses)assert.equal(res.statusCode,200,res.body);
  assert.deepEqual(responses[1].rawPayload,responses[0].rawPayload);
  assert.deepEqual(responses[2].rawPayload,responses[0].rawPayload);
  assert.equal(stats.byId.size,5,'every distinct original renders exactly once');
  assert.equal(stats.peak,FILE_THUMBNAIL_MAX_CONCURRENT,'never more than the render limit read originals at once');
});

test('file thumbnail re-checks access when a held render finishes after revocation or deletion',async t=>{
  const {app,connections,files,headers}=await setup(t);
  const png=await sharp({create:{width:800,height:600,channels:3,background:{r:60,g:120,b:180}}}).png().toBuffer();
  const ack=await upload(app,headers,manifest(png,'image/png','held.png','content://generated/held'),png);
  // An owner-scoped device credential can reach this route while active; collector
  // credentials are rejected by the ingress route allowlist before the handler runs.
  const {invitation}=connections.invite({label:'Generated device',serverUrl:'http://127.0.0.1:57569',deviceId:'phone'});
  const device=await connections.redeem({code:invitation.code,deviceId:'phone',deviceName:'Generated',platform:'android'});
  const deviceHeaders={authorization:`Bearer ${device.token}`};

  const control:{position:'start'|'end';gate:Promise<void>}={position:'end',gate:Promise.resolve()};
  const {stats,restore}=gateOriginalReads(files,control);
  t.after(restore);

  const revoked=defer();control.gate=revoked.promise;
  const heldRequest=app.inject({url:`/api/files/${ack.id}/thumbnail`,headers:deviceHeaders});
  await until(()=>stats.held>=1,'held render after the original was read');
  await connections.revoke(device.credentialId);
  revoked.resolve();
  const heldResponse=await heldRequest;
  assert.equal(heldResponse.statusCode,(await app.inject({url:`/api/files/${ack.id}/content`,headers:deviceHeaders})).statusCode);
  assert.notEqual(heldResponse.statusCode,200,'a revoked credential must not receive the rendered JPEG');
  assert.doesNotMatch(String(heldResponse.headers['content-type']),/image\/jpeg/);

  const png2=await sharp({create:{width:700,height:500,channels:3,background:{r:120,g:60,b:30}}}).png().toBuffer();
  const ack2=await upload(app,headers,manifest(png2,'image/png','held-again.png','content://generated/held-again'),png2);
  const removed=defer();control.gate=removed.promise;
  const deleteRequest=app.inject({url:`/api/files/${ack2.id}/thumbnail`,headers});
  await until(()=>stats.held>=2,'second held render after the original was read');
  assert.equal((await app.inject({method:'DELETE',url:`/api/files/${ack2.id}`,headers})).statusCode,200);
  removed.resolve();
  const deleteResponse=await deleteRequest;
  assert.equal(deleteResponse.statusCode,(await app.inject({url:`/api/files/${ack2.id}/content`,headers})).statusCode);
  assert.equal(deleteResponse.statusCode,404,'a deleted original must not return the rendered JPEG');
});

test('file thumbnail re-checks each requester after a held render fails',async t=>{
  const {app,connections,files,headers}=await setup(t);
  const oversized=await sharp({create:{width:5000,height:5000,channels:3,background:'#123456'}}).png().toBuffer();
  const samples=[['malformed',Buffer.from('not a PNG')],['over-pixel-limit',oversized]] as const;
  const control:{position:'start'|'end';gate:Promise<void>}={position:'end',gate:Promise.resolve()};
  const {stats,restore}=gateOriginalReads(files,control);
  try{
    for(const [name,bytes] of samples){
      const ack=await upload(app,headers,manifest(bytes,'image/png',name+'.png','content://generated/'+name),bytes);
      const {invitation}=connections.invite({label:'Generated device',serverUrl:'http://127.0.0.1:57569',deviceId:'phone'});
      const device=await connections.redeem({code:invitation.code,deviceId:'phone',deviceName:'Generated',platform:'android'});
      const deviceHeaders={authorization:`Bearer ${device.token}`},gate=defer(),heldBefore=stats.held;
      control.gate=gate.promise;
      const ownerRequest=app.inject({url:`/api/files/${ack.id}/thumbnail`,headers});
      const deviceRequest=app.inject({url:`/api/files/${ack.id}/thumbnail`,headers:deviceHeaders});
      try{
        await until(()=>stats.held>heldBefore,'failed image read held before decode');
        await connections.revoke(device.credentialId);
      }finally{gate.resolve();}
      const [ownerResponse,deviceResponse]=await Promise.all([ownerRequest,deviceRequest]);
      assert.equal(ownerResponse.statusCode,404,name+' retains the decode error for the authorized owner');
      const content=await app.inject({url:`/api/files/${ack.id}/content`,headers:deviceHeaders});
      assert.equal(content.statusCode,401);
      assert.equal(deviceResponse.statusCode,content.statusCode,name+' must return current authorization failure');
      assert.doesNotMatch(String(deviceResponse.headers['content-type']),/image\/jpeg/);
      assert.equal(stats.byId.get(ack.id),1,'both requesters share the failing render');
    }
  }finally{restore();}
});

test('file thumbnail keeps black marks visible on transparent PNG, WebP and GIF originals',async t=>{
  const {app,headers}=await setup(t);
  const width=120,height=80,rgba=Buffer.alloc(width*height*4);
  for(let y=20;y<60;y++)for(let x=40;x<80;x++)rgba[(y*width+x)*4+3]=255;
  for(const format of ['png','webp','gif'] as const){
    const bytes=await sharp(rgba,{raw:{width,height,channels:4}}).toFormat(format).toBuffer();
    const ack=await upload(app,headers,manifest(bytes,'image/'+format,'mark.'+format,'content://generated/mark.'+format),bytes);
    const response=await app.inject({url:`/api/files/${ack.id}/thumbnail`,headers});
    assert.equal(response.statusCode,200,response.body);
    const {data,info}=await sharp(response.rawPayload).raw().toBuffer({resolveWithObject:true});
    const pixel=(x:number,y:number)=>Array.from(data.subarray((y*info.width+x)*info.channels,(y*info.width+x)*info.channels+3));
    assert.ok(pixel(10,10).every(v=>v>235),format+' transparent background must become light');
    assert.ok(pixel(60,40).every(v=>v<20),format+' black mark must remain dark and visible');
  }
});

function thumbnailOverTcp(base:string,id:string,headers:Record<string,string>){
  let cancel!:()=>void;
  const response=new Promise<{status:number;bytes:Buffer}|null>((resolve,reject)=>{
    let cancelled=false;
    const request=httpGet(`${base}/api/files/${id}/thumbnail`,{headers,agent:false},res=>{
      const parts:Buffer[]=[];
      res.on('data',part=>parts.push(part));
      res.on('end',()=>resolve({status:res.statusCode!,bytes:Buffer.concat(parts)}));
      res.on('error',error=>cancelled?resolve(null):reject(error));
    });
    request.on('error',error=>cancelled?resolve(null):reject(error));
    cancel=()=>{cancelled=true;request.destroy();};
  });
  return {response,cancel};
}

test('file thumbnail discards disconnected queued HTTP work and retains coalesced live requesters',async t=>{
  const {app,files,headers}=await setup(t);
  const ids:string[]=[];
  for(let n=0;n<12;n++){
    const bytes=await sharp({create:{width:40+n,height:30,channels:3,background:'#123456'}}).png().toBuffer();
    ids.push((await upload(app,headers,manifest(bytes,'image/png',`tcp-${n}.png`,`content://generated/tcp-${n}`),bytes)).id);
  }
  const base=await app.listen({host:'127.0.0.1',port:0});
  const seen=new Map<string,number>(),closed=new Map<string,number>();
  const observe=(req:any,res:any)=>{
    const id=req.url.split('/')[3];seen.set(id,(seen.get(id)??0)+1);
    res.once('close',()=>closed.set(id,(closed.get(id)??0)+1));
  };
  app.server.on('request',observe);
  const blockers=defer(),later=defer();
  const control:{position:'start'|'end';gate:Promise<void>}={position:'start',gate:blockers.promise};
  const {stats,restore}=gateOriginalReads(files,control);
  const clients:ReturnType<typeof thumbnailOverTcp>[]=[];
  const request=(id:string)=>{const client=thumbnailOverTcp(base,id,headers);clients.push(client);return client;};
  try{
    const active=ids.slice(0,4).map(request);
    await until(()=>stats.held===4,'four active TCP renders');
    control.gate=later.promise;
    const abandonedIds=ids.slice(4,10),abandoned=abandonedIds.map(request);
    const sharedGone=request(ids[10]),sharedLive=request(ids[10]);
    await until(()=>abandonedIds.every(id=>seen.has(id))&&seen.get(ids[10])===2,'all queued HTTP requests to reach the server');
    assert.equal(stats.byId.size,4,'queued requests must not read originals');
    for(const client of [...abandoned,sharedGone])client.cancel();
    await until(()=>abandonedIds.every(id=>closed.has(id))&&closed.get(ids[10])===1,'server observes actual TCP disconnects');
    const visible=request(ids[11]),retry=request(abandonedIds[0]);
    await until(()=>seen.has(ids[11])&&seen.get(abandonedIds[0])===2,'new visible requests arrive');
    blockers.resolve();
    await until(()=>stats.byId.has(ids[11])&&stats.byId.has(abandonedIds[0])&&stats.byId.has(ids[10]),'visible and shared requests get freed slots');
    for(const id of abandonedIds.slice(1))assert.equal(stats.byId.has(id),false,'disconnected job must never read its original');
    assert.equal(stats.byId.get(ids[10]),1,'one disconnect must retain work for its live coalesced requester');
    assert.equal(stats.byId.get(abandonedIds[0]),1,'a fresh requester can recreate an abandoned job');
    assert.ok(stats.peak<=FILE_THUMBNAIL_MAX_CONCURRENT,'TCP lifecycle keeps the four-render limit');
    later.resolve();
    for(const result of await Promise.all([...active,sharedLive,visible,retry].map(client=>client.response)))assert.equal(result?.status,200);
    // After draining the queue, a new distinct miss must still have a usable slot.
    const extra=await sharp({create:{width:55,height:20,channels:3,background:'#abcdef'}}).png().toBuffer();
    const extraAck=await upload(app,headers,manifest(extra,'image/png','after-drain.png','content://generated/after-drain'),extra);
    assert.equal((await request(extraAck.id).response)?.status,200);
  }finally{
    blockers.resolve();later.resolve();
    for(const client of clients)client.cancel();
    await Promise.allSettled(clients.map(client=>client.response));
    app.server.off('request',observe);restore();
  }
});
