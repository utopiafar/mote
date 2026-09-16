import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import type {AddressInfo} from 'node:net';
import {testModelConnection} from '../src/model-agent.js';

test('connection probe uses the real Harness for generated search, evidence and cited final response', {timeout:45000}, async()=>{
  const id='mote-model-connection-test';
  const requests: {url?:string;authorization?:string;body:Record<string,any>}[]=[];
  const provider=createServer(async(req,res)=>{
    let raw='';for await (const chunk of req) raw+=chunk;
    const body=JSON.parse(raw),stage=requests.length;
    requests.push({url:req.url,authorization:req.headers.authorization,body});
    const tool=stage===0 ? {name:'search_context',arguments:JSON.stringify({query:'generated connection test record'})}
      : stage===1 ? {name:'evidence',arguments:JSON.stringify({ids:[id]})} : undefined;
    const delta=tool ? {role:'assistant',tool_calls:[{index:0,id:`probe_call_${stage}`,type:'function',function:tool}]}
      : {role:'assistant',content:JSON.stringify({answer:`The generated record confirms a read-only model tool round trip. [${id}]`,citationIds:[id]})};
    res.writeHead(200,{'Content-Type':'text/event-stream'});
    res.write(`data: ${JSON.stringify({id:`probe_${stage}`,choices:[{index:0,delta,finish_reason:null}]})}\n\n`);
    res.write(`data: ${JSON.stringify({id:`probe_${stage}`,choices:[{index:0,delta:{},finish_reason:tool?'tool_calls':'stop'}],usage:{prompt_tokens:80,completion_tokens:40,total_tokens:120}})}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve=>provider.listen(0,'127.0.0.1',resolve));
  try {
    // Omit the factory override: this exercises the production createAgent and
    // the probe's own generated reader, with no archive/store available to it.
    const result=await testModelConnection({
      provider:'custom',protocol:'openai-completions',model:'synthetic-probe-model',
      baseUrl:`http://127.0.0.1:${(provider.address() as AddressInfo).port}/v1`,
      apiKey:'synthetic-probe-key',headers:{},extraBody:{},reasoningEffort:'auto',
      maxTokens:8192,timeoutMs:30000,allowUnauthenticatedLocal:false,
    });
    assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.code,'ok');
    assert.ok(Number.isFinite(result.durationMs)&&result.durationMs>=0);assert.equal(requests.length,3);
    const tools=['activity','devices','evidence','file_chunks','media_activity','memories','search_context','skill','source_history','source_items','sources','timeline'];
    for (const request of requests) {
      assert.equal(request.url,'/v1/chat/completions');assert.equal(request.authorization,'Bearer synthetic-probe-key');
      assert.equal(request.body.model,'synthetic-probe-model');assert.equal(request.body.stream,true);
      assert.deepEqual(request.body.tools.map((tool:any)=>tool.function.name).sort(),tools);
      assert.equal(request.body.thinking,undefined);assert.equal(request.body.reasoning_effort,undefined);
    }
    const results=requests[2].body.messages.filter((message:any)=>message.role==='tool');
    assert.deepEqual(results.map((message:any)=>message.tool_call_id),['probe_call_0','probe_call_1']);
    for (const message of results) {
      const evidence=JSON.parse(message.content);
      assert.equal(evidence.source,'untrusted_personal_context');assert.equal(evidence.data.length,1);
      assert.equal(evidence.data[0].id,id);assert.equal(evidence.data[0].appName,'Mote synthetic connection test');
      assert.equal(evidence.data[0].ocrText,'This generated test record confirms a read-only model tool round trip. No personal archive is connected.');
    }
  } finally {
    provider.closeAllConnections();await new Promise<void>(resolve=>provider.close(()=>resolve()));
  }
});
