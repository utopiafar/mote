import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {mkdtemp,readFile,rm,mkdir,writeFile,readdir,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MEDIA_CATALOG,MediaAssets} from '../src/media-assets.js';

test('model download cancel retains only a partial cache; retry resumes verified bytes and publishes once',async t=>{
 const root=await mkdtemp(join(tmpdir(),'mote-model-cancel-')),original=MEDIA_CATALOG.dialogue,data=Buffer.alloc(256*1024,42);
 const files=['model.bin','config.json','tokenizer.json','vocabulary.txt','segmentation.onnx','speaker.onnx'];
 MEDIA_CATALOG.dialogue={version:'generated-cancel-fixture',files:files.map(name=>({name,size:data.length,sha256:createHash('sha256').update(data).digest('hex'),official:'https://fixture.invalid/'+name}))};
 const offsets:number[]=[];let slow=true;
 const server=createServer((req,res)=>{const offset=Number(req.headers.range?.match(/bytes=(\d+)-/)?.[1]??0);offsets.push(offset);res.writeHead(offset?206:200,{'content-length':data.length-offset,...(offset?{'content-range':`bytes ${offset}-${data.length-1}/${data.length}`}:{})});if(slow){res.write(data.subarray(offset,offset+1024));}else res.end(data.subarray(offset));});
 server.listen(0,'127.0.0.1');await once(server,'listening');const port=(server.address() as {port:number}).port,fetchOriginal=fetch;
 t.mock.method(globalThis,'fetch',(url:Parameters<typeof fetch>[0],init?:RequestInit)=>fetchOriginal(`http://127.0.0.1:${port}${new URL(String(url)).pathname}`,init));
 const assets=new MediaAssets(root);t.after(async()=>{await assets.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));MEDIA_CATALOG.dialogue=original;await rm(root,{recursive:true,force:true});});
 const controller=new AbortController(),pending=assets.installAsync('dialogue','official',controller.signal);void pending.catch(()=>{});
 for(let index=0;assets.status('dialogue').bytes===0;index++){assert.ok(index<100);await new Promise(resolve=>setTimeout(resolve,10));}
 assert.throws(()=>assets.install('dialogue'),/already running/);controller.abort();await assert.rejects(pending);
 assert.equal(assets.status('dialogue').state,'cancelled');assert.equal(assets.ready('dialogue'),false);assert.equal((await readFile(join(root,'dialogue.downloads/model.bin.part'))).length,1024);
 slow=false;await assets.installAsync('dialogue','official');assert.equal(offsets[1],1024);assert.equal(assets.ready('dialogue'),true);assert.equal(assets.status('dialogue').state,'ready');
 assert.deepEqual(await readFile(join(root,'dialogue/model.bin')),data);const requests=offsets.length;await assets.installAsync('dialogue');assert.equal(offsets.length,requests);
});

