import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {execFileSync} from 'node:child_process';
import {mkdtemp,rm,mkdir,writeFile,readFile,symlink,readdir,link,utimes,chmod,rename} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {MEDIA_MODEL_PATHS,MEDIA_MODEL_COMPONENT_PATHS,mediaAssetStatusSchema} from '@mote/shared';
import {FUNASR_MODEL_IDS,FUNASR_SDK_WHEEL_SHA256} from '../src/funasr-contract.js';
import {MEDIA_CATALOG,MediaAssets,mediaModelIdentities} from '../src/media-assets.js';

const scripts=fileURLToPath(new URL('../../../scripts/',import.meta.url));
const engineManifest=()=>JSON.parse(execFileSync('python3',[join(scripts,'mote_funasr.py'),'--manifest'],{encoding:'utf8',timeout:30000}));

test('a clean dialogue install publishes exactly the files, sources and identities the actual engine verifies',()=>{
 const manifest=engineManifest(),catalog=MEDIA_CATALOG.dialogue;
 const files=Object.entries(manifest).flatMap(([role,value])=>{
  const model=value as {id:string;revision:string;license:string;directory:string;manifestSha256:string;files:{name:string;size:number;sha256:string;url:string}[]};
  const source=catalog.models![role];
  assert.deepEqual(source,{id:model.id,repository:model.id,revision:model.revision,license:model.license,directory:role});
  assert.equal(model.directory,`${MEDIA_MODEL_PATHS.dialogue}/${role}`);
  assert.deepEqual(mediaModelIdentities('dialogue')[role],{id:model.id,revision:model.revision,manifestSha256:model.manifestSha256});
  return model.files.map(({name,size,sha256,url})=>({name:`${role}/${name}`,size,sha256,official:url}));
 });
 const byName=(a:{name:string},b:{name:string})=>a.name.localeCompare(b.name);
 assert.deepEqual(catalog.files.toSorted(byName),files.toSorted(byName),'every installed asset, including SDK code, must be verified by the engine');
});

test('an imported generated bundle is read by the actual engine and rejects a different or corrupt model version',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'mote-catalog-engine-')),bundle=join(directory,'bundle'),description=join(directory,'manifest.json');
 const manifest=engineManifest(),prior=MEDIA_CATALOG.dialogue;
 const models:Record<string,{revision:string;license:string;files:{name:string;size:number;sha256:string}[]}>={},files=[];
 for(const [role,value] of Object.entries(manifest)){
  const model=value as {revision:string;license:string;files:{name:string}[]};
  const generated=[];
  for(const item of model.files){
   const name=`${role}/${item.name}`,bytes=Buffer.from('Generated inert model asset: '+name);
   const file={name:item.name,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
   generated.push(file);files.push({...file,name,official:'https://example.invalid/'+name});
   await mkdir(join(bundle,name,'..'),{recursive:true});await writeFile(join(bundle,name),bytes);
  }
  models[role]={revision:createHash('sha256').update('generated revision '+role).digest('hex'),license:model.license,files:generated};
 }
 MEDIA_CATALOG.dialogue={version:'generated-catalog-engine',models:Object.fromEntries(Object.entries(prior.models!).map(([role,model])=>[role,{...model,revision:models[role].revision}])),files};
 await writeFile(description,JSON.stringify(models));
 const assets=new MediaAssets(join(directory,'models'));
 t.after(async()=>{await assets.close();MEDIA_CATALOG.dialogue=prior;await rm(directory,{recursive:true,force:true});});
 await assets.importBundle('dialogue',bundle);
 const inspect=()=>JSON.parse(execFileSync('python3',['-c',[
  'import sys,json; from pathlib import Path',
  'sys.path.insert(0,sys.argv[1]); import mote_funasr as engine',
  'engine.BUNDLE=json.loads(Path(sys.argv[2]).read_text())',
  'try: print(json.dumps({"models":engine.verify_models(sys.argv[3])}))',
  'except engine.EngineError as error: print(json.dumps({"error":error.code}))',
 ].join('\n'),scripts,description,assets.path('dialogue')],{encoding:'utf8',timeout:30000}));
 assert.equal(assets.ready('dialogue'),true);
 const identity=mediaModelIdentities('dialogue');assert.deepEqual(inspect(),{models:identity});
 const asr=join(assets.path('dialogue'),'asr/model.pt'),original=await readFile(asr);
 for(const bytes of [Buffer.alloc(original.length+1),Buffer.alloc(original.length)]){
  await writeFile(asr,bytes);assert.deepEqual(inspect(),{error:'model_missing'},'the actual worker rejects both wrong-size and same-size corrupt weights');
  assert.equal(assets.ready('dialogue'),bytes.length===original.length,'host readiness is a fast file/size check; the worker owns full hashing');
 }
 await assets.importBundle('dialogue',bundle);
 models.asr.revision='0'.repeat(40);await writeFile(description,JSON.stringify(models));
 assert.notDeepEqual(inspect(),{models:identity},'a different revision cannot impersonate the installed checkpoint identity');
 await writeFile(join(bundle,'asr/model.pt'),Buffer.alloc(original.length));
 await assert.rejects(assets.importBundle('dialogue',bundle));
});

