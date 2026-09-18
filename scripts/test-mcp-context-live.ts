/** Opt-in live MCP + local Codex validation. Only generated records are used. */
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import Fastify from 'fastify';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {createAgent,type ContextRecord} from '../packages/agent/src/index.js';
import {Store} from '../apps/server/src/store.js';
import {SourceStore} from '../apps/server/src/sources.js';
import {registerMcp} from '../apps/server/src/connectors/mcp.js';
import type {ConnectorContext} from '../apps/server/src/connectors/types.js';

const model=process.env.MOTE_TEST_CODEX_MODEL??'gpt-6-astra';
const token=randomBytes(32).toString('hex');
const generatedText='MCP_CONTEXT_ANCHOR: the generated migration uses one SQLite transaction per batch; the rollback fixture passed and the old single-row path is rejected.';
const input=(id:string,at:string,deviceId:string,sessionId:string,projectKey:string,text:string)=>({id,deviceId,deviceName:'Generated MCP fixture',platform:'import' as const,capturedAt:at,durationMs:0,appId:'generated.agent',appName:'Generated Agent',windowTitle:'Generated MCP turn',ocrText:text,source:'message' as const,provenance:{sourceId:'generated-coding',externalId:id,revision:'1',layer:'snapshot' as const,document:{contentRole:'transcript' as const,coding:{version:1 as const,provider:'codex' as const,sessionId,projectKey,eventId:id,role:'user' as const,part:0,parts:1}}},privacy:{excluded:false,redacted:false,mode:'none' as const}});

const structured=(result:any)=>{assert.equal(result.isError,undefined,result.content?.[0]?.text);assert.ok(result.structuredContent,'MCP structuredContent is required for the new query contract');return result.structuredContent as any;};
const asRecord=(item:any):ContextRecord=>({id:item.id,capturedAt:item.origin.capturedAt,appName:item.origin.appName,deviceId:item.origin.deviceId,ocrText:item.snippet});

const directory=await mkdtemp(join(tmpdir(),'mote-mcp-context-live-'));const store=new Store(join(directory,'vault')),sources=new SourceStore(store);
sources.register({id:'generated-coding',name:'Generated coding fixture',kind:'coding-agent',deviceId:'generated-device',platform:'import'});
const first=randomUUID(),second=randomUUID();
await store.ingest(input(first,'2026-09-18T00:00:00.000Z','generated-device-a','session-a','github:utopiafar/mote',generatedText));
await store.ingest(input(second,'2026-09-18T00:01:00.000Z','generated-device-b','session-b','github:utopiafar/mote','MCP_CONTEXT_ANCHOR follow-up: another generated device confirms the same batch decision.'));
const ctx:ConnectorContext={store,sources,config:{dataDir:directory,token:'generated-owner',allowedOrigins:[],connectors:{directory:join(directory,'private'),mcpEnabled:true,mcpReadToken:token}}};
const app=Fastify();const connectors=registerMcp(app,ctx);let server:Client|undefined;let listening=false;let agent:ReturnType<typeof createAgent>|undefined;
try {
  await app.listen({host:'127.0.0.1',port:0});listening=true;const node=app.listeningOrigin;
  server=new Client({name:'generated-external-query-client',version:'1'});
  await server.connect(new StreamableHTTPClientTransport(new URL('/mcp',node),{requestInit:{headers:{Authorization:`Bearer ${token}`}}}));
  const list=await server.listTools();const names=list.tools.map(tool=>tool.name);for(const name of ['mote_browse','mote_search','mote_read','mote_context','mote_status'])assert.ok(names.includes(name),`missing ${name}`);
  const timings:Record<string,number>={};
  const measured=async(name:string,args:Record<string,unknown>)=>{const started=performance.now();const result=await server!.callTool({name,arguments:args});timings[name]=(timings[name]??0)+(performance.now()-started);return structured(result);};
  const browse=await measured('mote_browse',{query:'utopiafar/mote',limit:10});assert.equal(browse.items.length,1);assert.equal(browse.items[0].kind,'project-candidate');
  const found=await measured('mote_search',{query:'MCP_CONTEXT_ANCHOR',projectKey:'github:utopiafar/mote',limit:10});assert.equal(found.items.length,2);assert.ok(found.items.every((item:any)=>item.locator&&item.evidenceRefs.length===1));
  const read=await measured('mote_read',{refs:[found.items[0].ref],offset:found.items[0].locator.offset,length:120});assert.match(read.items[0].text,/MCP_CONTEXT_ANCHOR/);
  const context=await measured('mote_context',{query:'MCP_CONTEXT_ANCHOR',projectKey:'github:utopiafar/mote',includeMemories:false,maxCharacters:8000});assert.equal(context.recentRecords.length,2);
  const status=await measured('mote_status',{});assert.equal(status.archive.captures,2);
  const reader={
    search:async(args:any)=>{const page=await measured('mote_search',{...args,limit:args.limit??10});return page.items.map(asRecord);},
    timeline:async(args:any)=>{const page=await measured('mote_search',{...args,limit:args.limit??10});return page.items.map(asRecord);},
    evidence:async(args:any)=>{const page=await measured('mote_read',{refs:args.ids.map((id:string)=>`capture:${id}`),offset:args.offset??0,length:args.length??4000});return page.items.map((item:any)=>({id:item.id,capturedAt:item.origin?.capturedAt??new Date().toISOString(),appName:item.origin?.appName??'Generated Agent',deviceId:item.origin?.deviceId??'generated',ocrText:item.text}));},
    activity:async()=>({}),devices:async()=>[],
  };
  agent=createAgent({provider:'codex',protocol:'codex-app-server',model,reasoningEffort:'low',agentTimeoutMs:180000,reader});
  const started=performance.now();const answer=await agent.query({question:'This is generated fixture data. Use the available retrieval tools to search for MCP_CONTEXT_ANCHOR, then read the matching original evidence. What batch migration decision was confirmed? Cite the evidence ID and do not infer beyond the text.',language:'en'});const modelDurationMs=performance.now()-started;
  assert.match(answer.answer,/SQLite|transaction|batch/i);assert.ok(answer.citations.some(c=>new Set<string>([first,second]).has(c.id as string)));assert.ok(answer.trace.some(step=>step.tool==='search_context'));assert.ok(answer.trace.some(step=>step.tool==='evidence'));
  console.log(JSON.stringify({ok:true,model,externalClientTools:names.filter(name=>name.startsWith('mote_')).length,fixtureRecords:2,mcpTimingsMs:Object.fromEntries(Object.entries(timings).map(([name,value])=>[name,Math.round(value)])),modelDurationMs:Math.round(modelDurationMs),modelTools:answer.trace.map(step=>step.tool),citations:answer.citations.length,personalDataUsed:false}));
} finally {
  await agent?.close().catch(()=>{});await server?.close().catch(()=>{});await connectors.close();if(listening)await app.close();store.close();await rm(directory,{recursive:true,force:true});
}