test('an interrupted response keeps its received prefix, then a fresh installer resumes the exact byte range',async t=>{
 const root=await mkdtemp(join(tmpdir(),'mote-model-interrupt-')),prior=MEDIA_CATALOG['local-image'],data=Buffer.alloc(16*1024,23);
 MEDIA_CATALOG['local-image']={version:'generated-interrupt',files:[{name:'shards/model.safetensors',size:data.length,sha256:createHash('sha256').update(data).digest('hex'),official:'https://fixture.invalid/model'}]};
 const originalFetch=fetch;let interrupt=true,released!:()=>void;const ranges:number[]=[];
 const server=createServer((req,res)=>{
  const offset=Number(req.headers.range?.match(/bytes=(\d+)-/)?.[1]??0);ranges.push(offset);
  res.writeHead(offset?206:200,{'content-length':data.length-offset,...(offset?{'content-range':`bytes ${offset}-${data.length-1}/${data.length}`}:{})});
  if(interrupt){res.write(data.subarray(0,1024));released=()=>res.destroy();}else res.end(data.subarray(offset));
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');const port=(server.address() as {port:number}).port;
 t.mock.method(globalThis,'fetch',(_url:unknown,init?:RequestInit)=>originalFetch(`http://127.0.0.1:${port}/model`,init));
 const first=new MediaAssets(root),second=new MediaAssets(root);
 t.after(async()=>{await first.close();await second.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));MEDIA_CATALOG['local-image']=prior;await rm(root,{recursive:true,force:true});});
 const pending=first.installAsync('local-image');void pending.catch(()=>{});
 for(let index=0;first.status('local-image').bytes!==1024;index++){assert.ok(index<100);await new Promise(resolve=>setTimeout(resolve,10));}
 assert.throws(()=>second.install('local-image'),{statusCode:409},'another instance cannot race publication into the same directory');
 const child=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',`import {MediaAssets} from ${JSON.stringify(fileURLToPath(new URL('../src/media-assets.ts',import.meta.url)))};try{await new MediaAssets(${JSON.stringify(root)}).importBundle('local-image',${JSON.stringify(root)});process.exitCode=1;}catch(error){console.info(error.statusCode);process.exitCode=error.statusCode===409?0:1;}`],{encoding:'utf8',timeout:10_000});
 assert.equal(child.status,0,child.stderr||child.stdout);assert.equal(child.stdout.trim(),'409','the real offline import process cannot race Central either');
 released();await assert.rejects(pending);assert.equal(first.status('local-image').state,'failed');
 assert.equal(first.ready('local-image'),false);assert.equal((await readFile(join(root,'local-image.downloads/shards/model.safetensors.part'))).length,1024);
 interrupt=false;await second.installAsync('local-image');assert.deepEqual(ranges,[0,1024]);assert.equal(second.ready('local-image'),true);
 assert.deepEqual(await readFile(join(second.path('local-image'),'shards/model.safetensors')),data);
});

test('close cancels an import during verification, excludes competing installs, and leaves other roles intact',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'mote-model-import-cancel-')),bundle=join(directory,'bundle'),root=join(directory,'models'),prior={...MEDIA_CATALOG};
 const data=Buffer.alloc(64*1024,31),hash=createHash('sha256').update(data).digest('hex');
 for(const role of ['ocr','dialogue','local-image'] as const)MEDIA_CATALOG[role]={version:'generated-import-'+role,files:[{name:'model.bin',size:data.length,sha256:hash,official:'https://fixture.invalid/model'}]};
 await mkdir(bundle);await writeFile(join(bundle,'model.bin'),data);
 const assets=new MediaAssets(root);await assets.importBundle('ocr',bundle);await assets.importBundle('dialogue',bundle);
 let began!:()=>void,release!:()=>void;const started=new Promise<void>(resolve=>began=resolve),gate=new Promise<void>(resolve=>release=resolve),read=fs.createReadStream;
 t.mock.method(fs,'createReadStream',((...args:Parameters<typeof fs.createReadStream>)=>{
  const stream=read(...args),iterate=stream[Symbol.asyncIterator].bind(stream);
  if(String(args[0]).includes('local-image.downloads')){stream.on('error',()=>{});stream[Symbol.asyncIterator]=async function*(){began();await gate;yield* iterate();};}
  return stream;
 }) as typeof fs.createReadStream);syncBuiltinESMExports();
 t.after(async()=>{release();await assets.close();t.mock.restoreAll();syncBuiltinESMExports();Object.assign(MEDIA_CATALOG,prior);await rm(directory,{recursive:true,force:true});});
 const pending=assets.importBundle('local-image',bundle);void pending.catch(()=>{});await started;
 assert.equal(assets.status('local-image').state,'verifying');
 assert.throws(()=>assets.install('local-image'),{statusCode:409});assert.throws(()=>assets.importBundle('local-image',bundle),{statusCode:409});
 const closing=assets.close();release();await closing;await assert.rejects(pending);
 assert.equal(assets.status('local-image').state,'cancelled');assert.equal(assets.ready('local-image'),false);
 for(const role of ['ocr','dialogue'] as const){assert.equal(assets.ready(role),true);assert.deepEqual(await readFile(join(assets.path(role),'model.bin')),data);}
 assert.deepEqual((await readdir(join(root,'local-image.downloads'))).filter(name=>name.endsWith('.import')),[]);
 t.mock.restoreAll();syncBuiltinESMExports();
 const next=new MediaAssets(root);t.after(()=>next.close());await next.importBundle('local-image',bundle);assert.equal(next.ready('local-image'),true);
});