test('the fixed catalog contains both large image shards, pinned model code and all four FunASR components',()=>{
 const image=MEDIA_CATALOG['local-image'],dialogue=MEDIA_CATALOG.dialogue;
 assert.deepEqual(Object.keys(mediaModelIdentities('dialogue')).sort(),Object.keys(FUNASR_MODEL_IDS).sort());
 for(const [key,model] of Object.entries(dialogue.models!)){
  assert.equal(model.id,FUNASR_MODEL_IDS[key as keyof typeof FUNASR_MODEL_IDS]);assert.match(model.revision,/^[a-f0-9]{40,64}$/);
  assert.equal(`${MEDIA_MODEL_PATHS.dialogue}/${model.directory}`,MEDIA_MODEL_COMPONENT_PATHS.dialogue[key as keyof typeof FUNASR_MODEL_IDS]);
  assert.ok(dialogue.files.some(file=>file.name.startsWith(model.directory+'/')&&/\.(pt|bin)$/.test(file.name)));
 }
 const shards=image.files.filter(file=>file.name.endsWith('.safetensors'));
 assert.equal(shards.length,2);assert.ok(shards.some(file=>file.size>2**32),'the 14B shard must retain its full size');
 assert.ok(image.files.some(file=>file.name==='modeling_internvl_chat.py'));assert.ok(image.files.some(file=>file.name==='model.safetensors.index.json'));
 assert.ok(dialogue.files.some(file=>file.name==='asr/Qwen3-0.6B/tokenizer.json'));
 assert.ok(dialogue.files.some(file=>file.name.endsWith('.whl')&&file.sha256===FUNASR_SDK_WHEEL_SHA256));
 assert.ok(dialogue.files.every(file=>! /whisper|sherpa|segmentation\.onnx/.test(file.name)));
 for(const file of [...image.files,...dialogue.files]){
  assert.match(file.sha256,/^[a-f0-9]{64}$/);assert.ok(Number.isSafeInteger(file.size)&&file.size>0);
  assert.doesNotMatch(file.official,/\/(?:main|master)\/|Revision=(?:main|master)(?:&|$)/);assert.equal(file.mirror,undefined,'no unverified mirror is advertised');
 }
});

test('automatic dialogue installation succeeds through the mirror when the official source is unreachable',async t=>{
 const root=await mkdtemp(join(tmpdir(),'mote-model-source-')),original=MEDIA_CATALOG.dialogue,data=Buffer.from('generated model bytes');
 const names=['config.json','model.bin','tokenizer.json','vocabulary.txt','segmentation.onnx','speaker.onnx'];
 MEDIA_CATALOG.dialogue={version:'generated-source-fallback',files:names.map(name=>({name,size:data.length,sha256:createHash('sha256').update(data).digest('hex'),official:`https://huggingface.co/generated/${name}`,mirror:`https://hf-mirror.com/generated/${name}`}))};
 const hosts:string[]=[];
 t.mock.method(globalThis,'fetch',async(input:Parameters<typeof fetch>[0])=>{
  const host=new URL(String(input)).hostname;hosts.push(host);
  if(host==='huggingface.co')throw Error('official source unavailable');
  return new Response(data);
 });
 const assets=new MediaAssets(root);
 t.after(async()=>{await assets.close();MEDIA_CATALOG.dialogue=original;await rm(root,{recursive:true,force:true});});
 await assert.rejects(assets.installAsync('dialogue','official'));
 assert.equal(assets.ready('dialogue'),false);
 await assets.installAsync('dialogue','auto');
 assert.equal(assets.ready('dialogue'),true);
 assert.deepEqual([...new Set(hosts)],['huggingface.co','hf-mirror.com']);
});


