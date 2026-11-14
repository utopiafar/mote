import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {DeepSeekHarness} from '@deepseek-ai/dsh-sdk-client';
import type {AgentOptions} from '@mote/agent';
import type {ModelSettings} from '@mote/shared/models';
import {createAgentImportHost,type ImportCapabilityFactory} from '../src/agent-import-host.js';
import {BackgroundModelAuthorization,modelConnection} from '../src/background-model-authorization.js';
import {ArchivedFileStore} from '../src/archived-files.js';
import {ExecutionEngine} from '../src/execution-engine.js';
import {ImportStore} from '../src/imports.js';
import {SourceStore} from '../src/sources.js';
import {Store} from '../src/store.js';

const settings:ModelSettings={
  provider:'custom',protocol:'openai-completions',model:'generated-model',baseUrl:'http://127.0.0.1:9/v1',apiKey:'generated-key',
  headers:{},extraBody:{},reasoningEffort:'off',maxTokens:1024,modelRequestTimeoutMs:10000,agentTimeoutMs:15000,allowUnauthenticatedLocal:false,
};

function fixture(t:any,options:{capability?:ImportCapabilityFactory;hostAuthorization?:Pick<BackgroundModelAuthorization,'capture'>;assertCurrent?:()=>void;settings?:ModelSettings;codex?:AgentOptions['codex']}={}){
  const directory=mkdtempSync(join(tmpdir(),'mote-agent-import-host-')),store=new Store(directory),files=new ArchivedFileStore(store),sources=new SourceStore(store);
  const selected=options.settings??settings;
  const connection=modelConnection('profile:generated-profile:'+selected.model,selected),authorization=new BackgroundModelAuthorization(store,()=>[connection]);
  const executor=new ExecutionEngine(store);executor.bindModelAuthority(authorization);
  const assertCurrent=options.assertCurrent??(()=>authorization.assertCurrent(connection));
  const usage={run:async<V>(task:()=>Promise<V>)=>task(),update(){},completed(){return undefined;},failed(){return undefined;}};
  const host=createAgentImportHost({
    agent:{configured:true,configuredFor:()=>true},
    modelSettings:{select:()=>({id:'generated-profile',name:'Generated profile',settings:selected})},
    modelAuthorization:options.hostAuthorization??authorization,
    authorizeModelRequest:assertCurrent,
    runModelFor:()=>async(task,signal)=>{signal?.throwIfAborted();assertCurrent();return task();},
    codex:options.codex,
    admittedUsage:()=>usage,
    agentGate:{run:task=>task()},
    modelOperation:{run:(_id,task)=>task()},
    providerAdmission:{run:async(_settings,task)=>task()},
    ...(options.capability?{capability:options.capability}:{}),
  });
  const imports=new ImportStore(store,files,sources,{
    executor,
    prepare:input=>host.prepare(input),
    bindPhaseAuthority:step=>{
      if(authorization.ownerIntent(step.operationId)&&!authorization.stepAuthority(step.id))authorization.bindCurrentStep(step);
    },
  });
  t.after(async()=>{
    await imports.stop();await host.close();await executor.close();authorization.close();store.close();rmSync(directory,{recursive:true,force:true});
  });
  return {directory,store,files,imports,authorization,connection};
}

async function ownerPrepare(imports:ImportStore,authorization:BackgroundModelAuthorization,connection:{id:string;fingerprint:string},id:string){
  const work='owner-import:'+randomUUID();
  authorization.manual(work,'manual',['import:'+id],[connection]);
  return authorization.run(work,()=>imports.prepare(id));
}

function generatedInput(text:string){
  return {name:'generated-'+randomUUID()+'.custom',dataBase64:Buffer.from(text).toString('base64')};
}

