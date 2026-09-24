import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {z} from 'zod';
import {Store,sha256} from '../src/store.js';
import {SourceStore} from '../src/sources.js';
import {ArchivedFileStore} from '../src/archived-files.js';
import {ImportStore} from '../src/imports.js';
import {PythonSourcePackExecutor,macPythonSandboxProfile,pythonImportOutputSchema,pythonImportPreparation,type PythonSandboxLauncher} from '../src/python-source-pack-executor.js';

/** Generated fixtures exercise the process protocol when the host test sandbox cannot nest sandbox-exec. */
const fixtureLauncher:PythonSandboxLauncher=(workspace,python,runner)=>({command:python,args:['-I','-B',runner],cwd:workspace,
  env:{PATH:'/usr/bin:/bin',HOME:workspace,TMPDIR:workspace,PYTHONNOUSERSITE:'1',PYTHONDONTWRITEBYTECODE:'1'}});

function fixture(t:import('node:test').TestContext,script:string,options:{timeoutMs?:number;maxInputBytes?:number;maxOutputBytes?:number;digest?:string}={}){
  const directory=mkdtempSync(join(tmpdir(),'mote-python-source-pack-test-'));
  const packRoot=join(directory,'pack'),workspace=join(directory,'workspace');mkdirSync(packRoot,{mode:0o700});mkdirSync(workspace,{mode:0o700});mkdirSync(join(workspace,'inputs'),{mode:0o700});
  const scriptPath=join(packRoot,'main.py');writeFileSync(scriptPath,script,{mode:0o600});
  const inputPath=join(workspace,'inputs','generated.txt');writeFileSync(inputPath,'Generated Python Source Pack input.',{mode:0o600});
  const executor=new PythonSourcePackExecutor({id:'fixture.python-pack',version:'1',packRoot,script:'main.py',scriptSha256:options.digest??sha256(script),pythonExecutable:'/usr/bin/python3',
    outputSchema:z.object({value:z.string()}).strict(),timeoutMs:options.timeoutMs,maxInputBytes:options.maxInputBytes,maxOutputBytes:options.maxOutputBytes},fixtureLauncher);
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  return {directory,packRoot,workspace,inputPath,executor};
}

test('trusted Python pack reads only staged input and returns schema-checked bounded JSON',async t=>{
  const script=`import json\nrequest=json.load(open('request.json'))\ntext=open(request['inputs'][0]['path']).read()\nprint(json.dumps({'value':text}))\n`;
  const f=fixture(t,script),result=await f.executor.run({workspace:f.workspace,inputPaths:[f.inputPath]});
  assert.deepEqual(result,{status:'succeeded',output:{value:'Generated Python Source Pack input.'}});
  const profile=macPythonSandboxProfile('/private/tmp/generated-run','/usr/bin/python3',['/usr/bin','/usr/lib']);
  assert.match(profile,/\(deny default\)/);assert.doesNotMatch(profile,/allow network/);
  assert.match(profile,/file-write\* \(subpath "\/private\/tmp\/generated-run"\)/);
});

test('pack changes, outside inputs, output limits and invalid JSON fail with fixed codes',async t=>{
  const changed=fixture(t,"print('{}')\n",{digest:'0'.repeat(64)});
  assert.deepEqual(await changed.executor.run({workspace:changed.workspace,inputPaths:[changed.inputPath]}),{status:'blocked',code:'pack_changed'});
  const outside=fixture(t,"print('{}')\n");
  assert.deepEqual(await outside.executor.run({workspace:outside.workspace,inputPaths:[changed.inputPath]}),{status:'blocked',code:'invalid_input'});
  const oversized=fixture(t,"print('x' * 5000)\n",{maxOutputBytes:512});
  assert.deepEqual(await oversized.executor.run({workspace:oversized.workspace,inputPaths:[oversized.inputPath]}),{status:'failed',code:'output_limit'});
  const invalid=fixture(t,"print('not json')\n");
  assert.deepEqual(await invalid.executor.run({workspace:invalid.workspace,inputPaths:[invalid.inputPath]}),{status:'failed',code:'invalid_output'});
  const limited=fixture(t,"print('{}')\n",{maxInputBytes:4});
  assert.deepEqual(await limited.executor.run({workspace:limited.workspace,inputPaths:[limited.inputPath]}),{status:'failed',code:'input_limit'});
});