// The four generated components use the actual installation/import path. No
// private model cache, download or inference is required by these regressions.
async function nestedBundle(t:import('node:test').TestContext){
 const directory=await mkdtemp(join(tmpdir(),'mote-nested-assets-')),root=join(directory,'models'),bundle=join(directory,'bundle');
 const prior=MEDIA_CATALOG.dialogue,data=Buffer.from('Generated nested model/config/code bytes.');
 const names=['asr/model.pt','asr/Qwen3-0.6B/tokenizer.json','vad/model.pt','speaker/campplus_cn_common.bin','punctuation/model.pt'];
 MEDIA_CATALOG.dialogue={version:'generated-nested-v1',files:names.map(name=>({name,size:data.length,sha256:createHash('sha256').update(data).digest('hex'),official:'https://fixture.invalid/'+name}))};
 for(const name of names){await mkdir(join(bundle,name,'..'),{recursive:true});await writeFile(join(bundle,name),data);}
 const assets=new MediaAssets(root);
 t.after(async()=>{await assets.close();MEDIA_CATALOG.dialogue=prior;await rm(directory,{recursive:true,force:true});});
 return {directory,root,bundle,assets,data,names};
}

test('a complete nested FunASR bundle imports, while every required component remains necessary for readiness',async t=>{
 const f=await nestedBundle(t);
 const installed=await f.assets.importBundle('dialogue',f.bundle);
 assert.equal(installed.state,'ready');assert.equal(installed.bytes,f.names.length*f.data.length);
 assert.equal(f.assets.ready('dialogue'),true);
 for(const name of f.names){assert.deepEqual(await readFile(join(f.assets.path('dialogue'),name)),f.data);}
 await rm(join(f.assets.path('dialogue'),'speaker/campplus_cn_common.bin'));
 assert.equal(f.assets.ready('dialogue'),false,'a stale in-memory ready status cannot hide a missing component');
 assert.equal(f.assets.status('dialogue').state,'not_installed');
});

test('missing, wrong-size and same-size wrong-hash imports fail without exposing the private source directory',async t=>{
 for(const fault of ['missing','size','hash'] as const)await t.test(fault,async child=>{
  const f=await nestedBundle(child),name=f.names[1],path=join(f.bundle,name);
  if(fault==='missing')await rm(path);else await writeFile(path,Buffer.alloc(f.data.length+(fault==='size'?1:0),0));
  await assert.rejects(f.assets.importBundle('dialogue',f.bundle));
  const status=f.assets.status('dialogue');assert.equal(status.state,'failed');assert.equal(f.assets.ready('dialogue'),false);
  assert.ok(status.error);assert.equal(JSON.stringify(status).includes(f.directory),false);
  await assert.rejects(readFile(join(f.assets.path('dialogue'),'complete.json')),{code:'ENOENT'});
 });
});

test('an import rejects symlinked component directories instead of reading files outside the bundle',async t=>{
 const f=await nestedBundle(t),outside=join(f.directory,'outside');
 await mkdir(outside);await writeFile(join(outside,'campplus_cn_common.bin'),f.data);
 await rm(join(f.bundle,'speaker'),{recursive:true});await symlink(outside,join(f.bundle,'speaker'));
 await assert.rejects(f.assets.importBundle('dialogue',f.bundle));
 assert.equal(f.assets.ready('dialogue'),false);
 assert.deepEqual(await readFile(join(outside,'campplus_cn_common.bin')),f.data);
});

