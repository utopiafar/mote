import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import sharp from 'sharp';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';
import {materialId} from '../src/materials.js';
import type {ImportJob} from '@mote/shared';

const token='generated-import-services-owner';
const headers={authorization:'Bearer '+token};
const pythonExecutable=process.platform==='darwin'?'/Library/Developer/CommandLineTools/usr/bin/python3':'/usr/bin/python3';
const pythonSandbox=process.platform==='darwin'?existsSync(pythonExecutable):['/usr/bin/bwrap','/bin/bwrap'].some(existsSync);

const config=(dataDir:string,packRoot:string,scriptSha256:string):Config=>({dataDir,token,tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:50_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false,
  importPythonPacks:[{id:'fixture.import-pack',version:'1',packRoot,script:'main.py',scriptSha256,pythonExecutable,maxInputFiles:16}]});

async function settle(node:Awaited<ReturnType<typeof buildApp>>,id:string){
  for(const deadline=Date.now()+30_000;Date.now()<deadline;){
    const job=node.imports.get(id);
    if(['completed','failed','unsupported','needs_configuration'].includes(job.status))return job;
    await delay(25);
  }
  throw Error('Generated import did not settle');
}

test('import-services consumes a real Python pack and HTTP media into FileProcessing intake across activation changes',
  {skip:!pythonSandbox,timeout:60_000},async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-import-services-')),packRoot=join(directory,'pack');
  mkdirSync(packRoot,{mode:0o700});
  const script=`import json\nr=json.load(open('request.json'))\ntext=open(r['inputs'][0]['path']).read()\nprint(json.dumps({'summary':'Generated Python source pack preview','warnings':[],'reviewDecision':{'confidence':'high','ambiguous':False,'reason':'Exact generated pack mapping'},\n 'dispositions':[{'index':i,'status':'parsed' if i==0 else 'attachment','reason':'Generated pack disposition'} for i in range(len(r['inputs']))],\n 'records':[{'item':{'externalId':'generated-pack-entry','revision':'1','observedAt':'2026-11-01T00:00:00Z','kind':'file','layer':'original','title':'Generated pack entry','text':text},'evidenceIndexes':[0],'attachmentIndexes':list(range(1,len(r['inputs'])))}]}))\n`;
  writeFileSync(join(packRoot,'main.py'),script,{mode:0o600});
  const scriptSha256=createHash('sha256').update(script).digest('hex');
  const cfg=config(directory,packRoot,scriptSha256);
  let node=await buildApp(cfg,{backgroundWorker:false,agent:{configured:false,close:async()=>{},query:async()=>{throw Error('Generated fixture must not call a model');}}});
  t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});
  await node.app.ready();
  const request=(method:'GET'|'POST',url:string,payload?:unknown)=>node.app.inject({method,url,headers,payload:payload as never});

  // [K] The configured pack is a real producer: the plugin constructs its
  // pinned executor and serves the public catalog without exposing script paths.
  const catalog=await request('GET','/api/import-source-packs');assert.equal(catalog.statusCode,200,catalog.body);
  assert.deepEqual(catalog.json(),{items:[{id:'fixture.import-pack',version:'1'}]});
  const capabilities=await request('GET','/api/import-capabilities');assert.equal(capabilities.statusCode,200,capabilities.body);
  const intake=capabilities.json() as {formats:{id:string}[];containers:{id:string}[]};
  assert.ok(intake.formats.some(format=>format.id==='mote.media-format'));
  assert.ok(intake.containers.some(container=>container.id==='mote.zip-container'));

  const packText=Buffer.from('Generated Python pack source text'),attachment=Buffer.from('Generated Python pack attachment bytes');
  const packCreated=await request('POST','/api/imports',{processing:'automatic',sourcePackId:'fixture.import-pack',instruction:'Generated pack owner context',files:[
    {name:'generated.md',dataBase64:packText.toString('base64')},
    {name:'generated.bin',dataBase64:attachment.toString('base64')},
  ]});
  assert.equal(packCreated.statusCode,202,packCreated.body);
  const packJob=await settle(node,packCreated.json<ImportJob>().id);
  assert.equal(packJob.status,'completed',packJob.error);
  assert.equal(packJob.sourcePackId,'fixture.import-pack');
  const packCapture=node.sources.getItem(packJob.sourceId,'generated-pack-entry');
  assert.ok(packCapture);
  assert.equal(packCapture.captureId,packJob.captureIds[0]);
  assert.equal(packCapture.revision,'1');
  assert.deepEqual(node.archivedFiles.read(packJob.files[0].id),packText,'the exact uploaded original survives parsing');
  const attached=node.archivedFiles.listForCapture(packJob.captureIds[0]);
  assert.equal(attached.length,2);
  assert.deepEqual(node.archivedFiles.read(attached.find(file=>file.name==='generated.bin')!.id),attachment);
  await node.materialOrganizer.tick();
  const packMaterial=node.materials.get(materialId(packJob.sourceId,'generated-pack-entry'));
  assert.ok(packMaterial);
  assert.ok(node.materials.evidenceIds(packMaterial.ref).length>0);
  const packEvidence=node.store.evidence([packJob.captureIds[0]])[0];
  assert.deepEqual(node.materials.contextForEvidence(packEvidence).importStatements?.[0].captureIds,[packJob.captureIds[0]]);

  // A real HTTP upload is classified by the FileProcessing intake registry, and
  // its file version manifest keeps the import source, mime type and original hash.
  const image=await sharp({create:{width:16,height:12,channels:3,background:'#3a6ea5'}}).jpeg().toBuffer();
  const imageCreated=await request('POST','/api/imports',{processing:'automatic',instruction:'Generated media owner context',files:[{name:'generated.jpg',dataBase64:image.toString('base64')}]});
  assert.equal(imageCreated.statusCode,202,imageCreated.body);
  const mediaJob=await settle(node,imageCreated.json<ImportJob>().id);
  assert.equal(mediaJob.status,'completed',mediaJob.error);
  assert.equal(mediaJob.media?.length,1);
  assert.equal(mediaJob.media[0].format.mimeType,'image/jpeg');
  const mediaCapture=mediaJob.media[0].captureId!;
  const version=node.files.version(mediaCapture),manifest=JSON.parse(version.manifest) as {sourceId:string;sha256:string;sizeBytes:number;item:{externalId:string;mimeType:string}};
  assert.equal(version.source_id,mediaJob.sourceId);
  assert.equal(manifest.sourceId,mediaJob.sourceId);
  assert.equal(manifest.item.externalId,'file:generated.jpg');
  assert.equal(manifest.item.mimeType,'image/jpeg');
  assert.equal(manifest.sha256,createHash('sha256').update(image).digest('hex'));
  assert.equal(manifest.sizeBytes,image.length);
  assert.deepEqual(node.archivedFiles.read(mediaJob.files[0].id),image);
  await node.processing.tick();
  await node.materialOrganizer.tick();
  const mediaMaterial=node.materials.get(materialId(mediaJob.sourceId,'file:generated.jpg'));
  assert.ok(mediaMaterial);
  assert.ok(node.materials.evidenceIds(mediaMaterial.ref).length>0);
  assert.deepEqual(node.materials.contextForEvidence(node.store.evidence([mediaCapture])[0]).importStatements?.[0].captureIds,[mediaCapture]);

  // Error branch: an unknown producer id is rejected before a job or original exists.
  const before=node.imports.list().length;
  const missing=await request('POST','/api/imports',{sourcePackId:'fixture.missing-pack',files:[{name:'generated.txt',dataBase64:Buffer.from('Generated input').toString('base64')}]});
  assert.equal(missing.statusCode,409,missing.body);
  assert.equal(node.imports.list().length,before);

  // Activation changes reuse the mounted route table: quiesce/stop reject new
  // HTTP work, re-enable restores reads, and a same-profile restart keeps bytes.
  node.importServices.quiesce('disabled');
  const refused=await request('POST','/api/imports',{files:[{name:'generated.txt',dataBase64:Buffer.from('Generated input').toString('base64')}]});
  assert.equal(refused.statusCode,503,refused.body);
  assert.equal((await request('GET','/api/imports/'+packJob.id)).statusCode,200,'accepted receipts stay readable while quiescing');
  await node.importServices.stop('disabled');
  assert.equal((await request('GET','/api/imports/'+packJob.id)).statusCode,503);
  node.importServices.start();
  const reopened=await request('GET','/api/imports/'+packJob.id);
  assert.equal(reopened.statusCode,200,reopened.body);
  assert.equal(reopened.json<ImportJob>().status,'completed');

  await node.app.close();
  node=await buildApp(cfg,{backgroundWorker:false,agent:{configured:false,close:async()=>{},query:async()=>{throw Error('Generated fixture must not call a model');}}});
  await node.app.ready();
  const restarted=await node.app.inject({url:'/api/imports/'+packJob.id,headers});
  assert.equal(restarted.statusCode,200,restarted.body);
  assert.equal(restarted.json<ImportJob>().status,'completed');
  assert.deepEqual(node.archivedFiles.read(packJob.files[0].id),packText,'the same profile keeps the original bytes');
});
