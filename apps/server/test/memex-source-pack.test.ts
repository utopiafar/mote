import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {zipSync,strToU8} from 'fflate';
import {Store,sha256} from '../src/store.js';
import {SourceStore} from '../src/sources.js';
import {ArchivedFileStore} from '../src/archived-files.js';
import {ImportStore} from '../src/imports.js';
import {PythonSourcePackExecutor,pythonImportOutputSchema,pythonImportPreparation,type PythonSandboxLauncher} from '../src/python-source-pack-executor.js';

const fixtureLauncher:PythonSandboxLauncher=(workspace,python,runner)=>({command:python,args:['-I','-B',runner],cwd:workspace,
  env:{PATH:'/usr/bin:/bin',HOME:workspace,TMPDIR:workspace,PYTHONNOUSERSITE:'1',PYTHONDONTWRITEBYTECODE:'1'}});

function setup(t:import('node:test').TestContext){
  const directory=mkdtempSync(join(tmpdir(),'mote-memex-pack-'));
  const packRoot=resolve(import.meta.dirname,'../../..','plugins/source-packs/memex-markdown');
  const executor=new PythonSourcePackExecutor({id:'memex.markdown',version:'1',packRoot,script:'main.py',scriptSha256:sha256(readFileSync(join(packRoot,'main.py'))),
    pythonExecutable:'/usr/bin/python3',maxInputFiles:256,config:{timeZoneOffset:'+08:00'},outputSchema:pythonImportOutputSchema},fixtureLauncher);
  const store=new Store(join(directory,'vault')),files=new ArchivedFileStore(store),sources=new SourceStore(store);
  const imports=new ImportStore(store,files,sources,{sourcePacks:new Map([['memex.markdown',{revision:'generated',prepare:pythonImportPreparation(executor)}]])});
  t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  return {store,files,imports};
}

test('Memex Source Pack imports a generated multiweek ZIP through the existing archive and review engine',async t=>{
  const {store,files,imports}=setup(t),entries:Record<string,Uint8Array>={};
  const original='\nA generated experience. 🙂\r\n![saved](assets/photo.png)\r\n';
  for(let day=1;day<=20;day++){const date=`2026-05-${String(day).padStart(2,'0')}`;entries[`export/${date}.md`]=strToU8(`# ${date}\n\n## 09:10:11\n`+(day===1?original:'\nA generated daily note.\n'));}
  entries['export/assets/photo.png']=Buffer.from('Generated attachment bytes');
  const zipped=zipSync(entries),job=await imports.create({processing:'automatic',sourcePackId:'memex.markdown',files:[{name:'generated.zip',dataBase64:Buffer.from(zipped).toString('base64')}]});
  const complete=await imports.prepare(job.id);assert.equal(complete.status,'completed',complete.error);assert.equal(complete.preview?.count,20);assert.equal(complete.archive.files,22);
  assert.deepEqual(complete.dispositions?.counts,{parsed:20,attachment:1,container:1,excluded:0,unsupported:0});
  const first=store.evidence(complete.captureIds).find(row=>row.provenance?.document?.recordedAt==='2026-05-01T09:10:11+08:00');assert.ok(first);
  assert.equal(first.ocrText,original);assert.notEqual(first.capturedAt,first.provenance?.document?.recordedAt);
  const document=first.provenance!.document!;assert.equal(document.timeBasis,'recorded');assert.equal(document.attachments?.length,1);
  const attached=files.listForCapture(first.id);assert.equal(attached.length,2);assert.ok(attached.some(file=>file.relativePath.endsWith('/assets/photo.png')));
  assert.equal(document.originalMetadata?.timeZoneBasis,'parser_configuration');
  const confirmed=await imports.confirm(job.id);assert.equal(confirmed.captureIds.length,20);assert.equal(store.evidence(complete.captureIds).length,20);
});

test('literal code and same-second entries stay distinct; missing images require review without dropping text',async t=>{
  const {store,imports}=setup(t),one='\nA literal example:\n```md\n## 12:34:56\n```\n',two='\nAnother entry at the same time. ![missing](assets/absent.jpg)\n';
  const raw='# 2026-05-01\n\n## 09:00:00\n'+one+'## 09:00:00\n'+two;
  const job=await imports.create({processing:'automatic',sourcePackId:'memex.markdown',files:[{name:'2026-05-01.md',dataBase64:Buffer.from(raw).toString('base64')}]});
  const preview=await imports.prepare(job.id);assert.equal(preview.status,'awaiting_confirmation',preview.error);assert.equal(preview.preview?.count,2);assert.ok(preview.warnings.length);
  const complete=await imports.confirm(job.id),evidence=store.evidence(complete.captureIds);assert.equal(evidence.length,2);assert.deepEqual(new Set(evidence.map(row=>row.ocrText)),new Set([one,two]));
  assert.equal(new Set(evidence.map(row=>row.provenance?.externalId)).size,2);assert.ok(evidence.every(row=>!row.provenance?.document?.occurredAt));
});
