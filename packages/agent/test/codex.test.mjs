import sharp from 'sharp';
import {generatedImageRead,assertRegionSchema} from './image-region-fixture.mjs';
import {generatedMaterialPages,materialRef} from './material-page-fixture.mjs';
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
const record={id:'274f8026-73c2-5566-9528-b7aa5fb14de6',capturedAt:'2026-01-01T00:00:00Z',appName:'Generated fixture',ocrText:'Generated evidence for a provider test.'};
const reader={search:async()=>[record],timeline:async()=>({items:([record]),nextCursor:null}),evidence:async()=>[record],devices:async()=>[],activity:async()=>({})};
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
import {writeFileSync,appendFileSync,readFileSync} from 'node:fs';
writeFileSync(${JSON.stringify(join(root,'runtime-home'))},process.env.CODEX_HOME);
writeFileSync(${JSON.stringify(join(root,'runtime-config'))},readFileSync(process.env.CODEX_HOME+'/config.toml'));
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
const mode=${JSON.stringify(mode)};let turns=0;
const usage=sample=>send({method:'thread/tokenUsage/updated',params:{threadId:'thread-fixture',turnId:'turn-fixture',tokenUsage:{total:{inputTokens:sample,outputTokens:sample/2,totalTokens:sample*1.5,cachedInputTokens:sample/5,cacheWriteInputTokens:0,reasoningOutputTokens:sample/10}}}});
if(mode==='usage-late-exit')process.on('SIGTERM',()=>{usage(200);setTimeout(()=>process.exit(0),20);});
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);appendFileSync(${JSON.stringify(join(root,'rpc.ndjson'))},JSON.stringify(m)+'\\n');
 if(m.method==='initialize')send({id:m.id,result:{}});
 else if(m.method==='account/read')send({id:m.id,result:{account:{type:'apiKey'}}});
 else if(m.method==='thread/start'){
  if(m.params.ephemeral!==true||m.params.approvalPolicy!=='never')process.exit(2);
  if(mode.startsWith('import')){if(m.params.dynamicTools.length||m.params.sandbox!=='workspace-write')process.exit(2);}
  else if(m.params.environments.length||m.params.dynamicTools.some(t=>!${JSON.stringify(codexContextTools.map(t=>t.name))}.includes(t.name)))process.exit(2);
  const tierResponses={'tier-mismatch':null,'tier-priority':'priority','tier-default':'default','tier-unknown':'ultrafast'};
  send({id:m.id,result:{thread:{id:'thread-fixture'},serviceTier:Object.hasOwn(tierResponses,mode)?tierResponses[mode]:m.params.serviceTier,approvalPolicy:'never',sandbox:{type:mode.startsWith('import')?'workspaceWrite':'readOnly'}}});
 }else if(m.method==='turn/start'){
  turns++;
  if(['max','medium'].includes(mode)&&m.params.effort!==mode)process.exit(4);
  send({id:m.id,result:{turn:{id:'turn-fixture'}}});
  if(['usage-timeout','usage-exit','usage-late-exit'].includes(mode)){usage(100);if(mode==='usage-exit')setTimeout(()=>process.exit(23),20);return;}
  if(mode.startsWith('import')){const count=turns;send({method:'item/completed',params:{threadId:'thread-fixture',item:{id:'import-fixture',type:'agentMessage',text:mode==='import-invalid'||mode==='import-repairs'&&count<4?'Generated invalid preview':JSON.stringify({summary:'Generated import preview',recordsPath:null,warnings:[]})}}});send({method:'turn/completed',params:{threadId:'thread-fixture',turn:{status:'completed'}}});return;}
  if(mode==='structured-error'){send({method:'error',params:{threadId:'thread-fixture',willRetry:false,error:{codexErrorInfo:'usageLimitExceeded',message:'synthetic-private-secret'}}});send({method:'turn/completed',params:{threadId:'thread-fixture',turn:{status:'failed'}}});return;}
  if(mode==='timeout')return;
  if(mode==='oversize-frame'){send({method:'fixture/opaque',params:{data:'x'.repeat(14*1024*1024)}});return;}
  if(mode==='error'){send({method:'turn/completed',params:{threadId:'thread-fixture',turn:{status:'failed',error:{message:'synthetic-private-secret'}}}});return;}
  send({id:999,method:mode==='approval'?'item/commandExecution/requestApproval':'item/tool/call',params:{threadId:'thread-fixture',tool:mode==='material-page'?'material_catalog':mode==='contribution'?'capability_discover':mode==='image-echo'?'read_image':'timeline',namespace:null,arguments:mode==='tool-repair'?{limit:0}:mode==='contribution'?{name:'fixture_context'}:{}}});
 }else if(mode==='contribution'&&m.id===999){
  if(!m.result?.success)process.exit(3);
  const capability=JSON.parse(m.result.contentItems[0].text).data;
  if(capability.name!=='fixture_context'||capability.fields.count.type!=='integer')process.exit(4);
  send({id:1000,method:'item/tool/call',params:{threadId:'thread-fixture',tool:'capability_execute',namespace:null,arguments:{name:capability.name,version:capability.version,argumentsJson:JSON.stringify({count:'1'})}}});
 }else if(mode==='contribution'&&m.id===1000){
  if(m.result?.success||JSON.parse(m.result.contentItems[0].text).toolError.code!=='invalid_tool_arguments')process.exit(5);
  send({id:1001,method:'item/tool/call',params:{threadId:'thread-fixture',tool:'capability_execute',namespace:null,arguments:{name:'fixture_context',version:'generated-1',argumentsJson:JSON.stringify({count:1})}}});
 }else if(mode==='material-page'&&m.id===999){
  if(!m.result?.success)process.exit(3);
  const page=JSON.parse(m.result.contentItems[0].text);
  send({id:1000,method:'item/tool/call',params:{threadId:'thread-fixture',tool:'material_read',namespace:null,arguments:{ref:page.data.items[0].ref,length:10000}}});
 }else if((mode==='image-flow'||mode==='image-repeat')&&(m.id===999||m.id===1000||mode==='image-repeat'&&m.id===1001)){
  if(!m.result?.success)process.exit(3);
  send({id:m.id+1,method:'item/tool/call',params:{threadId:'thread-fixture',tool:m.id===999?'evidence':'read_image',namespace:null,arguments:m.id===999?{ids:['274f8026-73c2-5566-9528-b7aa5fb14de6']}:{id:'274f8026-73c2-5566-9528-b7aa5fb14de6',attachmentId:'generated-image'}}});
 }else if(mode==='image-region'&&m.id>=999&&m.id<=1002){
  if(!m.result?.success)process.exit(3);
  const value=JSON.parse(m.result.contentItems[0].text);
  const args=m.id===999?{ids:['274f8026-73c2-5566-9528-b7aa5fb14de6']}:m.id===1000?{id:'274f8026-73c2-5566-9528-b7aa5fb14de6',attachmentId:'generated-image',view:'metadata'}:{id:'274f8026-73c2-5566-9528-b7aa5fb14de6',attachmentId:'generated-image',expectedImageSha256:value.imageView.original.sha256,region:{x:1,y:2,width:4,height:5}};
  send({id:m.id+1,method:'item/tool/call',params:{threadId:'thread-fixture',tool:m.id===999?'evidence':'read_image',namespace:null,arguments:args}});
 }else if(m.id===999&&mode==='tool-repair'){
  const feedback=JSON.parse(m.result.contentItems[0].text);
  if(m.result.success!==false||feedback.toolError.code!=='invalid_tool_arguments'||feedback.toolError.recovery!=='correct_arguments')process.exit(5);
  send({id:1000,method:'item/tool/call',params:{threadId:'thread-fixture',tool:'timeline',namespace:null,arguments:{}}});
 }else if(m.id===999||m.id===1000||m.id===1001||m.id===1002||m.id===1003){
  if(!m.result?.success)process.exit(3);
  if(mode==='image-echo'||mode==='image-flow')send({method:'item/completed',params:{threadId:'thread-fixture',item:{id:'image-echo',type:'dynamicToolCall',contentItems:m.result.contentItems}}});
  if(mode==='usage')for(const sample of [turns*100,turns*100])send({method:'thread/tokenUsage/updated',params:{threadId:'thread-fixture',turnId:'turn-fixture',tokenUsage:{total:{inputTokens:sample,outputTokens:sample/2,totalTokens:sample*1.5,cachedInputTokens:sample/5,cacheWriteInputTokens:0,reasoningOutputTokens:sample/10}}}});
  send({method:'item/completed',params:{threadId:'thread-fixture',item:{id:'message-fixture',type:'agentMessage',text:JSON.stringify({answer:['contribution','material-page'].includes(mode)?'Generated metadata':'Generated evidence [274f8026-73c2-5566-9528-b7aa5fb14de6]',citationIds:['contribution','material-page'].includes(mode)?[]:['274f8026-73c2-5566-9528-b7aa5fb14de6']})}}});
  send({method:'turn/completed',params:{threadId:'thread-fixture',turn:{status:'completed'}}});
 }
});
`,{mode:0o700});env(t,'MOTE_CODEX_BIN',bin);return root;
}
test('Codex speed selection reaches the isolated runtime without changing reasoning or tools',async t=>{
  for(const serviceTier of [undefined,'default','fast'])await t.test(String(serviceTier),async t=>{
    const root=await fake(t),agent=createAgent({reader,protocol:'codex-app-server',model:'fixture',reasoningEffort:'max',serviceTier,agentTimeoutMs:5000});t.after(()=>agent.close());
    await writeFile(join(root,'config.toml'),'service_tier = "fast"\n[features]\nplugins = true\n');
    const result=await agent.query({question:'Generated speed fixture'});
    assert.equal(result.citations[0].id,record.id);
    const rpc=(await readFile(join(root,'rpc.ndjson'),'utf8')).trim().split('\n').map(JSON.parse),thread=rpc.find(m=>m.method==='thread/start');
    assert.equal(thread.params.serviceTier,serviceTier);
    assert.equal(Object.hasOwn(thread.params,'serviceTier'),serviceTier!==undefined);
    assert.equal(thread.params.sandbox,'read-only');assert.deepEqual(thread.params.environments,[]);
    assert.equal(rpc.find(m=>m.method==='turn/start').params.effort,'max');
    const config=await readFile(join(root,'runtime-config'),'utf8');
    assert.equal(config.includes('fast_mode = true'),serviceTier==='fast');
    assert.equal(config.includes('service_tier ='),serviceTier!==undefined);
    if(serviceTier)assert.ok(config.includes(`service_tier = "${serviceTier}"`));
    assert.ok(config.includes('plugins = false'));assert.ok(!config.includes('plugins = true'));assert.ok(config.includes('goals = false'));
  });
});
test('Codex accepts the official priority acknowledgement for Fast',async t=>{
  const root=await fake(t,'tier-priority'),agent=createAgent({reader,protocol:'codex-app-server',model:'fixture',reasoningEffort:'max',serviceTier:'fast',agentTimeoutMs:5000});t.after(()=>agent.close());
  const answer=await agent.query({question:'Generated priority fixture'});
  assert.equal(answer.citations[0].id,record.id);
  const rpc=(await readFile(join(root,'rpc.ndjson'),'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(rpc.find(m=>m.method==='thread/start').params.serviceTier,'fast');
  assert.equal(rpc.find(m=>m.method==='turn/start').params.effort,'max');
});
test('Codex refuses unacknowledged or different speed tiers instead of silently switching',async t=>{
  for(const [mode,serviceTier] of [['tier-mismatch','fast'],['tier-default','fast'],['tier-unknown','fast'],['tier-priority','default']])await t.test(`${serviceTier}/${mode}`,async t=>{
    const root=await fake(t,mode),agent=createAgent({reader,protocol:'codex-app-server',model:'fixture',serviceTier,agentTimeoutMs:5000});t.after(()=>agent.close());
    await assert.rejects(agent.query({question:'Generated speed mismatch'}),AgentProviderError);
    const rpc=(await readFile(join(root,'rpc.ndjson'),'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(rpc.some(m=>m.method==='turn/start'),false);
  });
});
test('Codex App Server exchanges scoped tools, validates citations and leaves no credential copy',async t=>{
  const root=await fake(t),agent=createAgent({reader,protocol:'codex-app-server',model:'fixture',agentTimeoutMs:5000});t.after(()=>agent.close());
  const answer=await agent.query({question:'Read the generated record'});
  assert.equal(answer.citations[0].id,record.id);assert.equal(answer.trace[0].tool,'timeline');
  assert.equal((await readFile(join(root,'auth.json'),'utf8')).includes('synthetic-unused-key'),true);
  await assert.rejects(access(await readFile(join(root,'runtime-home'),'utf8')),{code:'ENOENT'});
});
test('Codex tool completion carries one fitted material page and preserves its original requested range',async t=>{
  const root=await fake(t,'material-page'),fixture=generatedMaterialPages();
  const agent=createAgent({reader:fixture.reader,protocol:'codex-app-server',model:'fixture',agentTimeoutMs:5000});t.after(()=>agent.close());
  const answer=await agent.query({question:'Read a generated material page'}),rpc=(await readFile(join(root,'rpc.ndjson'),'utf8')).trim().split('\n').map(JSON.parse);
  const result=rpc.find(message=>message.id===1000).result;assert.equal(result.success,true);assert.equal(result.contentItems.length,1);
  const page=JSON.parse(result.contentItems[0].text);assert.equal(result.contentItems[0].type,'inputText');assert.ok(result.contentItems[0].text.length<=16000);
  assert.equal(page.data.pagination.limitedBy,'host_budget');assert.equal(page.data.textRange.nextOffset,5000);
  assert.deepEqual(fixture.attempts.map(args=>args.length),[10000,5000]);assert.equal(rpc.filter(message=>message.method==='turn/start').length,1);
  assert.deepEqual(answer.trace.at(-1).arguments,{ref:materialRef,offset:0,length:10000});assert.equal(answer.trace.at(-1).materialPage.readAttempts,2);
});
test('Codex preserves the requested Max effort without silently downgrading it',async t=>{
  await fake(t,'max');const agent=createAgent({reader,protocol:'codex-app-server',model:'fixture',reasoningEffort:'max',agentTimeoutMs:5000});t.after(()=>agent.close());
  assert.equal((await agent.query({question:'Generated fixture'})).citations[0].id,record.id);
});
test('Codex passes the catalog medium effort to turn/start',async t=>{
  await fake(t,'medium');const agent=createAgent({reader,protocol:'codex-app-server',model:'fixture',reasoningEffort:'medium',agentTimeoutMs:5000});t.after(()=>agent.close());
  assert.equal((await agent.query({question:'Generated fixture'})).citations[0].id,record.id);
});
test('Codex receives an allowed image-sized dynamic tool completion without dropping the session',async t=>{
 const root=await fake(t,'image-echo'),events=[],data=Buffer.alloc(3*1024*1024,123).toString('base64');
 const session=new CodexSession({model:'fixture',agentTimeoutMs:5000},async()=>({id:'generated-parent',attachmentId:'generated-image',image:{mimeType:'image/png',data}}),event=>events.push(event));t.after(()=>session.close());
 await session.start('Generated protocol fixture',codexContextTools);assert.match(await session.run('Read generated image'),/Generated evidence/);
 const messages=(await readFile(join(root,'rpc.ndjson'),'utf8')).trim().split('\n').map(JSON.parse),response=messages.find(m=>m.id===999);
 assert.deepEqual(JSON.parse(response.result.contentItems[0].text),{id:'generated-parent',attachmentId:'generated-image',source:'untrusted_personal_context'});
 assert.equal(response.result.contentItems[1].imageUrl,'data:image/png;base64,'+data);
 assert.ok(events.some(e=>e.type==='codex.item/completed'&&e.payload.itemType==='dynamicToolCall'));
 assert.ok(!JSON.stringify(events).includes(data),'trace records event metadata, never echoed image bytes');
});
test('Codex still rejects oversized protocol frames with bounded diagnostic metadata',async t=>{
 await fake(t,'oversize-frame');const events=[],session=new CodexSession({model:'fixture',agentTimeoutMs:5000},async()=>({}),event=>events.push(event));t.after(()=>session.close());
 await session.start('Generated protocol limit',codexContextTools);
 await assert.rejects(session.run('Generated oversize'),e=>e instanceof AgentProviderError&&e.details.category==='permanent'&&e.details.code==='processing_limit');
 assert.ok(events.some(e=>e.type==='codex.transport.failed'&&e.payload.code==='frame_limit'));
 assert.ok(JSON.stringify(events).length<10000);
});
test('Codex discloses a selected image to the model while keeping its bytes out of Agent traces',async t=>{
 const root=await fake(t,'image-flow'),events=[],data=Buffer.alloc(3*1024*1024,123).toString('base64'),parent={...record,provenance:{document:{attachments:[{id:'generated-image',mimeType:'image/png'}]}}};
 const imageReader={...reader,timeline:async()=>({items:([parent]),nextCursor:null}),evidence:async()=>[parent],readImage:async input=>{assert.deepEqual(input,{id:record.id,attachmentId:'generated-image'});return {mimeType:'image/png',data};}};
 const agent=createAgent({reader:imageReader,protocol:'codex-app-server',model:'fixture',agentTimeoutMs:5000});t.after(()=>agent.close());
 const answer=await agent.query({question:'Read the generated image',onTrace:event=>events.push(event)});assert.equal(answer.citations[0].id,record.id);
 const result=events.find(e=>e.type==='tool.completed'&&e.tool==='read_image').payload.result;
 assert.equal(result.attachmentId,'generated-image');assert.deepEqual(result.image,{mimeType:'image/png',encodedCharacters:data.length});
 assert.ok(!JSON.stringify(events).includes(data.slice(0,200)),'neither model RPC echoes nor tool-completion traces retain image data');
 const messages=(await readFile(join(root,'rpc.ndjson'),'utf8')).trim().split('\n').map(JSON.parse);
 assert.equal(messages.find(m=>m.id===1001).result.contentItems[1].imageUrl,'data:image/png;base64,'+data);
});
test('Codex duplicate image completion succeeds as metadata without appending another inputImage',async t=>{
 const root=await fake(t,'image-repeat'),events=[],data=Buffer.from('generated-image-transport').toString('base64'),parent={...record,provenance:{document:{attachments:[{id:'generated-image',mimeType:'image/png'}]}}};let reads=0;
 const agent=createAgent({reader:{...reader,timeline:async()=>({items:([parent]),nextCursor:null}),evidence:async()=>[parent],readImage:async()=>{reads++;return {mimeType:'image/png',data};}},protocol:'codex-app-server',model:'fixture',agentTimeoutMs:5000});t.after(()=>agent.close());
 const answer=await agent.query({question:'Read generated pixels',onTrace:event=>events.push(event)});assert.equal(answer.citations[0].id,record.id);assert.equal(reads,2);
 const messages=(await readFile(join(root,'rpc.ndjson'),'utf8')).trim().split('\n').map(JSON.parse),first=messages.find(m=>m.id===1001).result,repeat=messages.find(m=>m.id===1002).result;
 assert.equal(first.success,true);assert.equal(first.contentItems.filter(item=>item.type==='inputImage').length,1);
 assert.equal(repeat.success,true);assert.deepEqual(repeat.contentItems.map(item=>item.type),['inputText']);assert.equal(JSON.parse(repeat.contentItems[0].text).imageDisclosure.status,'already_disclosed');
 assert.equal(messages.flatMap(m=>m.result?.contentItems??[]).filter(item=>item.type==='inputImage').length,1);
 assert.equal(events.filter(e=>e.type==='tool.completed'&&e.tool==='read_image'&&e.status==='succeeded').length,2);assert.ok(!JSON.stringify(events).includes(data));
 assert.ok(!JSON.stringify(messages).includes('imageDelivery'),'host receipts never enter the model protocol');
 await agent.query({question:'Read generated pixels again'});assert.equal(reads,4);
 const restarted=(await readFile(join(root,'rpc.ndjson'),'utf8')).trim().split('\n').map(JSON.parse);assert.equal(restarted.flatMap(m=>m.result?.contentItems??[]).filter(item=>item.type==='inputImage').length,2,'a new query on the same agent must disclose its first image');
});
test('Codex errors and approval requests are rejected without exposing raw provider output',async t=>{
  for(const mode of ['error','approval']){await fake(t,mode);const agent=createAgent({reader,protocol:'codex-app-server',model:'fixture',agentTimeoutMs:5000});try{await assert.rejects(agent.query({question:'Fixture'}),e=>e instanceof AgentProviderError&&!e.message.includes('synthetic-private'));}finally{await agent.close();}}
});
test('Codex deadlines terminate the child',async t=>{
  await fake(t,'timeout');const session=new CodexSession({model:'fixture',agentTimeoutMs:100},async()=>({}));
  try{await assert.rejects(async()=>{await session.start('Generated test',codexContextTools);await session.run('Fixture');},AgentTimeoutError);}finally{await session.close();}
});
test('Codex preserves host deadlines and cancellation before its own deadline',async t=>{
  await fake(t,'timeout');
  for(const timeout of [true,false]){
    const controller=new AbortController(),agent=createAgent({reader,protocol:'codex-app-server',model:'fixture',agentTimeoutMs:5000});
    try{
      const pending=agent.query({question:'Generated cancellation fixture',signal:controller.signal,onProgress:event=>{if(event.stage==='model')controller.abort(new DOMException('Generated abort',timeout?'TimeoutError':'AbortError'));}});
      await assert.rejects(pending,error=>timeout?error instanceof AgentTimeoutError:error instanceof AgentProviderError&&error.details.code==='cancelled');
    }finally{await agent.close();}
  }
});

test('Codex close drains concurrent startup and import uses a separate writable workspace without archive tools',async t=>{
  const root=await fake(t,'import'),session=new CodexSession({model:'fixture',agentTimeoutMs:1000},async()=>({}));
  const starting=session.start('Generated test',codexContextTools);void starting.catch(()=>{});await session.close();await assert.rejects(starting,AgentProviderError);
  const workspace=join(root,'staging');await mkdir(workspace);
  const agent=createImportAgent({protocol:'codex-app-server',model:'fixture',serviceTier:'fast',codex:{executable:join(root,'fake-codex'),home:root}});t.after(()=>agent.close());
  const result=await agent.prepare({workspace,inputPaths:[],instruction:'Synthetic import',helperPath:'fixture',manifestSchema:{}});
  assert.equal(result.summary,'Generated import preview');assert.equal(result.recordsPath,undefined);
  const rpc=(await readFile(join(root,'rpc.ndjson'),'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(rpc.find(m=>m.method==='thread/start').params.serviceTier,'fast');
  await assert.rejects(access(await readFile(join(root,'runtime-home'),'utf8')),{code:'ENOENT'});
});

test('installed Codex speaks to a synthetic local Responses fixture with Mote evidence tools and ephemeral planning only',{skip:!process.env.MOTE_TEST_CODEX_BIN,timeout:30000},async t=>{
  const root=await setup(t),requests=[];
  const server=createServer(async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    let raw=Buffer.concat(chunks);if(req.headers['content-encoding']==='zstd')raw=zstdDecompressSync(raw);
    requests.push(JSON.parse(raw.toString()));
    const round=requests.length;
    const item=round<3?{id:'fc-fixture-'+round,type:'function_call',call_id:'call-fixture-'+round,name:round===1?'timeline':'evidence',arguments:JSON.stringify(round===1?{}:{ids:[record.id]}),status:'completed'}:{id:'msg-fixture',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:JSON.stringify({answer:'Generated response [274f8026-73c2-5566-9528-b7aa5fb14de6]',citationIds:[record.id]}),annotations:[]}]};
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
  const agent=createAgent({reader,protocol:'codex-app-server',model:'gpt-5.4',agentTimeoutMs:20000});t.after(()=>agent.close());
  let result;try{result=await agent.query({question:'Read generated records through timeline and evidence.'});}catch(error){t.diagnostic((await readFile(transcript,'utf8')).slice(-12000));throw error;}
  assert.equal(result.answer,'Generated response [274f8026-73c2-5566-9528-b7aa5fb14de6]');assert.equal(requests.length,3);assert.deepEqual(result.trace.map(t=>t.tool),['timeline','evidence']);
  // Older Codex exposes ephemeral update_plan; current versions honor its disabled flag.
  const advertised=requests[0].tools.map(tool=>tool.name);
  assert.deepEqual(advertised.filter(name=>name!=='update_plan').sort(),codexContextTools.map(tool=>tool.name).filter(name=>name!=='action_catalog').sort());
  assert.ok(!advertised.includes('action_catalog'),'ordinary queries have no host action-catalog grant');
});

test('host output validation repairs within the same Codex thread and remains bounded',async t=>{
 const root=await fake(t),events=[];let checked=0;
 const agent=createAgent({reader,protocol:'codex-app-server',model:'fixture',agentTimeoutMs:5000});t.after(()=>agent.close());
 const answer=await agent.query({question:'Generated quote check',onTrace:e=>events.push(e),validateOutput:result=>{checked++;assert.equal(result.citations[0].id,record.id);return checked===1?{code:'quote_offset_mismatch',feedback:'Candidate 0 span 0: omit offset and copy the exact original quote.'}:undefined;}});
 assert.equal(checked,2);assert.equal(answer.citations[0].id,record.id);
 const rpc=(await readFile(join(root,'rpc.ndjson'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));assert.equal(rpc.filter(m=>m.method==='thread/start').length,1);assert.equal(rpc.filter(m=>m.method==='turn/start').length,2);
 const repair=events.find(e=>e.type==='model.started'&&e.payload?.repair);assert.match(repair.payload.prompt,/quote_offset_mismatch/);
 assert.equal(new Set(events.filter(e=>e.runId).map(e=>e.runId)).size,1);
 checked=0;await assert.rejects(agent.query({question:'Generated rejected quote',validateOutput:()=>{checked++;return {code:'quote_not_found',feedback:'Use exact supplied evidence.'};}}),e=>e.reason==='host_validation');assert.equal(checked,4);
});

test('Codex deadline removes a waiting model admission before a turn starts',async t=>{
 await fake(t);let started=false,aborted=false;
 const session=new CodexSession({model:'fixture',agentTimeoutMs:2000,runModel:(_task,signal)=>new Promise((_resolve,reject)=>{started=true;const stop=()=>{aborted=true;reject(signal.reason);};if(signal.aborted)stop();else signal.addEventListener('abort',stop,{once:true});})},async()=>({}));
 try{await session.start('Generated queue fixture',[]);await assert.rejects(session.run('Generated'),AgentTimeoutError);assert.equal(started,true);assert.equal(aborted,true);}finally{await session.close();}
});


test('Codex receives structured tool feedback and corrects arguments within the same turn',async t=>{
  const root=await fake(t,'tool-repair'),agent=createAgent({reader,protocol:'codex-app-server',model:'fixture',agentTimeoutMs:5000});t.after(()=>agent.close());
  assert.equal((await agent.query({question:'Generated recovery fixture'})).citations[0].id,record.id);
  const messages=(await readFile(join(root,'rpc.ndjson'),'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(messages.filter(m=>m.method==='turn/start').length,1);
  assert.match(messages.find(m=>m.id===999).result.contentItems[0].text,/limit must be a positive integer/);
});


test('Codex cumulative usage replaces duplicate samples and covers repair turns without inventing request counts',async t=>{
 await fake(t,'usage');const samples=[];let validation=0;
 const agent=createAgent({reader,protocol:'codex-app-server',model:'fixture',agentTimeoutMs:5000});t.after(()=>agent.close());
 await agent.query({question:'Generated usage fixture',onUsage:u=>samples.push(u),validateOutput:()=>++validation===1?{code:'fixture',feedback:'Return exact original citation.'}:undefined});
 assert.equal(samples.at(-1).totalTokens,300);assert.equal(samples.at(-1).complete,true);assert.equal(samples.at(-1).measurement,'thread_cumulative');assert.equal(samples.at(-1).requests,0);assert.equal(samples.at(-1).cacheReadTokens,40);assert.ok(samples.some(s=>s.complete===false));
});
test('Codex interrupted turns preserve observed counts but mark cumulative usage incomplete',{timeout:15000},async t=>{
 for(const kind of ['deadline','host-deadline','cancel','close','child-exit','late-usage']){
  await fake(t,kind==='child-exit'?'usage-exit':kind==='late-usage'?'usage-late-exit':'usage-timeout');
  const samples=[];let sampleArrived;const firstSample=new Promise(resolve=>{sampleArrived=resolve;});
  const session=new CodexSession({model:'fixture',agentTimeoutMs:kind==='deadline'?1000:5000},async()=>({}),undefined,value=>{samples.push(value);sampleArrived();});
  try{
   await session.start('Generated interrupted usage',codexContextTools);const pending=session.run('Generated pending turn');void pending.catch(()=>{});
   await Promise.race([firstSample,pending.then(()=>{throw Error('Fixture unexpectedly completed');})]);
   assert.equal(samples[0].totalTokens,150);assert.equal(samples[0].complete,true);
   if(kind==='host-deadline')session.cancel(new DOMException('Generated host deadline','TimeoutError'));
   if(kind==='cancel'||kind==='late-usage')session.cancel(new DOMException('Generated owner cancellation','AbortError'));
   if(kind==='close')await session.close();
   await assert.rejects(pending,kind==='deadline'||kind==='host-deadline'?AgentTimeoutError:AgentProviderError);
   await session.close();
   const last=samples.at(-1);assert.equal(last.complete,false,kind);assert.equal(last.totalTokens,kind==='late-usage'?300:150,kind);
   assert.equal(last.inputTokens,kind==='late-usage'?200:100);assert.equal(last.outputTokens,kind==='late-usage'?100:50);
   assert.equal(last.measurement,'thread_cumulative');assert.equal(last.requests,0);
   const interrupted=samples.findIndex(sample=>sample.complete===false);assert.ok(interrupted>=0);assert.ok(samples.slice(interrupted).every(sample=>sample.complete===false),'late samples must not restore completeness after interruption');
  }finally{await session.close();}
 }
});
test('Codex successful turn usage remains complete after normal session cleanup',async t=>{
 await fake(t,'usage');const samples=[],session=new CodexSession({model:'fixture',agentTimeoutMs:5000},async()=>({}),undefined,value=>samples.push(value));
 try{await session.start('Generated successful usage',codexContextTools);await session.run('Generated completed turn');const before=structuredClone(samples.at(-1));assert.equal(before.complete,true);await session.close();assert.deepEqual(samples.at(-1),before);}finally{await session.close();}
});
test('Codex structured quota errors retain safe typed state without exposing provider text',async t=>{
 await fake(t,'structured-error');const agent=createAgent({reader,protocol:'codex-app-server',model:'fixture',agentTimeoutMs:5000});t.after(()=>agent.close());
 await assert.rejects(agent.query({question:'Generated failure'}),e=>e.details?.category==='blocked'&&e.details.code==='provider_quota'&&!e.message.includes('synthetic-private'));
});


test('Codex discovers a pinned capability, rejects malformed arguments and dispatches valid registered metadata',async t=>{
 const root=await fake(t,'contribution');const {ContextToolRegistry}=await import('../dist/tool-contributions.js');const tools=new ContextToolRegistry();let calls=0;
 tools.register({name:'fixture_context',version:'generated-1',description:'Generated read-only metadata',fields:{count:{type:'integer',required:true}},maxCharacters:1000,parse:args=>args,authorize:()=>true,read:()=>{calls++;return {fixture:'generated'};}});
 const agent=createAgent({reader:{...reader,contextTools:()=>tools.snapshot()},protocol:'codex-app-server',model:'fixture',agentTimeoutMs:5000});t.after(()=>agent.close());
 const answer=await agent.query({question:'Read generated metadata'});assert.equal(calls,1);assert.deepEqual(answer.trace.map(row=>row.tool),['capability_discover','fixture_context']);assert.deepEqual(answer.citations,[]);
});

test('Codex receives a nested region schema and metadata, then native region plus budgets and successful repeat',async t=>{
 const root=await fake(t,'image-region'),events=[],bytes=await sharp({create:{width:20,height:30,channels:3,background:'#145abc'}}).png().toBuffer();
 const parent={...record,provenance:{document:{attachments:[{id:'generated-image',mimeType:'image/png'}]}}};
 const agent=createAgent({reader:{...reader,timeline:async()=>({items:([parent]),nextCursor:null}),evidence:async()=>[parent],readImage:args=>generatedImageRead(bytes,args)},protocol:'codex-app-server',model:'fixture',agentTimeoutMs:5000});t.after(()=>agent.close());
 const answer=await agent.query({question:'Generated model-selected region',onTrace:e=>events.push(e)});assert.equal(answer.citations[0].id,record.id);
 const messages=(await readFile(join(root,'rpc.ndjson'),'utf8')).trim().split('\n').map(JSON.parse);
 assertRegionSchema(assert,messages.find(m=>m.method==='thread/start').params.dynamicTools.find(t=>t.name==='read_image').inputSchema);
 const metadata=messages.find(m=>m.id===1001).result,first=messages.find(m=>m.id===1002).result,repeat=messages.find(m=>m.id===1003).result;
 assert.deepEqual(metadata.contentItems.map(x=>x.type),['inputText']);assert.equal(JSON.parse(metadata.contentItems[0].text).imageBudget.remainingPayloads,4);
 const delivered=JSON.parse(first.contentItems[0].text);assert.deepEqual(delivered.imageView.region,{x:1,y:2,width:4,height:5});assert.equal(delivered.imageView.delivery,'prepared');assert.equal(delivered.imageBudget.remainingPayloads,3);assert.ok(delivered.hostBudget.remainingCalls>0);
 assert.equal(first.contentItems[1].type,'inputImage');assert.deepEqual(repeat.contentItems.map(x=>x.type),['inputText']);assert.equal(JSON.parse(repeat.contentItems[0].text).imageDisclosure.status,'already_disclosed');
 const imageData=first.contentItems[1].imageUrl.split(',')[1];assert.ok(!JSON.stringify(events).includes(imageData));
 assert.deepEqual(answer.trace.filter(t=>t.tool==='read_image').map(t=>t.imageView.delivery),['metadata','prepared','already_disclosed']);
});


test('Codex three correction turns carry fresh host feedback on one thread and stop immediately on acceptance',async t=>{
 const root=await fake(t),events=[];let checks=0;const codes=['quote_not_found','quote_offset_mismatch','coverage'];
 const agent=createAgent({reader,protocol:'codex-app-server',model:'fixture',agentTimeoutMs:5000});t.after(()=>agent.close());
 await agent.query({question:'Generated progressive repairs',onTrace:e=>events.push(e),validateOutput:()=>++checks<=3?{code:codes[checks-1],feedback:'Generated correction '+checks}:undefined});
 assert.equal(checks,4);const rpc=(await readFile(join(root,'rpc.ndjson'),'utf8')).trim().split('\n').map(JSON.parse);
 assert.equal(rpc.filter(m=>m.method==='thread/start').length,1);assert.equal(rpc.filter(m=>m.method==='turn/start').length,4);
 const repairs=events.filter(e=>e.type==='model.started'&&e.payload?.repair);assert.deepEqual(repairs.map(e=>e.payload.repairAttempt),[1,2,3]);
 for(let i=0;i<3;i++)assert.match(repairs[i].payload.prompt,new RegExp(codes[i]));
});

test('Codex cancellation during correction starts no additional turn',async t=>{
 const root=await fake(t),controller=new AbortController();let checks=0;
 const agent=createAgent({reader,protocol:'codex-app-server',model:'fixture',agentTimeoutMs:5000});t.after(()=>agent.close());
 await assert.rejects(agent.query({question:'Generated cancelled correction',signal:controller.signal,validateOutput:()=>{if(++checks===2)controller.abort();return {code:'quote_not_found',feedback:'Generated rejected quote'};}}));
 const rpc=(await readFile(join(root,'rpc.ndjson'),'utf8')).trim().split('\n').map(JSON.parse);assert.equal(rpc.filter(m=>m.method==='turn/start').length,2);
});


test('Codex import preview corrections keep the staging thread and are bounded at three',async t=>{
 for(const mode of ['import-repairs','import-invalid']){
  const root=await fake(t,mode),workspace=join(root,'workspace');await mkdir(workspace);
  const agent=createImportAgent({protocol:'codex-app-server',model:'fixture',agentTimeoutMs:5000});
  try{const input={workspace,inputPaths:[],instruction:'Generated preview',helperPath:'fixture',manifestSchema:{}};
   if(mode==='import-invalid')await assert.rejects(agent.prepare(input));else assert.equal((await agent.prepare(input)).summary,'Generated import preview');
   const rpc=(await readFile(join(root,'rpc.ndjson'),'utf8')).trim().split('\n').map(JSON.parse);assert.equal(rpc.filter(m=>m.method==='thread/start').length,1);assert.equal(rpc.filter(m=>m.method==='turn/start').length,4);
  }finally{await agent.close();}
 }
});