test('DSH fixture preview is consumed by ImportRuntime and manifest while archive stays unpublished',{timeout:30000},async t=>{
  const {store,files,imports,authorization,connection}=fixture(t);
  const requests:any[]=[];
  t.mock.method(DeepSeekHarness.prototype,'run',async(prompt:string)=>{
    const request=JSON.parse(prompt);requests.push(request);
    assert.equal(request.requiredSkill,'document-import');
    assert.equal(request.taskId,'import');assert.equal(request.taskVersion,'1');
    assert.equal(request.language,'zh-CN');
    const original=readFileSync(request.inputPaths[0],'utf8');
    writeFileSync(join(request.workspace,'records.jsonl'),JSON.stringify({
      item:{externalId:'generated-diary',revision:'v1',observedAt:'2026-09-15T12:00:00Z',kind:'file',layer:'original',title:'Generated diary title',text:original,
        document:{recordedAt:'2020-01-01T10:00:00Z',timeBasis:'recorded',contentRole:'authored'}},
      evidencePaths:[request.inputPaths[0]],attachments:[request.inputPaths[1]],
    })+'\n');
    writeFileSync(join(request.workspace,'dispositions.json'),JSON.stringify({items:[
      {path:request.inputPaths[0],status:'parsed',reason:'Generated authored text'},
      {path:request.inputPaths[1],status:'attachment',reason:'Generated retained attachment'},
    ]}));
    return {events:[],finalResponse:JSON.stringify({summary:'Generated preview summary',recordsPath:'records.jsonl',
      warnings:['Generated preview warning'],reviewDecision:{confidence:'low',ambiguous:true,reason:'Generated review ambiguity'}})};
  });
  t.mock.method(DeepSeekHarness.prototype,'close',async()=>{});

  const created=await imports.create({processing:'preview',instruction:'Generated owner import',files:[generatedInput('Generated original diary text'),generatedInput('Generated attachment bytes')]});
  const preview=await ownerPrepare(imports,authorization,connection,created.id);
  assert.equal(requests.length,1);
  assert.equal(preview.status,'awaiting_confirmation');
  assert.equal(preview.preview?.count,1);
  assert.ok(preview.warnings.includes('Generated preview warning'));
  assert.match(preview.reviewGate?.reason??'',/manual preview/);
  assert.deepEqual(preview.captureIds,[]);
  assert.equal(store.list().items.length,0,'the import runtime returns review candidates only');
  assert.equal(files.read(created.files[0]!.id).toString(),'Generated original diary text');
  assert.equal(files.read(created.files[1]!.id).toString(),'Generated attachment bytes');

  const stored=JSON.parse(readFileSync(join(imports.directory,created.id,'prepared.jsonl'),'utf8').trim());
  assert.equal(stored.item.title,'Generated diary title');
  assert.equal(stored.item.document.recordedAt,'2020-01-01T10:00:00Z');
  assert.equal(stored.item.text,'Generated original diary text');

  const completed=await imports.confirm(created.id);
  assert.equal(completed.status,'completed');
  assert.equal(completed.progress.imported,1);
  const evidence=store.evidence(completed.captureIds)[0]!;
  assert.equal(evidence.ocrText,'Generated original diary text');
  assert.equal(evidence.provenance?.document?.recordedAt,'2020-01-01T10:00:00Z');
  assert.equal(files.read(created.files[0]!.id).toString(),'Generated original diary text');
  assert.equal(files.read(created.files[1]!.id).toString(),'Generated attachment bytes');
});

