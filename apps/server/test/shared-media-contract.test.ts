import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {MEDIA_MODEL_PATHS,MEDIA_MODEL_COMPONENT_PATHS,mediaAssetStatusSchema,mediaModelsViewSchema} from '@mote/shared';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';
import {MEDIA_CATALOG} from '../src/media-assets.js';
import {FUNASR_MODEL_IDS} from '../src/funasr-contract.js';

/** Only model bytes are generated. Import verification, publication, installed
 * paths, authenticated HTTP serialization and the shared consumer stay real.
 * This does not register the future FunASR catalog or local-image worker. */
test('shared media consumers retain actual HTTP installation failures and recovery without mistaking installed assets for a ready worker',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'mote-shared-media-contract-')),bundle=join(directory,'bundle');
 const prior=MEDIA_CATALOG.dialogue,bytes=Buffer.from('Generated model asset bytes; no weights or personal data.');
 const names=['config.json','model.bin','tokenizer.json','vocabulary.txt','segmentation.onnx','speaker.onnx'];
 MEDIA_CATALOG.dialogue={version:'generated-contract-v1',files:names.map(name=>({name,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),official:`https://example.invalid/generated/${name}`}))};
 let node:Awaited<ReturnType<typeof buildApp>>|undefined;
 t.after(async()=>{try{await node?.app.close();}finally{MEDIA_CATALOG.dialogue=prior;await rm(directory,{recursive:true,force:true});}});
 const config:Config={dataDir:join(directory,'data'),token:'generated-shared-media-owner',tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:20_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'https://example.invalid',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',logLevel:'silent',diagnosticsEnabled:false};
 node=await buildApp(config,{backgroundWorker:false,createModelAgent:async()=>({configured:false,close:async()=>{},query:async()=>{throw Error('No model invocation belongs to this installation contract');}})});
 const central=node,assets=central.featureServices.mediaAssets,headers={authorization:`Bearer ${config.token}`},before=central.modelAuthorization.view(),perception=central.perception.settings();
 const view=async()=>{
  const response=await central.app.inject({url:'/api/media-models',headers});assert.equal(response.statusCode,200,response.body);
  // Feed the actual route serializer's bytes to the shared parser, not a
  // separately authored client fixture with matching-looking fields.
  return mediaModelsViewSchema.parse(JSON.parse(response.body));
 };
 assert.equal((await central.app.inject({url:'/api/media-models'})).statusCode,401);
 const initial=await view();assert.deepEqual(Object.keys(initial).sort(),['dialogue','ocr','speaker-wespeaker']);
 for(const status of Object.values(initial)){
  assert.equal(status.state,'not_installed');assert.equal(status.runtimeReady,false);assert.equal(status.bytes,0);
  assert.notEqual(status.role,'local-image','CORE-00 does not register the future image catalog');
  if(status.role!=='local-image')assert.equal(assets.path(status.role),join(assets.root,MEDIA_MODEL_PATHS[status.role]));
 }
 assert.deepEqual(Object.keys(MEDIA_MODEL_COMPONENT_PATHS.dialogue).sort(),Object.keys(FUNASR_MODEL_IDS).sort(),'the same four exported model roles have fixed paths in one dialogue bundle');
 await mkdir(bundle);for(const name of names)await writeFile(join(bundle,name),bytes);
 await writeFile(join(bundle,'speaker.onnx'),Buffer.alloc(bytes.length,0));
 await assert.rejects(assets.importBundle('dialogue',bundle),/Invalid model asset: speaker\.onnx/);
 const failed=(await view()).dialogue!;assert.equal(failed.state,'failed');assert.equal(failed.runtimeReady,false);assert.equal(failed.error,'Invalid model asset: speaker.onnx');
 assert.equal(assets.ready('dialogue'),false);
 await writeFile(join(bundle,'speaker.onnx'),bytes);
 const receipt=await assets.importBundle('dialogue',bundle),installed=mediaAssetStatusSchema.parse(JSON.parse(JSON.stringify(receipt)));
 assert.equal(installed.state,'ready');assert.equal(installed.bytes,names.length*bytes.length);assert.equal(installed.totalBytes,installed.bytes);
 const ready=(await view()).dialogue!;assert.equal(ready.state,'ready');assert.equal(ready.runtimeReady,false,'installed assets do not prove a running model');
 assert.equal(ready.version,'generated-contract-v1');assert.equal(ready.error,undefined);
 assert.deepEqual(central.modelAuthorization.view(),before);assert.deepEqual(central.perception.settings(),perception);
 assert.equal(JSON.stringify(ready).includes(directory),false,'public status carries no absolute profile/model path');
 assert.throws(()=>mediaModelsViewSchema.parse({...initial,dialogue:{...initial.dialogue,role:'local-image'}}),/role must match/);
 assert.throws(()=>mediaModelsViewSchema.parse({...initial,unlisted:initial.dialogue}));
 assert.throws(()=>mediaAssetStatusSchema.parse({...installed,modelDirectory:directory}));
});