test('the real worker rejects published content changes while the host rejects stale old-model markers',async t=>{
 const f=await nestedBundle(t);await f.assets.importBundle('dialogue',f.bundle);
 await writeFile(join(f.assets.path('dialogue'),f.names[0]),Buffer.alloc(f.data.length,1));
 const models=Object.fromEntries(Object.keys(FUNASR_MODEL_IDS).map(role=>[role,{revision:'generated-nested-revision',license:'generated',files:f.names.filter(name=>name.startsWith(role+'/')).map(name=>({name:name.slice(role.length+1),size:f.data.length,sha256:createHash('sha256').update(f.data).digest('hex')}))}]));
 const inspected=JSON.parse(execFileSync('python3',['-c',[
  'import json,sys;sys.path.insert(0,sys.argv[1]);import mote_funasr as engine',
  'engine.BUNDLE=json.loads(sys.argv[2])',
  'try: engine.verify_models(sys.argv[3]);print(json.dumps({"verified":True}))',
  'except engine.EngineError as error: print(json.dumps({"error":error.code}))',
 ].join('\n'),scripts,JSON.stringify(models),f.assets.path('dialogue')],{encoding:'utf8',timeout:30000}));
 assert.deepEqual(inspected,{error:'model_missing'},'same-size corruption still invalidates the actual worker verified identity');
 assert.equal(f.assets.ready('dialogue'),true,'routine host readiness does not repeatedly hash large weights');
 await f.assets.importBundle('dialogue',f.bundle);assert.equal(new MediaAssets(f.root).ready('dialogue'),true,'the published verification survives a fresh reader');
 await writeFile(join(f.assets.path('dialogue'),'complete.json'),JSON.stringify({version:MEDIA_CATALOG.dialogue.version}));
 assert.equal(f.assets.ready('dialogue'),false,'a version label alone does not prove verified assets');
});

test('correct assets survive URL, upstream, timestamp, permissions, link and inode changes without reinstalling',async t=>{
 for(const role of ['ocr','speaker-wespeaker','dialogue','local-image'] as const)await t.test(role,async child=>{
  const directory=await mkdtemp(join(tmpdir(),'mote-asset-content-')),bundle=join(directory,'bundle'),prior=MEDIA_CATALOG[role],data=Buffer.from('Generated immutable model bytes.');
  const file={name:'model.bin',size:data.length,sha256:createHash('sha256').update(data).digest('hex'),official:'https://official.fixture.invalid/model'};
  MEDIA_CATALOG[role]={version:'generated-content-'+role,files:[file],...(role==='local-image'?{models:{image:{id:'InternVL3-14B-4bit',revision:'generated-revision',license:'generated-license',directory:'.',repository:'original-repository',upstream:'https://upstream.fixture.invalid/original'}}}:{})};
  await mkdir(bundle);await writeFile(join(bundle,file.name),data);const root=join(directory,'models'),assets=new MediaAssets(root);
  child.after(async()=>{await assets.close();MEDIA_CATALOG[role]=prior;await rm(directory,{recursive:true,force:true});});
  await assets.importBundle(role,bundle);const installed=join(assets.path(role),file.name),marker=await readFile(join(assets.path(role),'complete.json'));
  const identity=mediaModelIdentities(role);
  MEDIA_CATALOG[role].files[0]={...file,official:'https://new.fixture.invalid/model',mirror:'https://mirror.fixture.invalid/model'};
  if(role==='local-image'){
   Object.assign(MEDIA_CATALOG[role].models!.image,{repository:'relocated-repository',upstream:'https://upstream.fixture.invalid/relocated'});
   const manifest={files:[{name:file.name,sha256:file.sha256,size:file.size}],id:'InternVL3-14B-4bit',license:'generated-license',revision:'generated-revision'};
   assert.equal(identity.image.manifestSha256,createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),'image identity uses the same content-only manifest as dialogue');
  }
  assert.deepEqual(mediaModelIdentities(role),identity);assert.equal(assets.ready(role),true);
  for(const change of [
   async()=>utimes(installed,0,0),async()=>chmod(installed,0o640),
   async()=>{await link(installed,join(directory,'snapshot'));await rm(join(directory,'snapshot'));},
   async()=>{await writeFile(installed+'.replacement',data);await rename(installed+'.replacement',installed);},
  ]){
   await change();assert.equal(assets.ready(role),true);assert.equal(assets.status(role).state,'ready');
   const reader=new MediaAssets(root);try{assert.equal(reader.ready(role),true,'metadata changes also survive a new reader');}finally{await reader.close();}
  }
  assert.deepEqual(await readFile(join(assets.path(role),'complete.json')),marker,'readiness never rewrites the published receipt');
  await writeFile(installed,Buffer.alloc(data.length,1));
  assert.equal(assets.ready(role),role==='dialogue'||role==='local-image','small roles rehash changed metadata; large roles defer to strict workers');
 });
});