test('a mismatched HTTP resume range cannot append bytes or publish a model',async t=>{
 const root=await mkdtemp(join(tmpdir(),'mote-model-range-')),prior=MEDIA_CATALOG['local-image'],data=Buffer.from('Generated range validation model');
 MEDIA_CATALOG['local-image']={version:'generated-range',files:[{name:'model.bin',size:data.length,sha256:createHash('sha256').update(data).digest('hex'),official:'https://fixture.invalid/model'}]};
 await mkdir(join(root,'local-image.downloads'));await writeFile(join(root,'local-image.downloads/model.bin.part'),data.subarray(0,4));
 t.mock.method(globalThis,'fetch',async()=>new Response(data.subarray(4),{status:206,headers:{'content-range':`bytes 0-${data.length-5}/${data.length}`}}));
 const assets=new MediaAssets(root);t.after(async()=>{await assets.close();MEDIA_CATALOG['local-image']=prior;await rm(root,{recursive:true,force:true});});
 await assert.rejects(assets.installAsync('local-image'),/Invalid model range/);assert.equal(assets.ready('local-image'),false);
 assert.equal(assets.status('local-image').state,'failed');await assert.rejects(readFile(join(root,'local-image.downloads/model.bin.part')),{code:'ENOENT'});
});

test('a process exit after install admission leaves a recoverable lock and cannot manufacture ready files',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'mote-model-dead-installer-')),root=join(directory,'models'),bundle=join(directory,'bundle'),prior=MEDIA_CATALOG['local-image'],data=Buffer.from('Generated process restart model');
 const catalog={version:'generated-dead-installer',files:[{name:'model.bin',size:data.length,sha256:createHash('sha256').update(data).digest('hex'),official:'https://fixture.invalid/model'}]};
 MEDIA_CATALOG['local-image']=catalog;await mkdir(bundle);await writeFile(join(bundle,'model.bin'),data);
 const child=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',`import {MediaAssets,MEDIA_CATALOG} from ${JSON.stringify(fileURLToPath(new URL('../src/media-assets.ts',import.meta.url)))};MEDIA_CATALOG['local-image']=${JSON.stringify(catalog)};void new MediaAssets(${JSON.stringify(root)}).importBundle('local-image',${JSON.stringify(bundle)});process.exit(0);`],{encoding:'utf8',timeout:10_000});
 assert.equal(child.status,0,child.stderr);assert.match(await readFile(join(root,'local-image.install.lock'),'utf8'),/^\d+$/);
 const assets=new MediaAssets(root);t.after(async()=>{await assets.close();MEDIA_CATALOG['local-image']=prior;await rm(directory,{recursive:true,force:true});});
 assert.equal(assets.ready('local-image'),false);await assets.importBundle('local-image',bundle);assert.equal(assets.ready('local-image'),true);
 await assert.rejects(readFile(join(root,'local-image.install.lock')),{code:'ENOENT'});
});

test('a dangling partial-file symlink cannot create a file outside the managed cache',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'mote-model-partial-link-')),root=join(directory,'models'),outside=join(directory,'outside-created'),prior=MEDIA_CATALOG['local-image'],data=Buffer.from('Generated symlink guard');
 MEDIA_CATALOG['local-image']={version:'generated-partial-link',files:[{name:'model.bin',size:data.length,sha256:createHash('sha256').update(data).digest('hex'),official:'https://fixture.invalid/model'}]};
 await mkdir(join(root,'local-image.downloads'),{recursive:true});await symlink(outside,join(root,'local-image.downloads/model.bin.part'));
 let requests=0;t.mock.method(globalThis,'fetch',async()=>{requests++;return new Response(data);});
 const assets=new MediaAssets(root);t.after(async()=>{await assets.close();MEDIA_CATALOG['local-image']=prior;await rm(directory,{recursive:true,force:true});});
 await assert.rejects(assets.installAsync('local-image'),/Invalid model partial file/);
 assert.equal(requests,0);assert.equal(assets.ready('local-image'),false);await assert.rejects(readFile(outside),{code:'ENOENT'});
});
