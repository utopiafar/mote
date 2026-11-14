/** Only CLI/metadata/generated-material boundaries. Never select the full
 * contract runner or a Central/model/UI journey from these ordinary checks. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import {mkdir,mkdtemp,readFile,readdir,rm,stat,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import sharp from 'sharp';
import {acceptancePlan,contractArguments,contractEnvironment,contractOutcome,createOutput,parseArguments,repository,runTestProcess} from './local-image-plugin.js';
import {localImageRequestSchema,parseLocalImageResponse} from '../../apps/server/src/local-image-contract.js';

const script=join(repository,'scripts/journeys/local-image-plugin.ts');
const canary='generated-env-canary-not-a-real-secret';
const cli=(args:string[],extra:NodeJS.ProcessEnv={})=>spawnSync(process.execPath,['--import','tsx',script,...args],{
 cwd:repository,env:{...process.env,MOTE_CONFIG_FILE:'/nonexistent/generated-forbidden-profile.yaml',MOTE_MEDIA_WORKER_TOKEN:canary,...extra},encoding:'utf8',timeout:30000,
});
const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');

test('CLI defaults and import remain inert even with an inherited Central profile',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'mote-img08-inert-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const result=cli([],{TMPDIR:directory});assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/Usage:/);assert.doesNotMatch(result.stdout,/"artifacts":|server\.listening|generated-env-canary/);
 const imported=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',`await import(${JSON.stringify(pathToFileURL(script).href)}); console.log('imported without startup');`],{cwd:repository,env:{...process.env,TMPDIR:directory,MOTE_CONFIG_FILE:'/nonexistent/generated-profile'},encoding:'utf8',timeout:30000});
 assert.equal(imported.status,0,imported.stderr);assert.equal(imported.stdout.trim(),'imported without startup');
 assert.deepEqual((await readdir(directory)).filter(name=>!/^tsx-\d+$/.test(name)),[],'help/import create no generated run or profile; tsx may create its own loader cache');
});

test('invalid flags and mixed modes fail before creating output or reading an input/profile',async t=>{
 const parent=await mkdtemp(join(tmpdir(),'mote-img08-cli-'));t.after(()=>rm(parent,{recursive:true,force:true}));
 for(const args of [
  ['--fixtures-only','--input','/nonexistent/generated-photo.png'],
  ['--run-contracts','--profile','personal'],['--run-contracts','--url','http://127.0.0.1:47862'],
  ['--live'],['--run'],['--dry-run','--fixtures-only'],['--fixtures-only','--fixtures-only'],
  ['--fixtures-only','--output'],['--fixtures-only','--output','relative'],
  ['--help','--output',join(parent,'help')],
  ['--fixtures-only','--output',join(parent,'one'),'--output',join(parent,'two')],
 ])assert.throws(()=>parseArguments(args));
 const output=join(parent,'must-not-exist');
 const rejected=cli(['--fixtures-only','--output',output,'--input','/nonexistent/generated-photo.png']);
 assert.equal(rejected.status,1);assert.match(rejected.stderr,/Unknown argument/);assert.doesNotMatch(rejected.stderr,/ENOENT|generated-env-canary/);
 assert.equal(existsSync(output),false);assert.deepEqual(await readdir(parent),[]);
});

test('plan pins the actual candidate and leaves A/B, release and unknown measurements unfinished',()=>{
 const result=cli(['--dry-run']);assert.equal(result.status,0,result.stderr);
 const plan=JSON.parse(result.stdout);assert.match(plan.candidate,/^[a-f0-9]{40}$/);
 assert.equal(plan.fullJourneyCompleted,false);assert.equal(plan.releaseAccepted,false);
 assert.equal(plan.paths.A.state,'not_run');assert.equal(plan.paths.B.state,'not_run');
 assert.equal(plan.releaseMatrix.length,8);assert.ok(plan.releaseMatrix.every((row:{state:string})=>row.state==='not_run'));
 assert.ok(Object.values(plan.modelMeasurements).every(value=>value===null));
 assert.ok(contractArguments.includes('--test-concurrency=4'));assert.ok(contractArguments.includes('--test-timeout=120000'));
 const files=contractArguments.filter(value=>value.endsWith('.test.ts'));assert.equal(files.length,11);assert.equal(new Set(files).size,11);
 assert.doesNotMatch(JSON.stringify(plan),/generated-env-canary|MOTE_CONFIG_FILE/);
});

test('output cannot reuse existing data or follow a symlink into a lane',async t=>{
 const parent=await mkdtemp(join(tmpdir(),'mote-img08-output-'));t.after(()=>rm(parent,{recursive:true,force:true}));
 await writeFile(join(parent,'retained.txt'),'generated retained bytes');
 await assert.rejects(createOutput(parent),{code:'EEXIST'});
 await symlink(repository,join(parent,'lane'),'dir');
 await assert.rejects(createOutput(join(parent,'lane','forbidden-img08-artifacts')),/outside repository and lane/);
 assert.equal(existsSync(join(repository,'forbidden-img08-artifacts')),false);
 const previous=process.env.TMPDIR;
 try{process.env.TMPDIR=repository;await assert.rejects(createOutput(),/outside repository and lane/);}
 finally{if(previous===undefined)delete process.env.TMPDIR;else process.env.TMPDIR=previous;}
 assert.equal(await readFile(join(parent,'retained.txt'),'utf8'),'generated retained bytes');
});

test('generated CLI artifacts retain exact original/crop bytes and current transport identity without claiming inference',async t=>{
 const parent=await mkdtemp(join(tmpdir(),'mote-img08-artifacts-'));t.after(()=>rm(parent,{recursive:true,force:true}));
 const directory=join(parent,'new-run'),result=cli(['--fixtures-only','--output',directory]);
 assert.equal(result.status,0,result.stderr);
 const summary=JSON.parse(result.stdout);assert.equal(summary.status,'passed');assert.equal(summary.fullJourneyCompleted,false);assert.equal(summary.releaseAccepted,false);
 const manifest=JSON.parse(await readFile(join(directory,'manifest.json'),'utf8'));
 assert.equal(manifest.personalDataUsed,false);assert.equal(manifest.modelInference,false);assert.equal(manifest.centralStarted,false);
 assert.deepEqual(manifest.samples.map((sample:{id:string})=>sample.id),['photo','small-text','long-image','region-crop','empty-ocr','malicious-text']);
 assert.equal((await readdir(directory)).length,14);
 assert.equal((await stat(directory)).mode&0o077,0,'generated run is private');
 for(const sample of manifest.samples){
  const original=await readFile(join(directory,sample.file)),transport=JSON.parse(await readFile(join(directory,sample.id+'.transport.json'),'utf8'));
  assert.equal(original.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
  assert.equal(original.readUInt32BE(16),sample.width);assert.equal(original.readUInt32BE(20),sample.height);
  assert.equal(original.length,sample.sizeBytes);assert.equal(hash(original),sample.sha256);
  const request=localImageRequestSchema.parse(transport.request),response=parseLocalImageResponse(transport.response,request);
  assert.equal(response.originalSha256,hash(original));assert.equal(request.image.imageView.original.sha256,hash(original));
  const pixels=Buffer.from(request.image.data,'base64'),region=request.image.imageView.region;
  if(region)assert.deepEqual(await sharp(pixels).raw().toBuffer(),await sharp(original).extract({left:region.x,top:region.y,width:region.width,height:region.height}).toColourspace('srgb').raw().toBuffer());
  else assert.deepEqual(pixels,original);
  assert.equal(response.status,'ok');if(response.status==='ok'){assert.equal(response.usage,undefined);assert.match(response.model.revision,/^generated-/);}
  assert.doesNotMatch(JSON.stringify(transport),/generated-env-canary|\/Users\/|Bearer /);
 }
 const report=JSON.parse(await readFile(join(directory,'report.json'),'utf8'));
 assert.equal(report.status,'passed');assert.equal(report.plan.paths.A.state,'not_run');assert.equal(report.plan.paths.B.state,'not_run');
 assert.ok(report.plan.releaseMatrix.every((row:{state:string})=>row.state==='not_run'));
 assert.deepEqual(acceptancePlan(summary.candidate,summary.worktreeDirty),report.plan);
});

test('contract evidence fails closed on missing/truncated summaries, skipped/cancelled tests or nonzero exits',()=>{
 const complete='# tests 182\n# pass 182\n# fail 0\n# cancelled 0\n# skipped 0\n';
 assert.equal(contractOutcome(0,null,complete).state,'passed');
 for(const [exitCode,signal,body] of [[1,null,complete],[null,'SIGTERM',complete],[0,null,''],[0,null,complete.replace('# skipped 0','# skipped 1')],[0,null,complete.replace('# cancelled 0','# cancelled 1')],[0,null,complete.replace('# tests 182','# tests 0')],[0,null,complete.replace('# fail 0','# fail 1')]] as const)assert.equal(contractOutcome(exitCode,signal,body).state,'failed');
 const failure=contractOutcome(1,null,'# tests 182\n# pass 181\n# fail 1\n# cancelled 0\n# skipped 0\n');
 assert.equal(failure.passed,181);assert.equal(failure.failed,1);assert.equal(failure.state,'failed');
 assert.equal(contractOutcome(1,null,'').tests,null,'unknown counts are not fabricated zero');
 assert.deepEqual(contractEnvironment({PATH:'generated-path',MOTE_CONFIG_FILE:'generated-profile',MOTE_IMG03_EXAMPLE_PATH:'generated-old-output',MOTE_MEDIA_WORKER_TOKEN:canary,NODE_TEST_CONTEXT:'child-v8'}),{PATH:'generated-path'});
});

test('the subprocess runner retains real TAP and stderr, and propagates an actual failing generated test',async t=>{
 const parent=await mkdtemp(join(tmpdir(),'mote-img08-process-'));t.after(()=>rm(parent,{recursive:true,force:true}));
 for(const fail of [false,true]){
  const directory=join(parent,String(fail));await mkdir(directory);
  const file=join(directory,'generated.test.mjs');
  await writeFile(file,`import test from 'node:test'; import assert from 'node:assert/strict';\nconsole.error('generated stderr retained');\ntest('generated exit evidence',()=>{assert.equal(${fail?1:0},0);});\n`);
  const result=await runTestProcess(directory,['--test','--test-reporter=tap',file]);
  const log=await readFile(join(directory,result.log),'utf8');
  assert.equal(result.state,fail?'failed':'passed',JSON.stringify(result)+'\n'+log);assert.equal(result.exitCode,fail?1:0);assert.equal(result.tests,1);assert.equal(result.failed,fail?1:0);assert.equal(result.skipped,0);assert.equal(result.cancelled,0);
  assert.match(log,/generated stderr retained/);assert.match(log,fail?/not ok 1/:/ok 1/);
 }
});