test('deadline and cancellation stop a Python child without returning partial output',async t=>{
  const script="import time\nprint('{\"value\":\"partial\"}', flush=True)\ntime.sleep(5)\n";
  const timed=fixture(t,script,{timeoutMs:100});
  assert.deepEqual(await timed.executor.run({workspace:timed.workspace,inputPaths:[timed.inputPath]}),{status:'timed_out',code:'timeout'});
  const cancelled=fixture(t,script),controller=new AbortController();
  const running=cancelled.executor.run({workspace:cancelled.workspace,inputPaths:[cancelled.inputPath],signal:controller.signal});
  setTimeout(()=>controller.abort(),100);
  assert.deepEqual(await running,{status:'cancelled',code:'cancelled'});
});

test('macOS sandbox permits staged input but denies files and network outside it',
  {skip:process.platform!=='darwin'||process.env.MOTE_TEST_PYTHON_OS_SANDBOX!=='1'},async t=>{
  const script=`import json, socket\nr=json.load(open('request.json'))\nresult=[open(r['inputs'][0]['path']).read()]\n`+
    `try:\n open('/private/etc/hosts').read(); result.append('outside-read-open')\nexcept OSError:\n result.append('outside-read-denied')\n`+
    `try:\n open(r['config']['outsidePath'],'w').write('escape'); result.append('outside-write-open')\nexcept OSError:\n result.append('outside-write-denied')\n`+
    `try:\n s=socket.socket(); s.connect(('127.0.0.1',9)); result.append('network-open')\nexcept OSError:\n result.append('network-denied')\n`+
    `print(json.dumps({'value':'|'.join(result)}))\n`;
  const f=fixture(t,script),outsidePath=join(f.directory,'escape.txt');
  const executor=new PythonSourcePackExecutor({id:'fixture.os-sandbox',version:'1',packRoot:f.packRoot,script:'main.py',scriptSha256:sha256(script),
    pythonExecutable:'/Library/Developer/CommandLineTools/usr/bin/python3',outputSchema:z.object({value:z.string()}).strict()});
  const result=await executor.run({workspace:f.workspace,inputPaths:[f.inputPath],config:{outsidePath}});
  assert.deepEqual(result,{status:'succeeded',output:{value:'Generated Python Source Pack input.|outside-read-denied|outside-write-denied|network-denied'}});
  assert.equal(existsSync(outsidePath),false);
});

test('trusted Python pack emits dispositions and an explicit automatic publication assessment',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-python-import-consumer-')),packRoot=join(directory,'pack');mkdirSync(packRoot,{mode:0o700});
  const script=`import json\nr=json.load(open('request.json'))\ntext=open(r['inputs'][0]['path']).read()\nprint(json.dumps({'summary':'Generated Python import preview','warnings':[],
 'reviewDecision':{'confidence':'high','ambiguous':False,'reason':'Exact generated text mapping'},
 'dispositions':[{'index':0,'status':'parsed','reason':'Exact generated source text'}],
 'records':[{'item':{'externalId':'generated-entry','revision':'1','observedAt':'2026-09-24T01:00:00Z','kind':'file','layer':'original','title':'Generated note','text':text},'evidenceIndexes':[0],'attachmentIndexes':[]}]}))\n`;
  writeFileSync(join(packRoot,'main.py'),script,{mode:0o600});
  const executor=new PythonSourcePackExecutor({id:'fixture.import-pack',version:'1',packRoot,script:'main.py',scriptSha256:sha256(script),pythonExecutable:'/usr/bin/python3',outputSchema:pythonImportOutputSchema},fixtureLauncher);
  const store=new Store(join(directory,'vault')),files=new ArchivedFileStore(store),sources=new SourceStore(store),imports=new ImportStore(store,files,sources,{prepare:pythonImportPreparation(executor)});
  t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  const job=await imports.create({processing:'automatic',files:[{name:'generated.custom',dataBase64:Buffer.from('Generated import evidence.').toString('base64')}]});
  const saved=await imports.prepare(job.id);assert.equal(saved.status,'completed');assert.equal(saved.preview?.count,1);
  assert.equal(saved.reviewGate?.decision,'automatic');assert.equal(saved.captureIds.length,1);
  assert.equal(store.evidence(saved.captureIds)[0].ocrText,'Generated import evidence.');
});
