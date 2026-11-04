import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';
import {assertSourceContextDependencies} from '../src/source-context-lineage.js';

for(const mutation of ['progress','rename','disable','retention','delete'] as const)test(`actual HTTP provider source metadata receipts preserve continuation and ${mutation} authority`,async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-source-query-lineage-')),token='generated-source-query-owner',headers={authorization:'Bearer '+token},sourceId='generated-recordings',text='Generated narrator repeatedly worked on the telescope project.';
 let node!:Awaited<ReturnType<typeof buildApp>>,ref='',id='',mutated=false;const requests:any[]=[];
 const endpoint=createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);requests.push(body);
  const tools=body.messages.filter((message:any)=>message.role==='tool'),stage=tools.length;
  const actions=[{name:'context_index',args:{path:'/context'}},{name:'context_index',args:{path:'/context/sources'}},{name:'capability_discover',args:{name:'sources'}},{name:'capability_execute',args:{name:'sources',version:'1',argumentsJson:JSON.stringify({query:'Generated recordings'})}},{name:'material_catalog',args:{sourceId}},{name:'material_read',args:{ref,length:12000}}];
  if(stage===6&&!mutated){mutated=true;if(mutation==='progress')node.sources.reportStatus(sourceId,{state:'syncing',lastSyncAt:'2026-10-14T02:00:00Z'});else if(mutation==='rename')node.sources.update(sourceId,{name:'Generated revised private name'});else if(mutation==='disable')node.sources.update(sourceId,{enabled:false});else if(mutation==='retention')node.sources.update(sourceId,{retention:'reference'});else node.store.db.prepare('DELETE FROM source_connections WHERE id=?').run(sourceId);}
  const action=actions[stage];res.writeHead(200,{'Content-Type':'text/event-stream'});
  const send=(value:unknown)=>res.write('data: '+JSON.stringify(value)+'\n\n');
  send({id:'generated-'+requests.length,choices:[{index:0,delta:action?{role:'assistant',tool_calls:[{index:0,id:'generated_call_'+stage,type:'function',function:{name:action.name,arguments:JSON.stringify(action.args)}}]}:{role:'assistant',content:JSON.stringify({answer:`Generated supported telescope work [${id}]`,citationIds:[id]})},finish_reason:null}]});
  send({id:'generated-'+requests.length,choices:[{index:0,delta:{},finish_reason:action?'tool_calls':'stop'}],usage:{prompt_tokens:80,completion_tokens:40,total_tokens:120}});res.end('data: [DONE]\n\n');
 });await new Promise<void>(resolve=>endpoint.listen(0,'127.0.0.1',resolve));
 const cfg:Config={dataDir:directory,token,tokenPath:'generated',host:'127.0.0.1',port:0,maxStorageBytes:30_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'generated-provider',modelProvider:'custom',modelProtocol:'openai-completions',modelBaseUrl:`http://127.0.0.1:${(endpoint.address() as {port:number}).port}/v1`,apiKey:'generated-fixture-only',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',logLevel:'silent'};
 node=await buildApp(cfg,{backgroundWorker:false});t.after(async()=>{await node.app.close();endpoint.closeAllConnections();await new Promise<void>(resolve=>endpoint.close(()=>resolve()));rmSync(directory,{recursive:true,force:true});});
 const api=(method:'GET'|'POST'|'PUT',url:string,payload?:unknown)=>node.app.inject({method,url,headers,payload:payload as any});
 assert.equal((await api('POST','/api/sources',{id:sourceId,name:'Generated recordings',kind:'custom',deviceId:'generated',platform:'import',retention:'archive'})).statusCode,200);
 assert.equal((await api('PUT','/api/sources/'+sourceId+'/items',{externalId:'generated-diary',revision:'1',observedAt:'2026-10-01T00:00:00Z',kind:'message',layer:'original',text})).statusCode,200);await node.materialOrganizer.tick();
 ref=node.materials.list({sourceId}).items[0].ref;id=node.materials.evidenceIds(ref)[0];
 const first=await api('POST','/api/query',{question:'Generated recent personal project question',timeZone:'Asia/Shanghai'});
 if(mutation!=='progress'){assert.equal(first.statusCode,409,first.body);assert.equal(first.json().error,'source_context_changed');assert.equal(node.delegation.get(node.store.db.prepare('SELECT id FROM delegation_works ORDER BY rowid DESC LIMIT 1').get()!.id as string).error,'source_context_changed');return;}
 assert.equal(first.statusCode,200,first.body);const answer=first.json();assert.equal(answer.evidenceDependencies.complete,true);assert.ok(answer.evidenceDependencies.ids.includes(id));assert.equal(answer.sourceContextDependencies.filter((pin:any)=>pin.kind==='metadata').length,1);assert.equal(answer.citations[0].id,id);
 assertSourceContextDependencies(node.sources.contexts,answer.sourceContextDependencies);
 assert.equal(node.store.db.prepare("SELECT count(*) n FROM delegation_source_context_dependencies WHERE kind='metadata'").get()!.n,1,'metadata identity survives the durable coordinator journal');
 const runId=randomUUID(),second=await api('POST','/api/query-runs',{id:runId,input:{question:'Generated second month-by-month question',conversationId:answer.conversationId}});assert.equal(second.statusCode,202,second.body);
 let run:any;for(let i=0;i<500;i++){run=(await api('GET','/api/query-runs/'+runId)).json();if(run.status!=='running')break;await new Promise(resolve=>setTimeout(resolve,5));}
 assert.equal(run.status,'completed',JSON.stringify(run));const conversation=(await api('GET','/api/conversations/'+answer.conversationId)).json();assert.equal(conversation.turnCount,2);assert.equal(conversation.turns[1].result.evidenceDependencies.complete,true);
 assert.ok(!JSON.stringify(requests).includes('disclosureDependencies'));assert.ok(!JSON.stringify(requests).includes('sourceContextDependencies'));assert.ok(!JSON.stringify(requests).includes('"kind":"metadata"'),'private lineage never becomes model evidence');
 assert.ok(JSON.stringify(requests).includes('statusObservedAt'),'runtime source status has explicit point-in-time accounting');assert.ok(requests.length>=14);
});
