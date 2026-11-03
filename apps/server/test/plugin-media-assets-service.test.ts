import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PluginHost} from '@mote/plugin-host';
import type {ScopeIdentity,ServiceBinding} from '@mote/plugin-api/contracts';
import {MEDIA_CATALOG} from '../src/media-assets.js';
import {centralServices} from '../src/plugins/central-contracts.js';
import {createMediaAssetsService,createMediaAssetsServiceFactory,mediaAssetsServiceContribution,mediaAssetsServiceDeclaration,mediaAssetsServiceReplacement} from '../src/plugins/media-assets-service.js';

// Generated single-file model: the speaker role verifies speaker.onnx plus the
// complete.json version marker, with no archive extraction on the install path.
async function fixture(t:any,data=Buffer.alloc(64*1024,9)){
  const original=MEDIA_CATALOG['speaker-wespeaker'];
  MEDIA_CATALOG['speaker-wespeaker']={version:'generated-plugin-fixture',files:[{name:'speaker.onnx',size:data.length,sha256:createHash('sha256').update(data).digest('hex'),official:'https://fixture.invalid/speaker.onnx'}]};
  const root=await mkdtemp(join(tmpdir(),'mote-media-assets-service-')),offsets:number[]=[];let slow=true;
  const server=createServer((req,res)=>{const offset=Number(req.headers.range?.match(/bytes=(\d+)-/)?.[1]??0);offsets.push(offset);res.writeHead(offset?206:200,{'content-length':data.length-offset,...(offset?{'content-range':`bytes ${offset}-${data.length-1}/${data.length}`}:{})});if(slow){res.write(data.subarray(offset,offset+1024));}else res.end(data.subarray(offset));});
  server.listen(0,'127.0.0.1');await once(server,'listening');const port=(server.address() as {port:number}).port,fetchOriginal=fetch;
  t.mock.method(globalThis,'fetch',(url:Parameters<typeof fetch>[0],init?:RequestInit)=>fetchOriginal(`http://127.0.0.1:${port}${new URL(String(url)).pathname}`,init));
  t.after(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));MEDIA_CATALOG['speaker-wespeaker']=original;await rm(root,{recursive:true,force:true});});
  return {root,data,offsets,setSlow:(value:boolean)=>{slow=value;}};
}

test('stop folds an in-flight download into resumable cache and a fresh activation resumes to ready',async t=>{
  const f=await fixture(t);
  const first=createMediaAssetsService({root:f.root});t.after(()=>first.close());
  assert.throws(()=>first.assetsRead.status('speaker-wespeaker'),{statusCode:503});
  assert.throws(()=>first.assetsForAssembly,{statusCode:503});
  first.prepare();first.start();
  const assets=first.assetsForAssembly;
  const pending=assets.installAsync('speaker-wespeaker','official');void pending.catch(()=>{});
  for(let index=0;assets.status('speaker-wespeaker').bytes===0;index++){assert.ok(index<100);await new Promise(resolve=>setTimeout(resolve,10));}
  await first.quiesce('disabled');
  assert.throws(()=>assets.install('speaker-wespeaker'),{statusCode:503},'a quiesced plugin must not admit new installs');
  assert.throws(()=>assets.installAsync('speaker-wespeaker','official'),{statusCode:503});
  assert.throws(()=>assets.importBundle('speaker-wespeaker',f.root),{statusCode:503});
  assert.equal(first.assetsRead.status('speaker-wespeaker').state,'downloading','accepted work still reports during quiesce');
  await first.stop('disabled');await assert.rejects(pending);
  assert.equal(assets.status('speaker-wespeaker').state,'cancelled');
  assert.equal((await readFile(join(f.root,'speaker-wespeaker.downloads','speaker.onnx.part'))).length,1024,'the partial download folds into the resumable cache');

  f.setSlow(false);
  const second=createMediaAssetsService({root:f.root});t.after(()=>second.close());
  second.prepare();second.start();
  await second.assetsForAssembly.installAsync('speaker-wespeaker','official');
  assert.equal(f.offsets.at(-1),1024,'the retry resumes from the verified cache offset');
  assert.equal(second.assetsForAssembly.ready('speaker-wespeaker'),true);
  assert.equal(second.assetsRead.status('speaker-wespeaker').state,'ready');
  assert.deepEqual(await readFile(join(f.root,'speaker-wespeaker','speaker.onnx')),f.data);
});

test('a version or metadata mismatch never reports ready and a failed re-install keeps verified bytes',async t=>{
  const f=await fixture(t);f.setSlow(false);
  const service=createMediaAssetsService({root:f.root});t.after(()=>service.close());
  service.prepare();service.start();
  const assets=service.assetsForAssembly;
  await assets.installAsync('speaker-wespeaker','official');
  assert.equal(assets.ready('speaker-wespeaker'),true);
  MEDIA_CATALOG['speaker-wespeaker']={version:'generated-plugin-fixture-v2',files:[{name:'speaker.onnx',size:f.data.length,sha256:'0'.repeat(64),official:'https://fixture.invalid/speaker.onnx'}]};
  assert.equal(assets.ready('speaker-wespeaker'),false,'metadata changes invalidate the verified marker');
  await assert.rejects(assets.installAsync('speaker-wespeaker','official'));
  const status=assets.status('speaker-wespeaker');
  assert.equal(status.state,'failed');assert.equal(status.error,'model_install_failed','a checksum mismatch stays observable');
  assert.equal(assets.ready('speaker-wespeaker'),false,'a failed install must not report ready');
  assert.deepEqual(await readFile(join(f.root,'speaker-wespeaker','speaker.onnx')),f.data,'the previously verified asset is never overwritten');
});

test('media-assets-service factory publishes only the read-only state port and revokes it with the host scope',async t=>{
  const f=await fixture(t);
  const host=new PluginHost({kind:'central',id:'generated-host'}),identity:ScopeIdentity={packageId:'generated.media',installationId:'generated-install',instanceId:'generated-media',activationId:'generated-activation',host:{kind:'central',id:'generated-host'}};
  let binding:ServiceBinding|undefined;
  t.after(async()=>{await host.close();});
  const factory=createMediaAssetsServiceFactory({root:f.root});
  await host.install({identity,contributions:[mediaAssetsServiceDeclaration],factory:context=>factory({...context,provide:(id,contract,value,revision)=>{
    const created=context.provide(id,contract,value,revision);
    if(contract.id===centralServices.mediaAssetsRead.id)binding=created;
    return created;
  }})});
  const lease=await host.acquire(centralServices.mediaAssetsRead,binding!),port=lease.value;
  assert.deepEqual(Object.keys(port).sort(),['ready','status','statuses']);
  assert.equal(port.ready('speaker-wespeaker'),false);
  assert.equal(port.status('speaker-wespeaker').state,'not_installed');
  assert.equal(port.statuses()['speaker-wespeaker'].version,'generated-plugin-fixture');
  assert.deepEqual(mediaAssetsServiceContribution.provides.map(service=>service.id),[centralServices.mediaAssetsRead.id]);
  assert.equal(mediaAssetsServiceReplacement,'hot');
  await host.close();
  assert.throws(()=>port.ready('speaker-wespeaker'));
});
