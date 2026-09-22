import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,readFile,access,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {zstdDecompressSync} from 'node:zlib';
import {createAgent,AgentProviderError,AgentTimeoutError} from '../dist/index.js';
import {CodexSession} from '../dist/codex-session.js';
import {codexContextTools} from '../dist/codex-agent.js';
import {createImportAgent} from '../dist/import-agent.js';

const savedEnvironment=new WeakMap();
function env(t,key,value){let saved=savedEnvironment.get(t);if(!saved){saved=new Map();savedEnvironment.set(t,saved);t.after(()=>{for(const [k,v] of saved)v===undefined?delete process.env[k]:process.env[k]=v;});}if(!saved.has(key))saved.set(key,process.env[key]);process.env[key]=value;}
const record={id:'synthetic-codex-record',capturedAt:'2026-01-01T00:00:00Z',appName:'Generated fixture',ocrText:'Generated evidence for a provider test.'};
const reader={search:async()=>[record],timeline:async()=>[record],evidence:async()=>[record],devices:async()=>[],activity:async()=>({})};
async function setup(t){
  const root=await mkdtemp(join(tmpdir(),'mote-codex-test-'));
  await writeFile(join(root,'auth.json'),JSON.stringify({OPENAI_API_KEY:'synthetic-unused-key'}),{mode:0o600});
  env(t,'MOTE_CODEX_HOME',root);
  t.after(()=>rm(root,{recursive:true,force:true}));return root;
}
async function fake(t,mode='answer'){
  const root=await setup(t),bin=join(root,'fake-codex');
  await writeFile(bin,`#!${process.execPath}
import readline from 'node:readline';
import {writeFileSync,appendFileSync} from 'node:fs';
writeFileSync(${JSON.stringify(join(root,'runtime-home'))},process.env.CODEX_HOME);
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
const mode=${JSON.stringify(mode)};let turns=0;
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);appendFileSync(${JSON.stringify(join(root,'rpc.ndjson'))},JSON.stringify(m)+'\\n');
 if(m.method==='initialize')send({id:m.id,result:{}});
 else if(m.method==='account/read')send({id:m.id,result:{account:{type:'apiKey'}}});
 else if(m.method==='thread/start'){
  if(m.params.ephemeral!==true||m.params.approvalPolicy!=='never')process.exit(2);
  if(mode==='import'){if(m.params.dynamicTools.length||m.params.sandbox!=='workspace-write')process.exit(2);}
  else if(m.params.environments.length||m.params.dynamicTools.some(t=>!${JSON.stringify(codexContextTools.map(t=>t.name))}.includes(t.name)))process.exit(2);
  send({id:m.id,result:{thread:{id:'thread-fixture'},approvalPolicy:'never',sandbox:{type:mode==='import'?'workspaceWrite':'readOnly'}}});
 }else if(m.method==='turn/start'){
  turns++;
  if(mode==='max'&&m.params.effort!=='max')process.exit(4);
  send({id:m.id,result:{turn:{id:'turn-fixture'}}});
  if(mode==='import'){send({method:'item/completed',params:{threadId:'thread-fixture',item:{id:'import-fixture',type:'agentMessage',text:JSON.stringify({summary:'Generated import preview',recordsPath:null,warnings:[]})}}});send({method:'turn/completed',params:{threadId:'thread-fixture',turn:{status:'completed'}}});return;}
  if(mode==='structured-error'){send({method:'error',params:{threadId:'thread-fixture',willRetry:false,error:{codexErrorInfo:'usageLimitExceeded',message:'synthetic-private-secret'}}});send({method:'turn/completed',params:{threadId:'thread-fixture',turn:{status:'failed'}}});return;}
  if(mode==='timeout')return;
  if(mode==='error'){send({method:'turn/completed',params:{threadId:'thread-fixture',turn:{status:'failed',error:{message:'synthetic-private-secret'}}}});return;}
  send({id:999,method:mode==='approval'?'item/commandExecution/requestApproval':'item/tool/call',params:{threadId:'thread-fixture',tool:'timeline',namespace:null,arguments:mode==='tool-repair'?{limit:0}:{}}});
 }else if(m.id===999&&mode==='tool-repair'){
  const feedback=JSON.parse(m.result.contentItems[0].text);
  if(m.result.success!==false||feedback.toolError.code!=='invalid_tool_arguments'||feedback.toolError.recovery!=='correct_arguments')process.exit(5);
  send({id:1000,method:'item/tool/call',params:{threadId:'thread-fixture',tool:'timeline',namespace:null,arguments:{}}});
 }else if(m.id===999||m.id===1000){
  if(!m.result?.success)process.exit(3);
  if(mode==='usage')for(const sample of [turns*100,turns*100])send({method:'thread/tokenUsage/updated',params:{threadId:'thread-fixture',turnId:'turn-fixture',tokenUsage:{total:{inputTokens:sample,outputTokens:sample/2,totalTokens:sample*1.5,cachedInputTokens:sample/5,cacheWriteInputTokens:0,reasoningOutputTokens:sample/10}}}});
  send({method:'item/completed',params:{threadId:'thread-fixture',item:{id:'message-fixture',type:'agentMessage',text:JSON.stringify({answer:'Generated evidence [synthetic-codex-record]',citationIds:['synthetic-codex-record']})}}});
  send({method:'turn/completed',params:{threadId:'thread-fixture',turn:{status:'completed'}}});
 }
});
`,{mode:0o700});env(t,'MOTE_CODEX_BIN',bin);return root;
}
test('Codex App Server exchanges scoped tools, validates citations and leaves no credential copy',async t=>{
  const root=await fake(t),agent=createAgent({reader,protocol:'codex-app-server',model:'fixture',timeoutMs:5000});t.after(()=>agent.close());
  const answer=await agent.query({question:'Read the generated record'});
  assert.equal(answer.citations[0].id,record.id);assert.equal(answer.trace[0].tool,'timeline');
  assert.equal((await readFile(join(root,'auth.json'),'utf8')).includes('synthetic-unused-key'),true);
  await assert.rejects(access(await readFile(join(root,'runtime-home'),'utf8')),{code:'ENOENT'});
});
test('Codex preserves the requested Max effort without silently downgrading it',async t=>{
  await fake(t,'max');const agent=createAgent({reader,protocol:'codex-app-server',model:'fixture',reasoningEffort:'max',timeoutMs:5000});t.after(()=>agent.close());
  assert.equal((await agent.query({question:'Generated fixture'})).citations[0].id,record.id);
});
test('Codex errors and approval requests are rejected without exposing raw provider output',async t=>{
  for(const mode of ['error','approval']){await fake(t,mode);const agent=createAgent({reader,protocol:'codex-app-server',model:'fixture',timeoutMs:5000});try{await assert.rejects(agent.query({question:'Fixture'}),e=>e instanceof AgentProviderError&&!e.message.includes('synthetic-private'));}finally{await agent.close();}}
});
test('Codex deadlines terminate the child',async t=>{
  await fake(t,'timeout');const session=new CodexSession({model:'fixture',timeoutMs:100},async()=>({}));
  try{await assert.rejects(async()=>{await session.start('Generated test',codexContextTools);await session.run('Fixture');},AgentTimeoutError);}finally{await session.close();}
});
test('Codex preserves host deadlines and cancellation before its own deadline',async t=>{
  await fake(t,'timeout');
  for(const timeout of [true,false]){
    const controller=new AbortController(),agent=createAgent({reader,protocol:'codex-app-server',model:'fixture',timeoutMs:5000});
    try{
      const pending=agent.query({question:'Generated cancellation fixture',signal:controller.signal,onProgress:event=>{if(event.stage==='model')controller.abort(new DOMException('Generated abort',timeout?'TimeoutError':'AbortError'));}});
      await assert.rejects(pending,error=>timeout?error instanceof AgentTimeoutError:error instanceof AgentProviderError&&error.details.code==='cancelled');
    }finally{await agent.close();}
  }
});

