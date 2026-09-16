import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {zipSync} from 'fflate';
import {Store} from '../src/store.js';
import {ArchivedFileStore} from '../src/archived-files.js';
import {SourceStore} from '../src/sources.js';
import {ImportStore,type ImportRuntime} from '../src/imports.js';

const entry=(name:string,text:string)=>({name,dataBase64:Buffer.from(text).toString('base64')});
const item=(externalId='fixture-1')=>({externalId,revision:'v1',observedAt:'2026-09-15T12:00:00Z',kind:'file',layer:'original',title:'合成日记',text:'2020年的合成原文\n保留换行和引用。',document:{recordedAt:'2020-01-01T10:00:00Z',timeBasis:'recorded',contentRole:'authored'}});
function fixture(t:any,runtime:ImportRuntime={}){const directory=mkdtempSync(join(tmpdir(),'mote-import-')),store=new Store(directory),files=new ArchivedFileStore(store),sources=new SourceStore(store),imports=new ImportStore(store,files,sources,runtime);t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});return {directory,store,files,sources,imports};}
test('originals archive before model configuration without manufacturing parsed evidence',async t=>{
 const {imports,files,store,directory}=fixture(t),job=await imports.create({files:[entry('unknown.xyz','synthetic bytes')]});
 assert.equal(job.status,'queued');assert.equal(files.read(job.files[0].id).toString(),'synthetic bytes');assert.equal(store.list().items.length,0);
 const result=await imports.prepare(job.id);assert.equal(result.status,'needs_configuration');assert.equal(result.preview,undefined);assert.equal(existsSync(join(directory,'imports',job.id,'inputs')),false);
 await assert.rejects(imports.confirm(job.id),{statusCode:409});
});
test('generic model manifest previews, confirms, retains attachments and notifies only new IDs once',async t=>{
 const notified:string[][]=[];
 const {imports,store,files}=fixture(t,{prepare:async({workspace,inputPaths,instruction})=>{
   assert.equal(instruction,'只导入原始日记');assert.equal(readFileSync(inputPaths[0],'utf8'),'synthetic diary');
   writeFileSync(join(workspace,'records.jsonl'),JSON.stringify({item:item(),evidencePaths:[inputPaths[0]],attachments:[inputPaths[1]]})+'\n');
   return {summary:'1 条原始日记，配置文件未作为证据。',warnings:['合成配置仅保存在原始归档。']};
 },onImported:async(ids)=>{notified.push(ids);return {memoryJobId:'memory-fixture'};}});
 const job=await imports.create({instruction:'只导入原始日记',files:[entry('diary.any','synthetic diary'),entry('image.unknown','attachment bytes'),entry('settings.json','{"syntheticSecret":"not evidence"}')]});
 const preview=await imports.prepare(job.id);assert.equal(preview.status,'awaiting_confirmation');assert.equal(preview.preview?.count,1);assert.equal(store.list().items.length,0);
 const saved=await imports.confirm(job.id);assert.equal(saved.status,'completed');assert.equal(saved.progress.imported,1);assert.equal(saved.memoryJobId,'memory-fixture');assert.deepEqual(notified,[saved.captureIds]);
 assert.equal(store.evidence(saved.captureIds)[0].ocrText,item().text);assert.equal(store.evidence(saved.captureIds)[0].provenance?.document?.recordedAt,'2020-01-01T10:00:00Z');
 assert.equal(files.listForCapture(saved.captureIds[0]).length,2);assert.equal(store.search({query:'syntheticSecret'}).length,0);
 assert.equal((await imports.confirm(job.id)).status,'completed');assert.equal(notified.length,1);
});
test('ZIP expands generic files and rejects traversal while retaining supplied original',async t=>{
 const {imports,files}=fixture(t);const zip=zipSync({'folder/note.txt':Buffer.from('synthetic note'),'assets/data.bin':Buffer.from([0,1,2])});
 const job=await imports.create({files:[{name:'backup.zip',dataBase64:Buffer.from(zip).toString('base64')}]});assert.equal(job.archive.expandedFiles,2);assert.equal(job.files.length,3);assert.deepEqual(files.read(job.files[0].id),Buffer.from(zip));
 const bad=zipSync({'../escape.txt':Buffer.from('bad path')});const rejected=await imports.create({files:[{name:'unsafe.zip',dataBase64:Buffer.from(bad).toString('base64')}]});assert.equal(rejected.status,'failed');assert.equal(rejected.files.length,1);assert.match(rejected.error!,/expansion failed/);
});
test('invalid manifests never partially import; original bytes survive and instructions can be revised',async t=>{
 let calls=0;const {imports,store}=fixture(t,{prepare:async({workspace,inputPaths})=>{calls++;writeFileSync(join(workspace,'records.jsonl'),JSON.stringify({item:item(),evidencePaths:inputPaths})+'\n'+(calls===1?'not json\n':''));return {summary:'synthetic parser output'};}});
 const job=await imports.create({files:[entry('fixture.json','{}')]});assert.equal((await imports.prepare(job.id)).status,'failed');assert.equal(store.list().items.length,0);
 imports.updateInstruction(job.id,'重试通用解析');assert.equal((await imports.retry(job.id)).status,'awaiting_confirmation');assert.equal((await imports.confirm(job.id)).progress.imported,1);
});
test('manifest source paths and changed preview are rejected',async t=>{
 const {imports,directory}=fixture(t,{prepare:async({workspace})=>{writeFileSync(join(workspace,'records.jsonl'),JSON.stringify({item:item(),evidencePaths:['../outside']})+'\n');return {summary:'bad fixture'};}});
 const job=await imports.create({files:[entry('fixture.txt','fixture')]});assert.equal((await imports.prepare(job.id)).status,'failed');assert.match(imports.get(job.id).error!,/outside/);
 const other=new ImportStore(imports.store,imports.files,imports.sources,{prepare:async({workspace,inputPaths})=>{writeFileSync(join(workspace,'records.jsonl'),JSON.stringify({item:item(),evidencePaths:inputPaths})+'\n');return {summary:'valid fixture'};}});
 await other.prepare(job.id);writeFileSync(join(directory,'imports',job.id,'prepared.jsonl'),'changed');assert.equal((await other.confirm(job.id)).status,'failed');assert.match(other.get(job.id).error!,/preview changed/);
});
test('retry after memory callback failure resumes archive without duplicate captures',async t=>{
 let attempts=0;const {imports,store}=fixture(t,{prepare:async({workspace,inputPaths})=>{writeFileSync(join(workspace,'records.jsonl'),JSON.stringify({item:item(),evidencePaths:inputPaths})+'\n');return {summary:'one fixture'};},onImported:async ids=>{assert.equal(ids.length,1);if(++attempts===1)throw Error('synthetic temporary failure');return {memoryJobId:'recovered'};}});
 const job=await imports.create({files:[entry('fixture.txt','fixture')]});await imports.prepare(job.id);const failed=await imports.confirm(job.id);assert.equal(failed.status,'failed');assert.equal(failed.progress.imported,1);
 const result=await imports.retry(job.id);assert.equal(result.status,'completed');assert.equal(result.memoryJobId,'recovered');assert.equal(store.list().items.length,1);assert.equal(result.captureIds.length,1);
});
test('per-file dispositions expose unsupported originals and cannot contradict evidence selection',async t=>{
 let invalid=false;const {imports}=fixture(t,{prepare:async({workspace,inputPaths})=>{
   writeFileSync(join(workspace,'records.jsonl'),JSON.stringify({item:item(),evidencePaths:[inputPaths[0]]})+'\n');
   writeFileSync(join(workspace,'dispositions.json'),JSON.stringify({items:inputPaths.map((path,index)=>({path,status:index?'unsupported':invalid?'excluded':'parsed',reason:index?'Synthetic binary needs another parser':'Synthetic authored text'}))}));
   return {summary:'One fixture parsed, another original retained.'};
 }});
 const job=await imports.create({files:[entry('entry.txt','synthetic text'),entry('binary.custom','binary fixture')]});const preview=await imports.prepare(job.id);
 assert.equal(preview.status,'awaiting_confirmation');assert.equal(preview.dispositions?.counts.unsupported,1);assert.equal(preview.dispositions?.counts.parsed,1);assert.ok(preview.warnings.some(w=>w.includes('unsupported')));
 invalid=true;imports.updateInstruction(job.id,'test contradictory disposition');const rejected=await imports.prepare(job.id);assert.equal(rejected.status,'failed');assert.match(rejected.error!,/marked parsed/);
});
test('record, attachments and progress commit together; partial failures resume exact new IDs',async t=>{
 const batches:string[][]=[];const {imports,files,store}=fixture(t,{prepare:async({workspace,inputPaths})=>{writeFileSync(join(workspace,'records.jsonl'),['first','second'].map(id=>JSON.stringify({item:item(id),evidencePaths:inputPaths})).join('\n'));return {summary:'two fixtures'};},onImported:async ids=>{batches.push(ids);return {memoryJobId:'exact-batch'};}});
 const attach=files.attach.bind(files);let fail=true;
 files.attach=(id,ids)=>{if(fail&&store.evidence([id])[0].provenance?.externalId==='second'){fail=false;throw new Error('Synthetic interrupted attachment');}attach(id,ids);};
 const job=await imports.create({files:[entry('two.txt','two synthetic records')]});await imports.prepare(job.id);const stopped=await imports.confirm(job.id);
 assert.equal(stopped.status,'failed');assert.equal(stopped.progress.processed,1);assert.equal(store.list().items.length,1);assert.equal(stopped.captureIds.length,1);
 const saved=await imports.retry(job.id);assert.equal(saved.progress.imported,2);assert.equal(saved.captureIds.length,2);assert.deepEqual(batches,[saved.captureIds]);assert.equal(store.list().items.length,2);
 const duplicate=await imports.create({files:[entry('two.txt','two synthetic records')]});await imports.prepare(duplicate.id);const again=await imports.confirm(duplicate.id);
 assert.equal(again.progress.duplicates,2);assert.deepEqual(again.captureIds,[]);assert.equal(batches.length,1);
});
test('missing model runtime reports configuration state by error type and retains originals',async t=>{
 const {imports}=fixture(t,{prepare:async()=>{const error=new Error('Choose a model first');error.name='AgentNotConfiguredError';throw error;}});
 const job=await imports.create({files:[entry('fixture.txt','synthetic')]});const result=await imports.prepare(job.id);assert.equal(result.status,'needs_configuration');assert.equal(result.files.length,1);
});
test('deleting an import preserves shared originals until the last owning job is removed',async t=>{
 const {imports,files,store,directory}=fixture(t,{prepare:async({workspace,inputPaths})=>{writeFileSync(join(workspace,'records.jsonl'),JSON.stringify({item:item(),evidencePaths:inputPaths})+'\n');return {summary:'one fixture'};}});
 const request={files:[entry('shared.txt','synthetic original')]},first=await imports.create(request),second=await imports.create(request);await imports.prepare(first.id);await imports.confirm(first.id);await imports.prepare(second.id);await imports.confirm(second.id);
 const file=first.files[0];assert.equal(imports.delete(first.id).retainedSharedSource,true);assert.equal(store.list().items.length,1);assert.equal(files.read(file.id).toString(),'synthetic original');
 const deleted=imports.delete(second.id);assert.equal(deleted.captures,1);assert.equal(deleted.files,1);assert.equal(store.list().items.length,0);assert.throws(()=>files.get(file.id),{statusCode:404});assert.equal(existsSync(join(directory,'files',file.hash)),false);
 const reuploaded=await imports.create(request);assert.notEqual(reuploaded.sourceId,first.sourceId);await imports.prepare(reuploaded.id);assert.equal((await imports.confirm(reuploaded.id)).progress.imported,1);
});
test('running imports cannot be deleted',async t=>{
 let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});const {imports}=fixture(t,{prepare:async()=>{await gate;return {summary:'No synthetic records'};}});
 const job=await imports.create({files:[entry('fixture.bin','fixture')]});const running=imports.prepare(job.id);assert.throws(()=>imports.delete(job.id),{statusCode:409});release();await running;assert.equal(imports.delete(job.id).deleted,true);
});
