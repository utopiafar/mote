import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
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
  return {directory,store,files,sources,imports,authorization,connection};
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
      warnings:['Generated preview warning'],reviewDecision:{confidence:'low',ambiguous:true,requiresConfirmation:true,reason:'Generated review ambiguity'}})};
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
  send({method:'item/completed',params:{threadId:'generated-thread',item:{id:'generated-message',type:'agentMessage',text:JSON.stringify({summary:'Generated Codex preview summary',recordsPath:'records.jsonl',warnings:['Generated Codex preview warning'],reviewDecision:{confidence:'low',ambiguous:true,requiresConfirmation:true,reason:'Generated Codex review ambiguity'}})}}});
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

for(const protocol of ['openai-completions','codex-app-server'] as const)test(`${protocol} carries owner context through the real import host and confirmation contract`,{timeout:30000},async t=>{
  const root=mkdtempSync(join(tmpdir(),'mote-import-context-')),converter=join(root,'generated-converter.mjs'),control=join(root,'controlled-result.json'),rpcPath=join(root,'rpc.ndjson');
  const instruction='文件名开头八位是日记日期 YYYYMMDD。这是朋友林的合成日记，不是我的经历。只整理原文；日期可修订，不需要精确时区；引用保留第三方主体。';
  const criticalInstruction='文件名开头八位是日记日期。这批合成资料混有我和他人的日记，正文未标作者；必须区分主体，不得把他人的经历归到我。';
  const original='合成日记原文：今天整理了旧书。\n保留引用：“先保留原文。”';
  const skill=readFileSync(new URL('../../../packages/agent/skills/document-import/SKILL.md',import.meta.url),'utf8');
  const decision={confidence:'low',ambiguous:true,requiresConfirmation:false,reason:'用户已解释命名与第三方主体。日期仅用于低影响整理，可修订；未知钟点和时区不改变原文或观测时间。'};
  writeFileSync(converter,`import {readFileSync,writeFileSync} from 'node:fs';
import {basename,join} from 'node:path';
export async function prepare(request,decision){
 const original=readFileSync(request.inputPaths[0],'utf8'),filename=basename(request.inputPaths[0]);
 const interpretation={kind:'inference',subject:decision.requiresConfirmation?'unknown':'林',date:'2020-01-02',sourceFilename:filename,basis:request.instruction,uncertainty:'Clock time and time zone are unknown',revisable:true};
 writeFileSync(join(request.workspace,'records.jsonl'),JSON.stringify({item:{externalId:filename,revision:'generated-1',observedAt:request.importedAt,kind:'file',layer:'original',title:filename,text:original,document:{contentRole:'authored',timeBasis:'unknown',originalMetadata:{importInterpretation:interpretation}}},evidencePaths:[request.inputPaths[0]],attachments:[]})+'\\n');
 writeFileSync(join(request.workspace,'dispositions.json'),JSON.stringify({items:[{path:request.inputPaths[0],status:'parsed',reason:'Generated exact original text'}]}));
 const helper=await import(request.helperPath);const checked=await helper.validateRecords(join(request.workspace,'records.jsonl'));if(!checked.valid)throw Error(JSON.stringify(checked));
 return {summary:'合成日记原文已保留；日期为基于说明的可修订推断。',recordsPath:'records.jsonl',warnings:['精确钟点和时区未知，未写成原始时间戳。'],reviewDecision:decision};
}
`,{mode:0o600});
  const requests:any[]=[];
  let codex:AgentOptions['codex'];
  if(protocol==='openai-completions'){
    const generated=await import(pathToFileURL(converter).href);
    t.mock.method(DeepSeekHarness.prototype,'run',async function(prompt:string){
      const request=JSON.parse(prompt);requests.push(request);
      const options=this.client.options,registered=JSON.parse(options.env!.MOTE_SKILLS!);
      assert.equal(registered[0].version,'1.0.7');assert.equal(registered[0].content,skill);
      const patch=JSON.parse(readFileSync(options.patches![0],'utf8'));assert.equal(patch.find((entry:any)=>entry.id==='system-prompt').config.personaPrefix,skill);
      return {events:[],finalResponse:JSON.stringify(await generated.prepare(request,JSON.parse(readFileSync(control,'utf8'))))};
    });
    t.mock.method(DeepSeekHarness.prototype,'close',async()=>{});
  }else{
    const executable=join(root,'generated-codex.mjs');
    writeFileSync(join(root,'auth.json'),JSON.stringify({OPENAI_API_KEY:'generated-unused'}),{mode:0o600});
    writeFileSync(executable,`#!${process.execPath}
if(process.argv[2]==='--mote-context-budget-version'){process.stdout.write('mote-context-budget-v1\\n');process.exit(0);}
import readline from 'node:readline';
import {appendFileSync,readFileSync} from 'node:fs';
import {prepare} from ${JSON.stringify(pathToFileURL(converter).href)};
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
readline.createInterface({input:process.stdin}).on('line',async line=>{
 const m=JSON.parse(line);appendFileSync(${JSON.stringify(rpcPath)},JSON.stringify(m)+'\\n');
 if(m.method==='initialize')send({id:m.id,result:{}});
 else if(m.method==='account/read')send({id:m.id,result:{account:{type:'apiKey'}}});
 else if(m.method==='thread/start')send({id:m.id,result:{thread:{id:'context-thread',model:m.params.model},model:m.params.model,serviceTier:m.params.serviceTier,approvalPolicy:'never',sandbox:{type:'workspaceWrite'}}});
 else if(m.method==='turn/start'){
  send({id:m.id,result:{turn:{id:'context-turn'}}});
  const result=await prepare(JSON.parse(m.params.input[0].text),JSON.parse(readFileSync(${JSON.stringify(control)},'utf8')));
  send({method:'item/completed',params:{threadId:'context-thread',item:{id:'context-message',type:'agentMessage',text:JSON.stringify(result)}}});
  send({method:'turn/completed',params:{threadId:'context-thread',turn:{status:'completed'}}});
 }
});
`,{mode:0o700});
    codex={executable,home:root};
  }
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const selected=protocol==='codex-app-server'?{...settings,provider:'codex',protocol,model:'generated-codex-model',baseUrl:'',apiKey:'',reasoningEffort:'auto',modelRequestTimeoutMs:null} as ModelSettings:settings;
  const {store,files,sources,imports,authorization,connection}=fixture(t,{settings:selected,codex});
  const create=(processing:'automatic'|'preview',suffix:string,context=instruction)=>imports.create({processing,instruction:context,files:[{name:'20200102-note-'+suffix+'.custom',dataBase64:Buffer.from(original).toString('base64')}]});
  const prepare=(id:string)=>ownerPrepare(imports,authorization,connection,id);
  writeFileSync(control,JSON.stringify(decision));
  const automatic=await create('automatic','automatic'),done=await prepare(automatic.id);
  assert.equal(done.status,'completed',done.error);assert.equal(done.reviewGate?.decision,'automatic');assert.equal(done.reviewDecision?.confidence,'low');assert.equal(done.reviewDecision?.ambiguous,true);assert.equal(done.reviewGate?.reason,decision.reason);assert.equal(done.warnings.length,1);
  assert.equal(done.progress.imported,1);assert.equal(store.list().items.length,1);
  const source=sources.getItem(done.sourceId,automatic.files[0].name)!;
  const interpretation=source.document?.originalMetadata?.importInterpretation as Record<string,unknown>;
  assert.equal(source.text,original);assert.equal(source.document?.recordedAt,undefined);assert.equal(source.document?.occurredAt,undefined);assert.equal(source.document?.timeBasis,'unknown');
  assert.deepEqual(interpretation,{kind:'inference',subject:'林',date:'2020-01-02',sourceFilename:automatic.files[0].name,basis:instruction,uncertainty:'Clock time and time zone are unknown',revisable:true});
  assert.notEqual(source.observedAt.slice(0,10),interpretation.date);assert.equal(files.read(automatic.files[0].id).toString(),original);
  const criticalReason='缺少来源主体的关键说明会改变归属，需先确认这批材料属于谁。';
  writeFileSync(control,JSON.stringify({...decision,confidence:'high',ambiguous:false,requiresConfirmation:true,reason:criticalReason}));
  const critical=await create('automatic','critical',criticalInstruction),held=await prepare(critical.id);
  assert.equal(held.status,'awaiting_confirmation');assert.equal(held.reviewGate?.reason,criticalReason);assert.deepEqual(held.captureIds,[]);assert.equal(store.list().items.length,1);
  const revised=instruction+' 已确认整批均为林的日记。';imports.updateInstruction(critical.id,revised);
  writeFileSync(control,JSON.stringify(decision));const recovered=await prepare(critical.id);
  assert.equal(recovered.status,'completed');assert.equal(store.list().items.length,2);
  assert.equal((sources.getItem(recovered.sourceId,critical.files[0].name)!.document!.originalMetadata!.importInterpretation as Record<string,unknown>).basis,revised);
  const manual=await create('preview','preview'),preview=await prepare(manual.id);
  assert.equal(preview.status,'awaiting_confirmation');assert.match(preview.reviewGate?.reason??'',/manual preview/);assert.deepEqual(preview.captureIds,[]);assert.equal(store.list().items.length,2);
  assert.equal((await imports.confirm(manual.id)).status,'completed');assert.equal(store.list().items.length,3);
  if(protocol==='codex-app-server'){
    const rpc=readFileSync(rpcPath,'utf8').trim().split('\n').map(line=>JSON.parse(line)),threads=rpc.filter(message=>message.method==='thread/start');
    for(const {params}of threads){assert.equal(params.baseInstructions,skill);assert.equal(params.ephemeral,true);assert.equal(params.sandbox,'workspace-write');assert.deepEqual(params.dynamicTools,[]);}
    for(const {params}of rpc.filter(message=>message.method==='turn/start')){assert.ok(params.outputSchema.properties.reviewDecision.required.includes('requiresConfirmation'));requests.push(JSON.parse(params.input[0].text));}
  }
  assert.equal(requests.length,4);assert.deepEqual(requests.map(request=>request.instruction),[instruction,criticalInstruction,revised,instruction]);
  for(const request of requests){assert.equal(request.requiredSkill,'document-import');assert.equal(request.taskId,'import');assert.equal(request.taskVersion,'1');assert.equal(request.inputPaths.length,1);assert.equal(request.archive,undefined);assert.equal(request.memory,undefined);}
  assert.equal(source.observedAt,requests[0].importedAt);
  const {MaterialStore}=await import('../src/materials.js'),context=new MaterialStore(store).contextForEvidence(store.evidence(done.captureIds)[0]);
  assert.equal(context.importStatements?.[0].instruction,instruction);assert.equal(context.ownerRelation,'unknown');
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
    return {events:[],finalResponse:JSON.stringify({summary:'Generated late preview',reviewDecision:{confidence:'high',ambiguous:false,requiresConfirmation:false,reason:'Generated exact source mapping'}})};
  });
  t.mock.method(DeepSeekHarness.prototype,'close',async()=>{});

  const created=await imports.create({processing:'automatic',files:[generatedInput('Generated cancellation original')]});
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
