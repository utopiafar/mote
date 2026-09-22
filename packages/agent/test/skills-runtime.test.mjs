import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAgent} from '../dist/index.js';
import {createImportAgent} from '../dist/import-agent.js';
import {startBridge,TOOL_NAMES} from '../dist/bridge.js';

const id='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222';
const prefix='UNDISCLOSED_PREFIX::',body='合成记录：我计划学习 TypeScript，尚未开始。',suffix='::UNDISCLOSED_SUFFIX';
const record={id,capturedAt:'2026-09-15T01:00:00.000Z',appName:'Generated diary',deviceId:'generated',ocrText:prefix+body+suffix,provenance:{sourceId:'fixture',externalId:'diary-1',revision:'one',layer:'original',document:{recordedAt:'2018-05-03T09:00:00+08:00',timeBasis:'recorded',contentRole:'authored'}}};
const reader={search:async()=>[record],timeline:async()=>[record],evidence:async()=>[record],activity:async()=>({}),devices:async()=>[]};
async function provider(handler){
  const requests=[],errors=[];
  const server=createServer(async(req,res)=>{
    try{
      let raw='';for await(const chunk of req)raw+=chunk;const request=JSON.parse(raw);requests.push(request);
      const response=await handler(request,requests.length-1),tool=response.tool;
      const delta=tool?{role:'assistant',tool_calls:[{index:0,id:'generated-call-'+requests.length,type:'function',function:{name:tool.name,arguments:JSON.stringify(tool.args)}}]}:{role:'assistant',content:JSON.stringify(response.answer)};
      res.writeHead(200,{'Content-Type':'text/event-stream'});
      res.write(`data: ${JSON.stringify({id:'generated-'+requests.length,object:'chat.completion.chunk',model:'fixture-model',choices:[{index:0,delta,finish_reason:null}]})}\n\n`);
      res.end(`data: ${JSON.stringify({id:'generated-'+requests.length,choices:[{index:0,delta:{},finish_reason:tool?'tool_calls':'stop'}],usage:{prompt_tokens:80,completion_tokens:40,total_tokens:120}})}\n\ndata: [DONE]\n\n`);
    }catch(error){errors.push(error);res.writeHead(500);res.end('generated fixture failure');}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {requests,errors,baseUrl:`http://127.0.0.1:${server.address().port}`,async close(){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}};
}
async function call(bridge,tool,args={}){const response=await fetch(bridge.url+'/'+tool,{method:'POST',headers:{Authorization:'Bearer '+bridge.token,'Content-Type':'application/json'},body:JSON.stringify(args)});return {status:response.status,body:await response.json()};}

test('extraction seed enforces exact ranges, authored dates, original boundaries and selected device',async t=>{
  const ranges=[{id,offset:prefix.length,length:body.length}];
  const bridge=await startBridge(reader,{question:'generated',evidenceIds:[id],evidenceRanges:ranges,after:'2018-05-01T00:00:00Z',before:'2018-06-01T00:00:00Z',deviceId:'generated',timeZone:'Asia/Shanghai'},20);t.after(()=>bridge.close());
  assert.equal(bridge.seedEvidence[0].ocrText,body);assert.equal(bridge.seedEvidence[0].displayContentAt,'2018-05-03T09:00:00+08:00');
  assert.equal((await call(bridge,'search_context',{query:'anything'})).status,400);
  assert.equal((await call(bridge,'evidence',{ids:[other]})).status,400);
  assert.equal((await call(bridge,'evidence',{ids:[id],offset:0,length:prefix.length})).status,400);
  const valid=await call(bridge,'evidence',{ids:[id],offset:prefix.length,length:4});assert.equal(valid.status,200);assert.equal(valid.body.data[0].ocrText,body.slice(0,4));
  assert.equal((await call(bridge,'evidence',{ids:[id]})).body.data[0].ocrText,body);
  for(const input of [
    {evidenceIds:[other]},
    {evidenceIds:[id],evidenceRanges:[]},
    {evidenceRanges:ranges},
    {evidenceIds:[id],evidenceRanges:[{id,offset:record.ocrText.length,length:1}]},
    {evidenceIds:[id],deviceId:'other'},
    {evidenceIds:[id],after:'2026-09-01T00:00:00Z'},
  ])await assert.rejects(startBridge(reader,{question:'generated invalid',...input},2));
  await assert.rejects(startBridge({...reader,evidence:async()=>[{...record,ocrText:'🌱'}]},{question:'split surrogate',evidenceIds:[id],evidenceRanges:[{id,offset:1,length:1}]},2),/UTF-16/);
});

test('native skill tool loads its body inside real Harness while memory batches cannot retrieve outside text', {timeout:90000}, async()=>{
  const fixture=await provider((request,stage)=>{
    assert.deepEqual(request.tools.map(t=>t.function.name).sort(),['evidence','skill'].sort());
    assert.ok(!JSON.stringify(request.messages).includes(prefix));assert.ok(!JSON.stringify(request.messages).includes(suffix));
    if(stage===0)return {tool:{name:'skill',args:{name:'memory-extraction'}}};
    if(stage===1)return {tool:{name:'evidence',args:{ids:[id],offset:0,length:5}}};
    if(stage===2)return {tool:{name:'evidence',args:{ids:[id]}}};
    return {answer:{answer:`合成计划尚未完成 [${id}]`,citationIds:[id]}};
  });
  const agent=createAgent({reader,model:'fixture-model',apiKey:'generated-only',baseUrl:fixture.baseUrl,timeoutMs:60000});
  try{
    const result=await agent.query({question:'Process supplied evidence',skill:'memory-extraction',evidenceIds:[id],evidenceRanges:[{id,offset:prefix.length,length:body.length}],timeZone:'Asia/Shanghai'});
    assert.deepEqual(fixture.errors,[]);assert.equal(fixture.requests.length,4);assert.equal(result.citations[0].excerpt,body);
    const tools=fixture.requests.at(-1).messages.filter(m=>m.role==='tool');
    assert.ok(tools.some(m=>JSON.stringify(m).includes('# Memory extraction')));
    assert.ok(tools.some(m=>JSON.stringify(m).includes('outside this extraction batch')));
    assert.ok(tools.some(m=>JSON.stringify(m).includes(body)));
    assert.deepEqual(result.trace.map(row=>row.tool),['evidence']);
  }finally{await agent.close();await fixture.close();}
});

test('dedicated import Harness uses native skill, read, write and shell tools to generate a reviewed manifest', {timeout:90000}, async()=>{
  const workspace=await mkdtemp(join(tmpdir(),'mote-native-import-generated-'));await mkdir(join(workspace,'inputs'));
  await writeFile(join(workspace,'inputs','generated.json'),JSON.stringify({id:'generated-record',text:'合成日记原文，没有真实个人资料。',recordedAt:'2020-02-03T08:00:00+08:00'}));
  await writeFile(join(workspace,'helper.mjs'),'export const validateRecords = () => true;\n');
  const script="import{readFileSync,writeFileSync}from'node:fs';import{createHash}from'node:crypto';const input=JSON.parse(readFileSync('inputs/generated.json','utf8'));const item={externalId:input.id,revision:createHash('sha256').update(input.text).digest('hex'),observedAt:'2026-09-15T01:00:00Z',title:'合成导入',text:input.text,kind:'file',layer:'original',document:{recordedAt:input.recordedAt,timeBasis:'recorded',contentRole:'authored'}};writeFileSync('records.jsonl',JSON.stringify({item,evidencePaths:['inputs/generated.json']})+'\\n');writeFileSync('dispositions.json',JSON.stringify({items:[{path:'inputs/generated.json',status:'parsed',reason:'generated fixture'}]}));console.log('GENERATED_MANIFEST_WRITTEN');";
  const fixture=await provider((request,stage)=>{
    const names=request.tools.map(t=>t.function.name);for(const name of ['skill','read','write','bash'])assert.ok(names.includes(name),'native tool missing: '+name);
    assert.ok(!names.includes('search_context'),'import runtime has no archive query tools');
    if(stage===0)return {tool:{name:'skill',args:{name:'document-import'}}};
    if(stage===1)return {tool:{name:'read',args:{file_path:join(workspace,'inputs','generated.json')}}};
    if(stage===2)return {tool:{name:'write',args:{file_path:join(workspace,'convert.mjs'),content:script}}};
    if(stage===3)return {tool:{name:'bash',args:{command:"'"+process.execPath.replaceAll("'","'\\''")+"' convert.mjs"}}};
    if(stage===4)return {tool:{name:'read',args:{file_path:join(workspace,'records.jsonl')}}};
    if(stage===5)return {answer:'Generated analysis finished, but this is not the required preview object.'};
    return {answer:{summary:'识别并生成一条合成资料；日期来自原始字段。',recordsPath:'records.jsonl',warnings:[]}};
  });
  const agent=createImportAgent({model:'fixture-model',apiKey:'generated-only',baseUrl:fixture.baseUrl,timeoutMs:60000});
  try{
    const observed=[];
    const result=await agent.prepare({workspace,inputPaths:['inputs/generated.json'],instruction:'导入生成测试资料',helperPath:join(workspace,'helper.mjs'),manifestSchema:{type:'object'}},notification=>{observed.push(notification);});
    assert.deepEqual(fixture.errors,[]);assert.equal(result.recordsPath,'records.jsonl');
    assert.equal(fixture.requests.length,7,'Native runtime performs exactly one final-format repair');
    assert.ok(fixture.requests.at(-1).messages.some(message=>typeof message.content==='string'&&message.content.includes('validationError')));
    assert.ok(observed.some(notification=>notification.method==='session.event'&&notification.params.event.type==='tool/call'));
    assert.ok(observed.some(notification=>notification.method==='session.event'&&notification.params.event.type==='tool/result'));
    const manifest=JSON.parse((await readFile(join(workspace,'records.jsonl'),'utf8')).trim());assert.equal(manifest.item.text,'合成日记原文，没有真实个人资料。');assert.equal(manifest.item.document.recordedAt,'2020-02-03T08:00:00+08:00');
    assert.ok(fixture.requests.at(-1).messages.filter(m=>m.role==='tool').some(m=>JSON.stringify(m).includes('GENERATED_MANIFEST_WRITTEN')));
    assert.equal(JSON.parse(await readFile(join(workspace,'dispositions.json'),'utf8')).items[0].status,'parsed');
  }finally{await agent.close();await fixture.close();await rm(workspace,{recursive:true,force:true});}
});

test('calendar skill receives notification evidence without OCR and exposes no write tools', {timeout:60000},async()=>{
  const text='合成通知：2099年9月18日15点到16点方案评审。';
  const notification={...record,ocrText:'',source:'notification',metadata:{version:1,observedAt:record.capturedAt,notification:{action:'posted',notificationKey:'ab'.repeat(32),postedAt:record.capturedAt,ongoing:false,groupSummary:false,text}}};
  const fixture=await provider((request,stage)=>{
    const names=request.tools.map(t=>t.function.name);assert.ok(names.includes('skill'));assert.ok(!names.some(n=>['bash','write','calendar_create','create_event'].includes(n)));
    assert.ok(JSON.stringify(request.messages).includes(text));assert.ok(JSON.stringify(request.messages).includes('calendar-extraction'));
    if(stage===0)return {tool:{name:'skill',args:{name:'calendar-extraction'}}};
    return {answer:{answer:'{"actions":[]}',citationIds:[]}};
  });
  const agent=createAgent({reader:{...reader,evidence:async()=>[notification]},model:'fixture-model',apiKey:'generated-only',baseUrl:fixture.baseUrl,timeoutMs:45000});
  try{const result=await agent.query({question:'只读分析合成日程',skill:'calendar-extraction',evidenceIds:[id],evidenceRanges:[{id,offset:0,length:text.length}],timeZone:'Asia/Shanghai'});assert.deepEqual(JSON.parse(result.answer),{actions:[]});assert.deepEqual(fixture.errors,[]);}finally{await agent.close();await fixture.close();}
});

test('calendar Harness actually retrieves historical action comparisons through its host grant', {timeout:60000},async()=>{
  const seen=[];const fixture=await provider((request,stage)=>{
    assert.deepEqual(request.tools.map(t=>t.function.name).sort(),['action_catalog','evidence','skill']);
    if(stage===0)return {tool:{name:'action_catalog',args:{query:'Generated previous participant',limit:1}}};
    if(stage===1){assert.ok(JSON.stringify(request.messages).includes('generated-next-page'));return {tool:{name:'action_catalog',args:{query:'Generated previous participant',cursor:'generated-next-page',limit:1}}};}
    assert.ok(JSON.stringify(request.messages).includes('Generated historical comparison'));return {answer:{answer:'{"actions":[]}',citationIds:[]}};
  });
  const agent=createAgent({reader,model:'fixture-model',apiKey:'generated-only',baseUrl:fixture.baseUrl,timeoutMs:45000});
  try{const result=await agent.query({question:'Compare generated update with older proposals',skill:'calendar-extraction',evidenceIds:[id],evidenceRanges:[{id,offset:prefix.length,length:body.length}],actionCatalog:async args=>{seen.push(args);return args.cursor?{items:[{id:other,event:{title:'Generated historical comparison'}}],nextCursor:null}:{items:[],nextCursor:'generated-next-page'};}});assert.equal(seen.length,2);assert.equal(seen[1].cursor,'generated-next-page');assert.equal(result.citations.length,0);assert.deepEqual(result.trace.map(row=>row.tool),['action_catalog','action_catalog']);assert.deepEqual(fixture.errors,[]);}finally{await agent.close();await fixture.close();}
});