test('small-role metadata changes rehash content once while later status polls reuse that verified signature',async t=>{
 for(const role of ['ocr','speaker-wespeaker'] as const)await t.test(role,async child=>{
  const directory=await mkdtemp(join(tmpdir(),'mote-small-rehash-')),bundle=join(directory,'bundle'),prior=MEDIA_CATALOG[role],data=Buffer.alloc(64*1024,41);
  MEDIA_CATALOG[role]={version:'generated-small-'+role,files:[{name:'model.bin',size:data.length,sha256:createHash('sha256').update(data).digest('hex'),official:'https://fixture.invalid/model'}]};
  await mkdir(bundle);await writeFile(join(bundle,'model.bin'),data);const assets=new MediaAssets(join(directory,'models'));await assets.importBundle(role,bundle);
  const installed=join(assets.path(role),'model.bin'),inode=fs.lstatSync(installed).ino,read=fs.readSync;let reads=0;
  child.mock.method(fs,'readSync',((...args:Parameters<typeof fs.readSync>)=>{if(fs.fstatSync(args[0]).ino===inode)reads++;return Reflect.apply(read,fs,args);}) as typeof fs.readSync);syncBuiltinESMExports();
  child.after(async()=>{await assets.close();child.mock.restoreAll();syncBuiltinESMExports();MEDIA_CATALOG[role]=prior;await rm(directory,{recursive:true,force:true});});
  assert.equal(assets.ready(role),true);assert.equal(reads,0);
  await utimes(installed,0,0);assert.equal(assets.ready(role),true);assert.ok(reads>0,'a metadata change must be certified by reading actual bytes');
  const checked=reads;assets.status(role);assets.status(role);assert.equal(reads,checked,'unchanged verified small assets are not rehashed on every poll');
  await chmod(installed,0o640);assert.equal(assets.ready(role),true);assert.ok(reads>checked,'changed permissions trigger another content check');
 });
});

test('local image startup accepts unchanged weights after snapshot links and timestamp changes; the real loader still rejects changed bytes',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'mote-image-asset-metadata-')),bundle=join(directory,'bundle'),prior=MEDIA_CATALOG['local-image'];
 const bytes=Buffer.from('Generated pinned image model bytes'),files=['model.bin','config.json'].map(name=>({name,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),official:'https://example.invalid/'+name}));
 await mkdir(bundle);for(const file of files)await writeFile(join(bundle,file.name),bytes);
 MEDIA_CATALOG['local-image']={version:'generated-image-metadata',files};
 const root=join(directory,'models'),assets=new MediaAssets(root);
 t.after(async()=>{await assets.close();MEDIA_CATALOG['local-image']=prior;await rm(directory,{recursive:true,force:true});});
 await assets.importBundle('local-image',bundle);
 const inspect=()=>JSON.parse(execFileSync('python3',['-c',[
  'import json,sys;sys.path.insert(0,sys.argv[1]);from mote_vlm import verify_assets,VlmError',
  'try: verify_assets(sys.argv[2],json.loads(sys.argv[3]));print(json.dumps({"verified":True}))',
  'except VlmError as error: print(json.dumps({"error":error.code}))',
 ].join('\n'),scripts,assets.path('local-image'),JSON.stringify(files.map(file=>[file.name,file.size,file.sha256]))],{encoding:'utf8',timeout:30000}));
 const installed=join(assets.path('local-image'),'model.bin'),snapshot=join(directory,'snapshot.bin');
 await link(installed,snapshot);await utimes(join(assets.path('local-image'),'config.json'),new Date('2024-01-01'),new Date('2024-01-01'));
 assert.deepEqual(inspect(),{verified:true});
 assert.equal(assets.ready('local-image'),true,'link metadata and timestamps are not changed model contents');
 await rm(snapshot);assert.equal(new MediaAssets(root).ready('local-image'),true,'the same verified installation survives a new reader');
 await writeFile(installed,Buffer.alloc(bytes.length,1));
 assert.deepEqual(inspect(),{error:'model_missing'},'same-size corruption is rejected before the real worker loads it');
 await writeFile(join(bundle,'model.bin'),Buffer.alloc(bytes.length,1));await assert.rejects(assets.importBundle('local-image',bundle),'installation still verifies SHA-256');
 await rm(installed);assert.equal(assets.ready('local-image'),false,'missing required assets remain unavailable');
});

