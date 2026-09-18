import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import sharp from 'sharp';
import {createAgent} from '../dist/index.js';
import {startBridge} from '../dist/bridge.js';
const record={id:'generated-image',capturedAt:'2026-09-18T00:00:00Z',appName:'Fixture',deviceId:'fixture',sourceType:'screen',ocrText:'Generated OCR',blobHash:'a'.repeat(64)};
test('image tool requires prior text expansion, scope and a bounded read budget',async t=>{
 let calls=0;const reader={search:async()=>[record],timeline:async()=>[record],evidence:async()=>[record],activity:async()=>({}),devices:async()=>[],readImage:async()=>{calls++;return {mimeType:'image/png',data:'Zml4dHVyZQ=='};}};
 const b=await startBridge(reader,{question:'fixture',deviceId:'fixture'},24);t.after(()=>b.close());
 const call=(tool,args)=>fetch(b.url+'/'+tool,{method:'POST',headers:{Authorization:'Bearer '+b.token,'Content-Type':'application/json'},body:JSON.stringify(args)});
 assert.equal((await call('read_image',{id:record.id})).status,400);await call('search_context',{});assert.equal((await call('read_image',{id:record.id})).status,400);await call('evidence',{ids:[record.id]});assert.equal((await call('read_image',{id:record.id})).status,200);assert.equal(calls,1);
});
test('Harness sends image bytes only after model-selected read_image', {timeout:45000},async t=>{
 const bytes=await sharp({create:{width:8,height:8,channels:3,background:'#abcabc'}}).png().toBuffer(),requests=[];
 const reader={search:async()=>[record],timeline:async()=>[record],evidence:async()=>[record],activity:async()=>({}),devices:async()=>[],readImage:async()=>({mimeType:'image/png',data:bytes.toString('base64')})};
 const actions=[['search_context',{}],['evidence',{ids:[record.id]}],['read_image',{id:record.id}]];
 const server=createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);requests.push(body);const action=actions[requests.length-1];res.writeHead(200,{'content-type':'text/event-stream'});const send=value=>res.write('data: '+JSON.stringify(value)+'\n\n');send({id:'fixture',choices:[{index:0,delta:action?{role:'assistant',tool_calls:[{index:0,id:'call'+requests.length,type:'function',function:{name:action[0],arguments:JSON.stringify(action[1])}}]}:{role:'assistant',content:JSON.stringify({answer:'Generated image verified. ['+record.id+']',citationIds:[record.id]})},finish_reason:null}]});send({id:'fixture',choices:[{index:0,delta:{},finish_reason:action?'tool_calls':'stop'}],usage:{prompt_tokens:10,completion_tokens:10,total_tokens:20}});res.end('data: [DONE]\n\n');});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const agent=createAgent({reader,protocol:'openai-completions',model:'fixture-vision',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,apiKey:'fixture',timeoutMs:30000});t.after(()=>agent.close());
 await agent.query({question:'Inspect the generated image'});assert.equal(requests.length,4);for(const r of requests.slice(0,3))assert.ok(!JSON.stringify(r).includes('data:image/'));assert.ok(JSON.stringify(requests[3]).includes('data:image/'));
});