test('Codex App Server fixture preview is consumed by the same ImportRuntime and manifest as DSH',{timeout:30000},async t=>{
  const root=mkdtempSync(join(tmpdir(),'mote-codex-import-')),executable=join(root,'generated-codex.mjs'),rpcPath=join(root,'rpc.ndjson');
  writeFileSync(join(root,'auth.json'),JSON.stringify({OPENAI_API_KEY:'generated-unused'}),{mode:0o600});
  writeFileSync(executable,`#!${process.execPath}
// Protocol fixture only; the real native send gate has separate coverage.
if(process.argv[2]==='--mote-context-budget-version'){process.stdout.write('mote-context-budget-v1\\n');process.exit(0);}
import readline from 'node:readline';
import {appendFileSync,readFileSync,writeFileSync} from 'node:fs';
const rpc=value=>appendFileSync(${JSON.stringify(rpcPath)},JSON.stringify(value)+'\\n');
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);rpc(m);
 if(m.method==='initialize')send({id:m.id,result:{}});
 else if(m.method==='account/read')send({id:m.id,result:{account:{type:'apiKey'}}});
 else if(m.method==='thread/start')send({id:m.id,result:{thread:{id:'generated-thread',model:m.params.model},model:m.params.model,serviceTier:m.params.serviceTier,approvalPolicy:'never',sandbox:{type:'workspaceWrite'}}});
 else if(m.method==='turn/start'){
  const request=JSON.parse(m.params.input[0].text),original=readFileSync(request.inputPaths[0],'utf8'),attachment=request.inputPaths[1];
  send({id:m.id,result:{turn:{id:'generated-turn'}}});
  writeFileSync('records.jsonl',JSON.stringify({item:{externalId:'generated-codex-diary',revision:'v1',observedAt:'2026-09-15T12:00:00Z',kind:'file',layer:'original',title:'Generated Codex diary title',text:original,document:{recordedAt:'2020-01-01T10:00:00Z',timeBasis:'recorded',contentRole:'authored'}},evidencePaths:[request.inputPaths[0]],attachments:[attachment]})+'\\n');
  writeFileSync('dispositions.json',JSON.stringify({items:[{path:request.inputPaths[0],status:'parsed',reason:'Generated authored text'},{path:attachment,status:'attachment',reason:'Generated retained attachment'}]}));
  send({method:'item/completed',params:{threadId:'generated-thread',item:{id:'generated-message',type:'agentMessage',text:JSON.stringify({summary:'Generated Codex preview summary',recordsPath:'records.jsonl',warnings:['Generated Codex preview warning'],reviewDecision:{confidence:'low',ambiguous:true,reason:'Generated Codex review ambiguity'}})}}});
  send({method:'turn/completed',params:{threadId:'generated-thread',turn:{status:'completed'}}});
 }
});
`,{mode:0o700});
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const codexSettings:ModelSettings={...settings,provider:'codex',protocol:'codex-app-server',model:'generated-codex-model',baseUrl:'',apiKey:'',reasoningEffort:'auto',modelRequestTimeoutMs:null};
  const {store,files,imports,authorization,connection}=fixture(t,{settings:codexSettings,codex:{executable,home:root}});

  const created=await imports.create({processing:'preview',instruction:'Generated owner import',files:[generatedInput('Generated original diary text'),generatedInput('Generated attachment bytes')]});
  const preview=await ownerPrepare(imports,authorization,connection,created.id);
  const rpc=readFileSync(rpcPath,'utf8').trim().split('\n').map(line=>JSON.parse(line));
  const thread=rpc.find(message=>message.method==='thread/start').params,turn=rpc.find(message=>message.method==='turn/start').params;
  assert.equal(thread.ephemeral,true);assert.equal(thread.sandbox,'workspace-write');assert.deepEqual(thread.dynamicTools,[],'import workspace never receives archive tools');
  const request=JSON.parse(turn.input[0].text);
  assert.equal(request.requiredSkill,'document-import');assert.equal(request.taskId,'import');assert.equal(request.taskVersion,'1');assert.equal(request.language,'zh-CN');
  assert.equal(preview.status,'awaiting_confirmation');
  assert.equal(preview.preview?.count,1);
  assert.ok(preview.warnings.includes('Generated Codex preview warning'));
  assert.match(preview.reviewGate?.reason??'',/manual preview/);
  assert.deepEqual(preview.captureIds,[]);
  assert.equal(store.list().items.length,0,'the Codex runtime returns review candidates only');
  assert.equal(files.read(created.files[0]!.id).toString(),'Generated original diary text');
  assert.equal(files.read(created.files[1]!.id).toString(),'Generated attachment bytes');

  const stored=JSON.parse(readFileSync(join(imports.directory,created.id,'prepared.jsonl'),'utf8').trim());
  assert.equal(stored.item.title,'Generated Codex diary title');
  assert.equal(stored.item.document.recordedAt,'2020-01-01T10:00:00Z');
  assert.equal(stored.item.text,'Generated original diary text');

  const completed=await imports.confirm(created.id);
  assert.equal(completed.status,'completed');
  assert.equal(completed.progress.imported,1);
  const evidence=store.evidence(completed.captureIds)[0]!;
  assert.equal(evidence.ocrText,'Generated original diary text');
  assert.equal(evidence.provenance?.document?.recordedAt,'2020-01-01T10:00:00Z');
});

