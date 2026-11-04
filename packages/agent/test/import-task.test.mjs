import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,relative} from 'node:path';
import {DeepSeekHarness} from '@deepseek-ai/dsh-sdk-client';
import {AgentResponseError,TaskRegistry,prepareTaskContext} from '../dist/index.js';
import {startBridge} from '../dist/bridge.js';
import {createImportAgent} from '../dist/import-agent.js';
import {buildContextEnvelope,taskTools} from '../dist/task-context.js';
import {createRuntimePatch} from '../dist/runtime/dsh/profile-compiler.js';
import {IMPORT_SKILL_VERSION,IMPORT_TASK_VERSION,createImportTaskPack,importSkillDescriptor,importTaskDescriptor} from '../dist/tasks/import.js';

const options={model:'synthetic-model',apiKey:'synthetic-test-key',baseUrl:'http://127.0.0.1:9/v1'};

test('Import is a versioned task capability with its procedure kept off the query surface',()=>{
 const registry=new TaskRegistry(),dispose=registry.register(createImportTaskPack());
 try{
  assert.equal(importTaskDescriptor.id,'import');assert.equal(importTaskDescriptor.version,IMPORT_TASK_VERSION);
  assert.deepEqual(importTaskDescriptor.profile,{output:'answer',retrieval:'none'});
  assert.equal(importSkillDescriptor.id,'document-import');assert.equal(importSkillDescriptor.version,IMPORT_SKILL_VERSION);
  assert.equal(importSkillDescriptor.availability,'import');
  const prepared=prepareTaskContext({question:'Generated import contract',taskSelection:{id:'import',version:'1'},taskRegistry:registry});
  assert.equal(prepared.id,'import');assert.equal(prepared.version,'1');assert.deepEqual(prepared.profile,{output:'answer',retrieval:'none'});
  assert.throws(()=>prepareTaskContext({question:'Generated ordinary query',skill:'document-import',taskRegistry:registry}),error=>error?.code==='skill_unavailable');
  assert.deepEqual(taskTools({question:'Generated import contract',taskSelection:{id:'import',version:'1'},taskRegistry:registry}),[]);
  const envelope=buildContextEnvelope({question:'Generated import contract',taskSelection:{id:'import',version:'1'},taskRegistry:registry},[]);
  assert.equal(envelope.taskId,'import');assert.match(envelope.disclosurePolicy,/No archive retrieval is available/);
 }finally{dispose();}
 assert.throws(()=>registry.skill('document-import'),error=>error?.code==='unknown_skill');
 assert.throws(()=>prepareTaskContext({question:'Generated retired import',taskSelection:{id:'import',version:'1'},taskRegistry:registry}),error=>error?.code==='unknown_task');
});

test('query runtime native tools exclude shell and file capabilities',()=>{
 const queryTools=taskTools({question:'Generated ordinary query'});
 for(const forbidden of ['read','write','edit','bash','shell','exec','apply_patch'])assert.ok(!queryTools.includes(forbidden),`query exposed ${forbidden}`);
 const patch=JSON.parse(createRuntimePatch('/generated/plugin.mjs','generated-model','http://127.0.0.1:9/v1','off',1024,{protocol:'openai-completions',requestTimeoutMs:10000}));
 const disabled=new Set(patch.filter(entry=>entry.disabled).map(entry=>entry.id));
 for(const id of ['persistent-bash','persistent-pwsh','terminal-bash','terminal-pwsh','pty','subprocess'])assert.ok(disabled.has(id),`query runtime did not disable ${id}`);
 const inserted=patch.flatMap(entry=>entry.insert??[]).map(entry=>`${entry.id} ${entry.name}`);
 assert.ok(!inserted.some(entry=>/dsh-fs-local|dsh-tool-fs|bash|shell|subprocess/.test(entry)),'query runtime mounted a file or shell tool');
});

test('import preview rejects a records manifest outside the workspace before the host can archive it',async t=>{
 const root=await mkdtemp(join(tmpdir(),'mote-import-task-')),workspace=join(root,'workspace'),outside=join(root,'outside');
 await Promise.all([mkdir(workspace),mkdir(outside)]);
 const original=join(workspace,'generated.txt'),outsideManifest=join(outside,'records.jsonl');
 await writeFile(original,'Generated original remains unchanged');await writeFile(outsideManifest,JSON.stringify({summary:'Generated outside manifest'})+'\n');
 t.after(()=>rm(root,{recursive:true,force:true}));
 let calls=0;
 t.mock.method(DeepSeekHarness.prototype,'run',async prompt=>{
  const request=JSON.parse(prompt);calls++;
  if(calls===1){assert.equal(request.requiredSkill,'document-import');assert.equal(request.taskId,'import');assert.equal(request.taskVersion,'1');}
  return {events:[],finalResponse:JSON.stringify({summary:'Generated preview',recordsPath:relative(workspace,outsideManifest)})};
 });
 t.mock.method(DeepSeekHarness.prototype,'close',async()=>{});
 const agent=createImportAgent(options);t.after(()=>agent.close());
 await assert.rejects(agent.prepare({workspace,inputPaths:[original],instruction:'Generated import',helperPath:'generated-only',manifestSchema:{}}),error=>error instanceof AgentResponseError&&/workspace/.test(error.message));
 assert.equal(calls,4,'the import provider reports a bounded formatting failure without accepting the escaping path');
 assert.equal(await readFile(original,'utf8'),'Generated original remains unchanged');
 assert.equal(await readFile(outsideManifest,'utf8'),JSON.stringify({summary:'Generated outside manifest'})+'\n');
});

test('a query bridge rejects native file and shell calls without touching an original',async t=>{
 const root=await mkdtemp(join(tmpdir(),'mote-import-native-')),original=join(root,'generated.txt');
 await writeFile(original,'Generated original stays read-only');
 t.after(()=>rm(root,{recursive:true,force:true}));
 const bridge=await startBridge({question:'Generated native tool attempt'},4);t.after(()=>bridge.close());
 const call=async tool=>{const response=await fetch(`${bridge.url}/${tool}`,{method:'POST',headers:{Authorization:`Bearer ${bridge.token}`,'Content-Type':'application/json'},body:'{}'});return response.status;};
 for(const tool of ['read','write','edit','bash','shell','exec','apply_patch'])assert.equal(await call(tool),404,`query bridge accepted ${tool}`);
 assert.equal(await readFile(original,'utf8'),'Generated original stays read-only');
});
