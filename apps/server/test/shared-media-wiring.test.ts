import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {mediaModelsViewSchema} from '@mote/shared';
import {serializeConfigDocument} from '@mote/shared/config-file';
import {buildApp} from '../src/app.js';
import {configFromFile} from '../src/config.js';
import {MEDIA_CATALOG} from '../src/media-assets.js';
import {FUNASR_PROTOCOL,parseFunasrRequest} from '../src/funasr-contract.js';

test('the assembled media API uses the same loaded identity and lifecycle status as preparation, never the old ASR booleans',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'mote-shared-media-wiring-')),file=join(directory,'mote.yaml'),bundle=join(directory,'bundle');
 const prior=MEDIA_CATALOG.dialogue,bytes=Buffer.from('Generated shared-wiring model bytes');
 MEDIA_CATALOG.dialogue={version:'generated-wiring-dialogue',files:[{name:'asr/model.bin',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),official:'https://example.invalid/model'}]};
 let node:Awaited<ReturnType<typeof buildApp>>|undefined;
 let body:unknown={protocol:FUNASR_PROTOCOL,execution:'local',asr:true,diarization:true};
 const worker=createServer((request,response)=>{
  assert.equal(request.url,'/health');assert.equal(request.headers.authorization,'Bearer generated-shared-worker');
  response.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify(body));
 });
 t.after(async()=>{try{await node?.app.close();}finally{worker.closeAllConnections();await new Promise<void>(resolve=>worker.close(()=>resolve()));MEDIA_CATALOG.dialogue=prior;await rm(directory,{recursive:true,force:true});}});
 worker.listen(0,'127.0.0.1');await once(worker,'listening');const port=(worker.address() as {port:number}).port;
 // Docker here selects the sidecar HEALTH boundary only. No Docker command or
 // container is created; the unavailable model boundary is loopback fixture HTTP.
 await writeFile(file,serializeConfigDocument({version:1,revision:0,server:{runtime:'docker',port:0,token:'generated-shared-wiring-owner-token'},storage:{dataDir:join(directory,'data')},diagnostics:{enabled:false,level:'silent'},media:{modelDirectory:join(directory,'models'),workerToken:'generated-shared-worker',asrEndpoint:`http://127.0.0.1:${port}/transcribe`}}));
 node=await buildApp(configFromFile(file),{backgroundWorker:false});const central=node,headers={authorization:'Bearer '+central.featureServices.config.token};await central.app.ready();
 const steps=()=>central.store.db.prepare('SELECT COUNT(*) n FROM execution_steps').get()!.n,beforeSteps=steps();
 await mkdir(join(bundle,'asr'),{recursive:true});await writeFile(join(bundle,'asr/model.bin'),bytes);await central.featureServices.mediaAssets.importBundle('dialogue',bundle);
 const authority=central.modelAuthorization.view(),perception=central.perception.settings(),processing=central.processing.currentSettings();
 const view=async()=>{const response=await central.app.inject({url:'/api/media-models',headers});assert.equal(response.statusCode,200,response.body);return mediaModelsViewSchema.parse(JSON.parse(response.body));};
 assert.equal((await view()).dialogue!.runtimeReady,false,'boolean availability without the loaded identity cannot certify FunASR');
 const producer=spawnSync('python3',[fileURLToPath(new URL('../../../scripts/test_mote_asr_contract.py',import.meta.url)),'--emit'],{encoding:'utf8',timeout:30_000});assert.equal(producer.status,0,producer.stderr);
 const identity=parseFunasrRequest(JSON.parse(producer.stdout).request).identity;
 body={protocol:FUNASR_PROTOCOL,execution:'local',asr:true,diarization:true,identity,missingDependencies:[]};
 const ready=await view();assert.equal(ready.dialogue!.state,'ready');assert.equal(ready.dialogue!.runtimeReady,true);
 const preparation=await central.app.inject({url:'/api/media-preparation',headers});assert.equal(preparation.statusCode,200);assert.equal(preparation.json().dialogue.runtimeReady,ready.dialogue!.runtimeReady);
 body={protocol:FUNASR_PROTOCOL,execution:'local',asr:true,diarization:true,identity,missingDependencies:['funasr']};
 const missing=await view();assert.equal(missing.dialogue!.runtimeReady,false);assert.deepEqual(missing.dialogue!.missingDependencies,['funasr']);
 body={version:2,asr:true,diarization:true,missingDependencies:['faster_whisper']};assert.equal((await view()).dialogue!.runtimeReady,false);
 body={protocol:FUNASR_PROTOCOL,execution:'local',asr:true,diarization:true,identity};await rm(join(central.featureServices.mediaAssets.path('dialogue'),'asr/model.bin'));assert.equal((await view()).dialogue!.runtimeReady,false);
 const inventory=(await central.app.inject({url:'/api/features',headers})).json();assert.ok(inventory.capabilities.some((value:{id:string;state:string})=>value.id==='mote.plugin-control'&&value.state==='active'));
 assert.equal(central.bootstrap.snapshot().contributions.filter(value=>value.identity.contributionId==='mote.plugin-control').length,1);
 const control=(await central.app.inject({url:'/api/plugins',headers})).json();assert.deepEqual(control.builds,(await central.app.inject({url:'/api/plugin-builds',headers})).json());
 assert.deepEqual(central.modelAuthorization.view(),authority);assert.deepEqual(central.perception.settings(),perception);assert.deepEqual(central.processing.currentSettings(),processing);
 assert.equal(steps(),beforeSteps,'installation and status queries do not admit content processing');
 if(process.env.MOTE_CORE03_EXAMPLE_PATH)await writeFile(process.env.MOTE_CORE03_EXAMPLE_PATH,JSON.stringify({ready,missing,preparation:preparation.json(),control:{builds:control.builds}},null,2)+'\n');
});
