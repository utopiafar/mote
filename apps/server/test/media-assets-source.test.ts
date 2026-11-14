import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {execFileSync} from 'node:child_process';
import {mkdtemp,rm,mkdir,writeFile,readFile,symlink,readdir} from 'node:fs/promises';
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
  await writeFile(asr,bytes);assert.deepEqual(inspect(),{error:'model_missing'});assert.equal(assets.ready('dialogue'),false);
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

test('published content changes and stale old-model markers cannot claim the current bundle is ready',async t=>{
 const f=await nestedBundle(t);await f.assets.importBundle('dialogue',f.bundle);
 await writeFile(join(f.assets.path('dialogue'),f.names[0]),Buffer.alloc(f.data.length,1));
 assert.equal(f.assets.ready('dialogue'),false,'same-size corruption invalidates verified file identity');
 await f.assets.importBundle('dialogue',f.bundle);assert.equal(new MediaAssets(f.root).ready('dialogue'),true,'the published verification survives a fresh reader');
 await writeFile(join(f.assets.path('dialogue'),'complete.json'),JSON.stringify({version:MEDIA_CATALOG.dialogue.version}));
 assert.equal(f.assets.ready('dialogue'),false,'a version label alone does not prove verified assets');
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
  files.push({name:kind+'.tar',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),official:'https://fixture.invalid/'+kind+'.tar',extract:{kind:'tar' as const,entry:folder+'/inference.onnx',destination:kind+'/inference.onnx'}});
 }
 MEDIA_CATALOG.ocr={version:'generated-ocr-tar',files};const assets=new MediaAssets(join(directory,'models'));
 t.after(async()=>{await assets.close();MEDIA_CATALOG.ocr=prior;await rm(directory,{recursive:true,force:true});});
 const receipt=mediaAssetStatusSchema.parse(await assets.importBundle('ocr',bundle));assert.equal(receipt.state,'ready');assert.equal(assets.ready('ocr'),true);
 assert.deepEqual(await readFile(join(assets.path('ocr'),'rec/inference.yml')),data);
 await rm(join(assets.path('ocr'),'det/inference.yml'));assert.equal(assets.ready('ocr'),false);
});
