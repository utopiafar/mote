import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import sharp from 'sharp';
import {createAgent} from '../dist/index.js';
import {startBridge} from '../dist/bridge.js';
const record={id:'generated-image',capturedAt:'2026-09-18T00:00:00Z',appName:'Fixture',deviceId:'fixture',sourceType:'screen',ocrText:'Generated OCR',blobHash:'a'.repeat(64)};
async function invoke(b,tool,args,ack=true){const res=await fetch(b.url+'/'+tool,{method:'POST',headers:{Authorization:'Bearer '+b.token,'Content-Type':'application/json'},body:JSON.stringify(args)});const result={status:res.status,body:await res.json()};if(ack&&result.body.imageDelivery)b.imageDelivery(result.body.imageDelivery,true);return result;}
test('failed local image delivery releases concurrent readers and permits a fresh first image',async t=>{
 const data=(await sharp({create:{width:8,height:8,channels:3,background:'#abcabc'}}).png().toBuffer()).toString('base64');let reads=0;
 const reader={search:async()=>[record],timeline:async()=>[record],evidence:async()=>[record],activity:async()=>({}),devices:async()=>[],readImage:async()=>{reads++;return {mimeType:'image/png',data};}};
 const b=await startBridge(reader,{question:'Generated failed image delivery'},12);t.after(()=>b.close());await invoke(b,'timeline',{});await invoke(b,'evidence',{ids:[record.id]});
 const first=await invoke(b,'read_image',{id:record.id},false);assert.equal(typeof first.body.imageDelivery,'string','the bridge must await a host delivery receipt');
 const {imageToolResult}=await import('../dist/plugin.mjs');
 let secondSettled=false;const secondPromise=invoke(b,'read_image',{id:record.id},false).then(value=>{secondSettled=true;return value;});
 while(reads<2)await new Promise(resolve=>setTimeout(resolve,1));assert.equal(secondSettled,false,'an in-flight first delivery cannot authorize duplicate metadata');
 const settle=async receipt=>{const response=await invoke(b,'_image_delivery',receipt);assert.equal(response.status,200);};
 await assert.rejects(imageToolResult(first.body,{saveImage:async()=>{throw Error('Generated local save failure');}},settle),/Generated local save failure/);
 const second=await secondPromise;assert.equal(second.body.image.data,data);assert.equal(second.body.imageDisclosure,undefined);assert.ok(reads>=3,'the waiting read checks permissions and bytes again after a failed delivery');
 const accepted=await imageToolResult(second.body,{saveImage:async()=>({id:'generated-saved-image'})},settle);assert.ok(accepted.imageAttachment);assert.equal(accepted.imageDelivery,undefined);
 const repeat=await invoke(b,'read_image',{id:record.id});assert.equal(repeat.body.imageDisclosure.status,'already_disclosed');assert.equal(repeat.body.image,undefined);
 assert.equal(b.trace.filter(entry=>entry.tool==='read_image').length,3,'host receipts are not model tool calls');
});
test('waiting duplicate rechecks authorization after delivery and bridge close releases unacknowledged waits',async()=>{
 let reads=0,authorized=true;const reader={search:async()=>[record],timeline:async()=>[record],evidence:async()=>[record],activity:async()=>({}),devices:async()=>[],readImage:async()=>{reads++;if(!authorized)throw Error('Generated revocation');return {mimeType:'image/png',data:'Zml4dHVyZQ=='};}};
 for(const revoke of [true,false]){
  reads=0;authorized=true;const b=await startBridge(reader,{question:'Generated pending authorization'},10);
  try{
   await invoke(b,'timeline',{});await invoke(b,'evidence',{ids:[record.id]});const first=await invoke(b,'read_image',{id:record.id},false);
   const pending=invoke(b,'read_image',{id:record.id},false).catch(error=>({error}));while(reads<2)await new Promise(resolve=>setTimeout(resolve,1));
   if(revoke){authorized=false;b.imageDelivery(first.body.imageDelivery,true);const denied=await pending;assert.equal(denied.status,400);assert.equal(denied.body.imageDisclosure,undefined);}
   else{await b.close();assert.ok((await pending).error,'closing a query rejects pending HTTP reads');}
  }finally{if(revoke)await b.close();}
 }
});
test('lost image receipt expires without permanently suppressing the original', {timeout:35000},async t=>{
 let reads=0;const reader={search:async()=>[record],timeline:async()=>[record],evidence:async()=>[record],activity:async()=>({}),devices:async()=>[],readImage:async()=>{reads++;return {mimeType:'image/png',data:'Zml4dHVyZQ=='};}};
 const b=await startBridge(reader,{question:'Generated missing receipt'},8);t.after(()=>b.close());await invoke(b,'timeline',{});await invoke(b,'evidence',{ids:[record.id]});
 const first=await invoke(b,'read_image',{id:record.id},false),next=await invoke(b,'read_image',{id:record.id});assert.equal(next.status,200);assert.ok(next.body.image);assert.equal(next.body.imageDisclosure,undefined);assert.ok(reads>=3);
 assert.throws(()=>b.imageDelivery(first.body.imageDelivery,true),/expired/,'late success cannot duplicate a replacement delivery');
});
test('image deduplication checks fresh permissions, selections and actual bytes within each query',async t=>{
 const images=await Promise.all(['#aabbcc','#bbaacc','#ccaabb','#ccddaa','#ddccaa'].map(background=>sharp({create:{width:8,height:8,channels:3,background}}).png().toBuffer()));
 const raw={...record,id:'raw-image'},parent={...record,id:'formal-anchor',sourceType:'message',provenance:{document:{attachments:[{id:'image-a',mimeType:'image/png'},{id:'image-b',mimeType:'image/png'}]}}};
 let current=0,authorized=true,deleted=false,attachmentPresent=true,reads=0;
 const currentRecords=()=>deleted?[]:[raw,{...parent,provenance:{document:{attachments:attachmentPresent?parent.provenance.document.attachments:[]}}}];
 const reader={search:async()=>currentRecords(),timeline:async()=>currentRecords(),evidence:async({ids})=>currentRecords().filter(r=>ids.includes(r.id)),activity:async()=>({}),devices:async()=>[],readImage:async args=>{reads++;if(!authorized)throw Error('Generated authorization revoked');return {mimeType:'image/png',data:images[args.attachmentId==='image-b'?1:current].toString('base64')};}};
 const open=async()=>{const b=await startBridge(reader,{question:'Generated image identity',deviceId:'fixture'},40);t.after(()=>b.close());await invoke(b,'timeline',{});await invoke(b,'evidence',{ids:[raw.id,parent.id]});return b;};
 const b=await open(),rawSelection={id:raw.id},formalSelection={id:parent.id,attachmentId:'image-a'};
 const first=await invoke(b,'read_image',rawSelection);assert.equal(first.status,200);assert.equal(first.body.image.data,images[0].toString('base64'));
 for(const selection of [rawSelection,formalSelection]){
  const repeat=await invoke(b,'read_image',selection);assert.equal(repeat.status,200);assert.equal(repeat.body.image,undefined);assert.equal(repeat.body.id,selection.id);assert.equal(repeat.body.attachmentId,selection.attachmentId);
  assert.deepEqual(repeat.body.imageDisclosure,{status:'already_disclosed',sha256:createHash('sha256').update(images[0]).digest('hex'),mimeType:'image/png',firstSelection:rawSelection});
 }
 assert.equal(reads,3,'aliases and repeated selections both perform a fresh host read');
 assert.equal((await invoke(b,'read_image',{id:parent.id,attachmentId:'image-b'})).body.image.data,images[1].toString('base64'),'a different attachment is not blocked');
 for(current of [2,3])assert.equal((await invoke(b,'read_image',rawSelection)).body.image.data,images[current].toString('base64'),'a changed original emits its new bytes');
 current=0;assert.equal((await invoke(b,'read_image',rawSelection)).body.imageDisclosure.status,'already_disclosed','repeats succeed at the four-unique-image limit');
 authorized=false;const beforeRevoke=reads;assert.equal((await invoke(b,'read_image',formalSelection)).status,400);assert.equal(reads,beforeRevoke+1,'a cached image cannot bypass revocation even at the image limit');authorized=true;
 attachmentPresent=false;assert.equal((await invoke(b,'read_image',formalSelection)).status,400);attachmentPresent=true;
 deleted=true;assert.equal((await invoke(b,'read_image',rawSelection)).status,400);deleted=false;
 assert.equal((await invoke(b,'read_image',{...rawSelection,region:{x:0,y:0,width:2,height:2}})).status,400,'unsupported regions are never silently treated as full images');
 current=4;assert.equal((await invoke(b,'read_image',rawSelection)).status,400,'the existing unique-image cap remains bounded');
 current=0;const next=await open();assert.equal((await invoke(next,'read_image',rawSelection)).body.image.data,images[0].toString('base64'),'a new query gets the actual image again');
});
test('concurrent identical reads append one image and repetitions still exhaust the ordinary tool budget',async t=>{
 const data=(await sharp({create:{width:8,height:8,channels:3,background:'#abcabc'}}).png().toBuffer()).toString('base64');let reads=0,release;const gate=new Promise(resolve=>release=resolve);
 const reader={search:async()=>[record],timeline:async()=>[record],evidence:async()=>[record],activity:async()=>({}),devices:async()=>[],readImage:async()=>{if(++reads===2)release();await gate;return {mimeType:'image/png',data};}};
 const b=await startBridge(reader,{question:'Generated concurrency'},4);t.after(()=>b.close());await invoke(b,'timeline',{});await invoke(b,'evidence',{ids:[record.id]});
 const results=await Promise.all([invoke(b,'read_image',{id:record.id}),invoke(b,'read_image',{id:record.id})]);assert.ok(results.every(r=>r.status===200));assert.equal(results.filter(r=>r.body.image).length,1);assert.equal(results.filter(r=>r.body.imageDisclosure?.status==='already_disclosed').length,1);assert.ok(reads>=2);
 const exhausted=await invoke(b,'read_image',{id:record.id});assert.equal(exhausted.status,400);assert.equal(exhausted.body.toolError.code,'tool_budget_exceeded');
});
test('image tool requires prior text expansion, scope and a bounded read budget',async t=>{
 let calls=0;const reader={search:async()=>[record],timeline:async()=>[record],evidence:async()=>[record],activity:async()=>({}),devices:async()=>[],readImage:async()=>{calls++;return {mimeType:'image/png',data:'Zml4dHVyZQ=='};}};
 const b=await startBridge(reader,{question:'fixture',deviceId:'fixture'},24);t.after(()=>b.close());
 const call=(tool,args)=>fetch(b.url+'/'+tool,{method:'POST',headers:{Authorization:'Bearer '+b.token,'Content-Type':'application/json'},body:JSON.stringify(args)});
 assert.equal((await call('read_image',{id:record.id})).status,400);await call('search_context',{});assert.equal((await call('read_image',{id:record.id})).status,400);await call('evidence',{ids:[record.id]});assert.equal((await call('read_image',{id:record.id})).status,200);assert.equal(calls,1);
});
test('authored image attachments retain parent scope and exact selection through the bridge',async t=>{
 const attachmentId='generated-attachment',parent={...record,sourceType:'message',capturedAt:'2026-09-27T00:00:00Z',provenance:{sourceId:'generated',externalId:'caption',revision:'1',kind:'message',layer:'original',document:{recordedAt:'2026-04-13T13:18:00+08:00',timeBasis:'recorded',contentRole:'authored',attachments:[{id:attachmentId,mimeType:'image/png'}]}}};
 const selections=[],reader={search:async()=>[parent],timeline:async()=>[parent],evidence:async()=>[parent],activity:async()=>({}),devices:async()=>[],readImage:async args=>{selections.push(args);return {mimeType:'image/png',data:'Zml4dHVyZQ=='};}};
 const b=await startBridge(reader,{question:'Generated caption and image',after:'2026-04-13T00:00:00+08:00',before:'2026-04-14T00:00:00+08:00'},24);t.after(()=>b.close());
 const call=(tool,args)=>fetch(b.url+'/'+tool,{method:'POST',headers:{Authorization:'Bearer '+b.token,'Content-Type':'application/json'},body:JSON.stringify(args)});
 assert.equal((await call('read_image',{id:parent.id,attachmentId})).status,400);
 assert.equal((await call('search_context',{})).status,200);assert.equal((await call('evidence',{ids:[parent.id]})).status,200);
 assert.equal((await call('read_image',{id:parent.id,attachmentId:'another'})).status,400);
 const image=await call('read_image',{id:parent.id,attachmentId});assert.equal(image.status,200,await image.clone().text());assert.equal((await image.json()).attachmentId,attachmentId);
 assert.deepEqual(selections,[{id:parent.id,attachmentId}]);
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