test('invalid catalog paths and symlinked download parents cannot escape the model root',async t=>{
 const f=await nestedBundle(t),catalog=MEDIA_CATALOG.dialogue;
 for(const name of ['../outside','/outside','asr/../../outside','asr\\outside','asr//model.pt','complete.json']){
  MEDIA_CATALOG.dialogue={...catalog,files:[{...catalog.files[0],name}]};
  assert.throws(()=>f.assets.install('dialogue'),/Invalid model asset path/);
 }
 MEDIA_CATALOG.dialogue=catalog;
 const outside=join(f.directory,'outside');await mkdir(outside);await mkdir(join(f.root,'dialogue.downloads'));
 await symlink(outside,join(f.root,'dialogue.downloads/asr'));
 await assert.rejects(f.assets.importBundle('dialogue',f.bundle));assert.deepEqual(await readdir(outside),[]);
});

test('an atomic publication failure restores the previous valid directory and never leaves staging files',async t=>{
 const f=await nestedBundle(t);await f.assets.importBundle('dialogue',f.bundle);
 const prior=await readFile(join(f.assets.path('dialogue'),'complete.json')),rename=fs.renameSync;let failed=false;
 t.mock.method(fs,'renameSync',((from:string,to:string)=>{
  if(String(from).endsWith('.install')&&to===f.assets.path('dialogue')){failed=true;throw Object.assign(Error('Generated rename failure'),{code:'EIO'});}
  return rename(from,to);
 }) as typeof fs.renameSync);syncBuiltinESMExports();
 t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
 await assert.rejects(f.assets.importBundle('dialogue',f.bundle),/Generated rename failure/);
 assert.equal(failed,true);assert.equal(f.assets.status('dialogue').state,'failed');
 assert.equal(f.assets.ready('dialogue'),true,'the prior verified version still works');
 assert.deepEqual(await readFile(join(f.assets.path('dialogue'),'complete.json')),prior);
 assert.deepEqual((await readdir(f.root)).filter(name=>/\.(?:old|install)$/.test(name)),[]);
});

test('OCR tar imports verify and publish both extracted model/config pairs through the same installer',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'mote-ocr-assets-')),bundle=join(directory,'bundle'),tree=join(directory,'tree'),prior=MEDIA_CATALOG.ocr;
 const data=Buffer.from('Generated OCR member bytes'),files=[];
 for(const kind of ['det','rec']){
  const folder=`generated-${kind}`;await mkdir(join(tree,folder),{recursive:true});await mkdir(bundle,{recursive:true});
  for(const name of ['inference.onnx','inference.yml'])await writeFile(join(tree,folder,name),data);
  execFileSync('tar',['-cf',join(bundle,kind+'.tar'),'-C',tree,folder]);const bytes=await readFile(join(bundle,kind+'.tar'));
  files.push({name:kind+'.tar',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),official:'https://fixture.invalid/'+kind+'.tar',extract:{kind:'tar' as const,entry:folder+'/inference.onnx',destination:kind+'/inference.onnx',output:{size:data.length,sha256:createHash('sha256').update(data).digest('hex')},config:{size:data.length,sha256:createHash('sha256').update(data).digest('hex')}}});
 }
 MEDIA_CATALOG.ocr={version:'generated-ocr-tar',files};const assets=new MediaAssets(join(directory,'models'));
 t.after(async()=>{await assets.close();MEDIA_CATALOG.ocr=prior;await rm(directory,{recursive:true,force:true});});
 const receipt=mediaAssetStatusSchema.parse(await assets.importBundle('ocr',bundle));assert.equal(receipt.state,'ready');assert.equal(assets.ready('ocr'),true);
 assert.deepEqual(await readFile(join(assets.path('ocr'),'rec/inference.yml')),data);
 const member=join(assets.path('ocr'),'rec/inference.yml');await utimes(member,0,0);assert.equal(assets.ready('ocr'),true);
 await writeFile(member,Buffer.alloc(data.length,1));assert.equal(assets.ready('ocr'),false,'same-size corruption of an extracted config is rejected');
 await assets.installAsync('ocr');assert.equal(assets.ready('ocr'),true);assert.deepEqual(await readFile(member),data);
 const expected=MEDIA_CATALOG.ocr.files[0].extract!.output.sha256;
 MEDIA_CATALOG.ocr.files[0].extract!.output.sha256='0'.repeat(64);
 assert.equal(assets.ready('ocr'),false,'an extracted file receipt cannot substitute for the catalog content pin');
 await assert.rejects(assets.importBundle('ocr',bundle),/Invalid model asset/);
 MEDIA_CATALOG.ocr.files[0].extract!.output.sha256=expected;
 await rm(join(assets.path('ocr'),'det/inference.yml'));assert.equal(assets.ready('ocr'),false);
});