test('Codex close drains concurrent startup and import uses a separate writable workspace without archive tools',async t=>{
  const root=await fake(t,'import'),session=new CodexSession({model:'fixture',timeoutMs:1000},async()=>({}));
  const starting=session.start('Generated test',codexContextTools);void starting.catch(()=>{});await session.close();await assert.rejects(starting,AgentProviderError);
  const workspace=join(root,'staging');await mkdir(workspace);
  const agent=createImportAgent({protocol:'codex-app-server',model:'fixture',codex:{executable:join(root,'fake-codex'),home:root}});t.after(()=>agent.close());
  const result=await agent.prepare({workspace,inputPaths:[],instruction:'Synthetic import',helperPath:'fixture',manifestSchema:{}});
  assert.equal(result.summary,'Generated import preview');assert.equal(result.recordsPath,undefined);
  await assert.rejects(access(await readFile(join(root,'runtime-home'),'utf8')),{code:'ENOENT'});
});

test('installed Codex speaks to a synthetic local Responses fixture with Mote evidence tools and ephemeral planning only',{skip:!process.env.MOTE_TEST_CODEX_BIN,timeout:30000},async t=>{
  const root=await setup(t),requests=[];
  const server=createServer(async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    let raw=Buffer.concat(chunks);if(req.headers['content-encoding']==='zstd')raw=zstdDecompressSync(raw);
    requests.push(JSON.parse(raw.toString()));
    const round=requests.length;
    const item=round<3?{id:'fc-fixture-'+round,type:'function_call',call_id:'call-fixture-'+round,name:round===1?'timeline':'evidence',arguments:JSON.stringify(round===1?{}:{ids:[record.id]}),status:'completed'}:{id:'msg-fixture',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:JSON.stringify({answer:'Generated response [synthetic-codex-record]',citationIds:[record.id]}),annotations:[]}]};
    res.writeHead(200,{'content-type':'text/event-stream'});
    for(const event of [{type:'response.created',response:{id:'resp-fixture',status:'in_progress'}},{type:'response.output_item.added',output_index:0,item},{type:'response.output_item.done',output_index:0,item},{type:'response.completed',response:{id:'resp-fixture',status:'completed',output:[item],usage:{input_tokens:1,output_tokens:1,total_tokens:2}}}])res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    res.end();
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  const provider={name:'Mote fixture',base_url:`http://127.0.0.1:${server.address().port}/v1`,wire_api:'responses',requires_openai_auth:false};
  const toml='{'+Object.entries(provider).map(([k,v])=>k+'='+JSON.stringify(v)).join(',')+'}';
  const bin=join(root,'codex-wrapper');
  const transcript=join(root,'protocol.jsonl');
  await writeFile(bin,`#!${process.execPath}
import {spawn} from 'node:child_process';import {appendFileSync} from 'node:fs';
const child=spawn(${JSON.stringify(process.env.MOTE_TEST_CODEX_BIN)},[...process.argv.slice(2),'-c','model_provider="mote_fixture"','-c',${JSON.stringify('model_providers.mote_fixture='+toml)}],{env:{...process.env,NO_PROXY:'*'}});
process.stdin.pipe(child.stdin);child.stdout.on('data',b=>{appendFileSync(${JSON.stringify(transcript)},b);process.stdout.write(b);});child.stderr.on('data',b=>appendFileSync(${JSON.stringify(transcript)},b));child.on('exit',code=>process.exit(code??1));process.on('SIGTERM',()=>child.kill('SIGTERM'));
`,{mode:0o700});
  env(t,'MOTE_CODEX_BIN',bin);
  const agent=createAgent({reader,protocol:'codex-app-server',model:'gpt-5.4',timeoutMs:20000});t.after(()=>agent.close());
  let result;try{result=await agent.query({question:'Read generated records through timeline and evidence.'});}catch(error){t.diagnostic((await readFile(transcript,'utf8')).slice(-12000));throw error;}
  assert.equal(result.answer,'Generated response [synthetic-codex-record]');assert.equal(requests.length,3);assert.deepEqual(result.trace.map(t=>t.tool),['timeline','evidence']);
  // Older Codex exposes ephemeral update_plan; current versions honor its disabled flag.
  const advertised=requests[0].tools.map(tool=>tool.name);
  assert.deepEqual(advertised.filter(name=>name!=='update_plan').sort(),codexContextTools.map(tool=>tool.name).filter(name=>name!=='action_catalog').sort());
  assert.ok(!advertised.includes('action_catalog'),'ordinary queries have no host action-catalog grant');
});