test('a cancelled import cannot publish a late manifest from the DSH fixture',{timeout:30000},async t=>{
  const {store,files,imports,authorization,connection}=fixture(t);
  let entered!:()=>void,release!:()=>void;
  const started=new Promise<void>(resolve=>entered=resolve),gate=new Promise<void>(resolve=>release=resolve);
  t.mock.method(DeepSeekHarness.prototype,'run',async(prompt:string)=>{
    const request=JSON.parse(prompt);entered();await gate;
    writeFileSync(join(request.workspace,'records.jsonl'),JSON.stringify({
      item:{externalId:'generated-late',revision:'v1',observedAt:'2026-09-15T12:00:00Z',kind:'file',layer:'original',title:'Generated late',text:'Generated late manifest'},
      evidencePaths:[request.inputPaths[0]],attachments:[],
    })+'\n');
    writeFileSync(join(request.workspace,'dispositions.json'),JSON.stringify({items:[{path:request.inputPaths[0],status:'parsed',reason:'Generated late text'}]}));
    return {events:[],finalResponse:JSON.stringify({summary:'Generated late preview'})};
  });
  t.mock.method(DeepSeekHarness.prototype,'close',async()=>{});

  const created=await imports.create({processing:'preview',files:[generatedInput('Generated cancellation original')]});
  const pending=ownerPrepare(imports,authorization,connection,created.id);
  await started;
  assert.equal(imports.cancel(created.id).status,'cancelled');
  release();
  const result=await pending;
  assert.equal(result.status,'cancelled');
  assert.equal(result.preview,undefined);
  assert.deepEqual(result.captureIds,[]);
  assert.equal(store.list().items.length,0,'a late manifest cannot publish a cancelled import');
  assert.equal(files.read(created.files[0]!.id).toString(),'Generated cancellation original');
});

test('revoked model authority stops further sends and rejects the returned manifest',{timeout:30000},async t=>{
  let sends=0,blocked=false,closed=0,revoked=false;
  const assertCurrent=()=>{if(revoked)throw new Error('Background model processing needs owner authorization');};
  const {store,files,imports,authorization,connection}=fixture(t,{
    hostAuthorization:{capture:()=>assertCurrent},
    assertCurrent,
    capability:options=>({
      async prepare(input){
        await options.runModel!(async()=>{sends++;});
        revoked=true;
        try{await options.runModel!(async()=>{sends++;});}catch{blocked=true;}
        writeFileSync(join(input.workspace,'records.jsonl'),JSON.stringify({
          item:{externalId:'generated-revoked',revision:'v1',observedAt:'2026-09-15T12:00:00Z',kind:'file',layer:'original',title:'Generated revoked',text:'Generated revoked manifest'},
          evidencePaths:[input.inputPaths[0]],attachments:[],
        })+'\n');
        return {summary:'Generated revoked preview'};
      },
      async close(){closed++;},
    }),
  });

  const created=await imports.create({processing:'preview',files:[generatedInput('Generated authorization original')]});
  const result=await ownerPrepare(imports,authorization,connection,created.id);
  assert.equal(blocked,true,'a second send is refused after revocation');
  assert.equal(sends,1);
  assert.equal(result.status,'failed');
  assert.match(result.error??'',/owner authorization/);
  assert.equal(result.preview,undefined);
  assert.deepEqual(result.captureIds,[]);
  assert.equal(store.list().items.length,0,'a manifest returned after revocation cannot write back');
  assert.equal(files.read(created.files[0]!.id).toString(),'Generated authorization original');
  assert.ok(closed>=1);
});
