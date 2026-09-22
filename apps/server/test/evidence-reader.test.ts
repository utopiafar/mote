import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type {ContextReader} from '@mote/agent';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';
import {parseEvidenceRef} from '../src/evidence-reader.js';
const token='generated-context-owner-token-123456789',readToken='generated-context-mcp-token-123456789';
const headers={authorization:`Bearer ${token}`};

async function fixture(t:any){
 const dir=mkdtempSync(join(tmpdir(),'mote-shared-reader-'));let agentReader!:ContextReader;
 const config:Config={dataDir:dir,token,tokenPath:'fixture-only',host:'127.0.0.1',port:0,maxStorageBytes:20_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'fixture-model',modelBaseUrl:'https://synthetic.invalid',apiKey:'synthetic-key',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',connectors:{directory:join(dir,'connectors'),mcpEnabled:true,mcpReadToken:readToken}};
 const node=await buildApp(config,{createModelAgent:async(_settings,reader)=>{agentReader=reader;return {configured:true,query:async()=>({answer:'fixture',citations:[],trace:[],runId:randomUUID()}),close:async()=>{}};}});
 await node.app.listen({host:'127.0.0.1',port:0});
 const client=new Client({name:'generated-reader-test',version:'1.0'});
 await client.connect(new StreamableHTTPClientTransport(new URL('/mcp',node.app.listeningOrigin),{requestInit:{headers:{authorization:`Bearer ${readToken}`}}}));
 t.after(async()=>{await client.close();await node.app.close();rmSync(dir,{recursive:true,force:true});});
 const call=async(name:string,args:Record<string,unknown>)=>{const result=await client.callTool({name,arguments:args});assert.ok(!result.isError,JSON.stringify(result));return result.structuredContent??JSON.parse((result.content as any[])[0].text);};
 return {...node,agentReader,call};
}

test('Web, MCP and Agent share ranked refs and scoped expansions across 400 generated days',async t=>{
 const {app,store,sources,agentReader,call}=await fixture(t);
 for(const device of ['a','b'])sources.register({id:`source-${device}`,name:`Generated ${device}`,kind:'custom',deviceId:device,platform:'import'});
 const batches=new Map<string,any[]>([['source-a',[]],['source-b',[]]]);
 for(let i=0;i<400;i++){
  const input={externalId:`item-${i}`,revision:'1',observedAt:new Date(Date.UTC(2024,0,1+i)).toISOString(),title:`Generated ${i}`,text:`SHARED_READER_ANCHOR ${i}`,kind:'message',layer:'original'};
  const source=`source-${i%2?'a':'b'}`;
  // Exercise both one-at-a-time and batch source writes without personal data.
  if(i<200)await sources.upsert(source,input);else batches.get(source)!.push(input);
 }
 for(const [source,items] of batches)await sources.upsertBatch(source,items);
 const scope={deviceId:'a',after:'2024-06-01T00:00:00.000Z',before:'2024-12-01T00:00:00.000Z',query:'SHARED_READER_ANCHOR',limit:20};
 const web=await app.inject({url:'/api/context/retrieve?'+new URLSearchParams(Object.entries(scope).map(([k,v])=>[k,String(v)])),headers});assert.equal(web.statusCode,200,web.body);
 const mcp:any=await call('mote_retrieve',scope),agent=await agentReader.search(scope);
 assert.deepEqual(web.json().items.map((r:any)=>r.id),agent.map(r=>r.id));assert.deepEqual(mcp.items,web.json().items);
 assert.equal(agent.length,20);
 const refs=web.json().items.slice(0,5).map((r:any)=>r.ref);
 const readScope={deviceId:'a',after:scope.after,before:scope.before};
 const webRead=(await app.inject({method:'POST',url:'/api/context/read',headers,payload:{refs,...readScope}})).json();
 assert.deepEqual(await call('mote_read',{refs,...readScope}),webRead);
 assert.deepEqual((await agentReader.evidence({ids:refs,...readScope})).map(r=>r.id).sort(),webRead.items.map((r:any)=>r.id).sort());
 const denied:any=await call('mote_read',{refs,deviceId:'b'});assert.equal(denied.items.length,0);assert.deepEqual(denied.missingRefs,refs);
 // A shared service never retains the previous request's filter.
 assert.equal((await call('mote_read',{refs}) as any).items.length,5);
 const id=webRead.items[0].id;store.delete(id);
 assert.equal((await call('mote_read',{refs:[`capture:${id}`]}) as any).items.length,0);
 assert.equal((await agentReader.evidence({ids:[id]})).length,0);
 assert.equal((await app.inject({method:'POST',url:'/api/context/read',headers,payload:{refs:[`capture:${id}`]}})).json().items.length,0);
});

test('context routes require owner access and immutable references never silently resolve the head',async t=>{
 const {app,sources,call}=await fixture(t);
 sources.register({id:'versions',name:'Generated versions',kind:'custom',deviceId:'generated',platform:'import'});
 const input={externalId:'item',revision:'1',observedAt:'2024-01-01T00:00:00.000Z',title:'Generated',text:'Original immutable version',kind:'message',layer:'original'};
 await sources.upsert('versions',input);const old=sources.getItem('versions','item')!.captureId;
 await sources.upsert('versions',{...input,revision:'2',text:'New version'});const current=sources.getItem('versions','item')!.captureId;
 assert.notEqual(old,current);
 assert.equal((await call('mote_read',{refs:[`capture:${old}`]}) as any).items[0].text,input.text);
 assert.equal((await call('mote_read',{refs:[`capture:${current}`]}) as any).items[0].text,'New version');
 assert.equal((await app.inject({url:'/api/context/search'})).statusCode,401);
 const invitation=(await app.inject({method:'POST',url:'/api/connections/invitations',headers,payload:{serverUrl:'https://synthetic.invalid',label:'fixture'}})).json();
 const credential=(await app.inject({method:'POST',url:'/api/connections/redeem',payload:{code:invitation.invitation.code,deviceId:'fixture',deviceName:'fixture',platform:'android'}})).json();
 const collector={authorization:`Bearer ${credential.token}`};
 for(const path of ['search','browse','bundle','retrieve'])assert.equal((await app.inject({url:'/api/context/'+path,headers:collector})).statusCode,403,path);
 assert.equal((await app.inject({method:'POST',url:'/api/context/read',headers:collector,payload:{refs:[old]}})).statusCode,403);
 for(const ref of ['session:'+old,'collection:'+old,'capture:memory:'+old,'../'+old])assert.equal(parseEvidenceRef(ref),undefined);
 assert.deepEqual(parseEvidenceRef('capture:'+old),{kind:'capture',id:old});
});