test('host output validation repairs within the same Codex thread and remains bounded',async t=>{
 const root=await fake(t),events=[];let checked=0;
 const agent=createAgent({reader,protocol:'codex-app-server',model:'fixture',timeoutMs:5000});t.after(()=>agent.close());
 const answer=await agent.query({question:'Generated quote check',onTrace:e=>events.push(e),validateOutput:result=>{checked++;assert.equal(result.citations[0].id,record.id);return checked===1?{code:'quote_offset_mismatch',feedback:'Candidate 0 span 0: omit offset and copy the exact original quote.'}:undefined;}});
 assert.equal(checked,2);assert.equal(answer.citations[0].id,record.id);
 const rpc=(await readFile(join(root,'rpc.ndjson'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));assert.equal(rpc.filter(m=>m.method==='thread/start').length,1);assert.equal(rpc.filter(m=>m.method==='turn/start').length,2);
 const repair=events.find(e=>e.type==='model.started'&&e.payload?.repair);assert.match(repair.payload.prompt,/quote_offset_mismatch/);
 assert.equal(new Set(events.filter(e=>e.runId).map(e=>e.runId)).size,1);
 checked=0;await assert.rejects(agent.query({question:'Generated rejected quote',validateOutput:()=>{checked++;return {code:'quote_not_found',feedback:'Use exact supplied evidence.'};}}),e=>e.reason==='host_validation');assert.equal(checked,2);
});

test('Codex deadline removes a waiting model admission before a turn starts',async t=>{
 await fake(t);let started=false,aborted=false;
 const session=new CodexSession({model:'fixture',timeoutMs:2000,runModel:(_task,signal)=>new Promise((_resolve,reject)=>{started=true;const stop=()=>{aborted=true;reject(signal.reason);};if(signal.aborted)stop();else signal.addEventListener('abort',stop,{once:true});})},async()=>({}));
 try{await session.start('Generated queue fixture',[]);await assert.rejects(session.run('Generated'),AgentTimeoutError);assert.equal(started,true);assert.equal(aborted,true);}finally{await session.close();}
});


test('Codex receives structured tool feedback and corrects arguments within the same turn',async t=>{
  const root=await fake(t,'tool-repair'),agent=createAgent({reader,protocol:'codex-app-server',model:'fixture',timeoutMs:5000});t.after(()=>agent.close());
  assert.equal((await agent.query({question:'Generated recovery fixture'})).citations[0].id,record.id);
  const messages=(await readFile(join(root,'rpc.ndjson'),'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(messages.filter(m=>m.method==='turn/start').length,1);
  assert.match(messages.find(m=>m.id===999).result.contentItems[0].text,/limit must be a positive integer/);
});


test('Codex cumulative usage replaces duplicate samples and covers repair turns without inventing request counts',async t=>{
 await fake(t,'usage');const samples=[];let validation=0;
 const agent=createAgent({reader,protocol:'codex-app-server',model:'fixture',timeoutMs:5000});t.after(()=>agent.close());
 await agent.query({question:'Generated usage fixture',onUsage:u=>samples.push(u),validateOutput:()=>++validation===1?{code:'fixture',feedback:'Return exact original citation.'}:undefined});
 assert.equal(samples.at(-1).totalTokens,300);assert.equal(samples.at(-1).complete,true);assert.equal(samples.at(-1).measurement,'thread_cumulative');assert.equal(samples.at(-1).requests,0);assert.equal(samples.at(-1).cacheReadTokens,40);assert.ok(samples.some(s=>s.complete===false));
});
test('Codex structured quota errors retain safe typed state without exposing provider text',async t=>{
 await fake(t,'structured-error');const agent=createAgent({reader,protocol:'codex-app-server',model:'fixture',timeoutMs:5000});t.after(()=>agent.close());
 await assert.rejects(agent.query({question:'Generated failure'}),e=>e.details?.category==='blocked'&&e.details.code==='provider_quota'&&!e.message.includes('synthetic-private'));
});
