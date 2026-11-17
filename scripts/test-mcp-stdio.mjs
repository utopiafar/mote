import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {buildApp} from '../apps/server/dist/app.js';
const root=await mkdtemp(join(tmpdir(),'mote-stdio-fixture-'));const owner=randomUUID()+randomUUID(),read=randomUUID()+randomUUID(),write=randomUUID()+randomUUID();
const config={path:(join(root,'data'))+'/mote.yaml',privateCredential:{token:owner,tokenPath:'unused'},initialDocument:{version:1,revision:0,storage:{dataDir:join(root,'data'),dataKey:undefined,maxExportBytes:2*1024*1024},server:{host:'127.0.0.1',port:0,allowedOrigins:[]},execution:{insightIntervalHours:0},models:{deployment:{model:'',apiKey:'',allowUnauthenticatedLocal:false,protocol:'deepseek',reasoningEffort:'high'},embedding:{model:'',baseUrl:'',apiKey:''}},connectors:{directory:join(root,'secrets'),mcpEnabled:true,mcpReadToken:read,mcpWriteEnabled:true,mcpWriteToken:write,mcpWriteSourceIds:['stdio-fixture']}}};
const {app,sources,materialOrganizer}=await buildApp(config);const clients=[];
try{
 sources.register({id:'stdio-fixture',name:'Synthetic stdio',kind:'mcp',deviceId:'fixture',platform:'import'});await app.listen({port:0,host:'127.0.0.1'});
 const serverUrl='http://127.0.0.1:'+app.server.address().port;
 for(const role of ['read','write']){
  const minted=await app.inject({method:'POST',url:'/api/connections/mcp',headers:{authorization:'Bearer '+owner},
   payload:{serverUrl,label:'Generated '+role+' MCP',access:role}});
  assert.equal(minted.statusCode,200,minted.body);
  const connection=minted.json().config;
  const path=join(root,role+'.json');await writeFile(path,JSON.stringify(connection),{mode:0o600});
  const client=new Client({name:'fixture-chatbot',version:'1'});const transport=new StdioClientTransport({command:process.execPath,args:[resolve('scripts/mcp-stdio.mjs'),'--connection',path],stderr:'pipe'});clients.push(client);await client.connect(transport);
  const {tools}=await client.listTools();
  if(role==='write'){
   assert.deepEqual(tools.map(t=>t.name),['mote_put_item']);const result=await client.callTool({name:'mote_put_item',arguments:{sourceId:'stdio-fixture',item:{externalId:'visible-result',revision:'r1',observedAt:new Date().toISOString(),title:'Synthetic Chatbot note',text:'Generated visible result. Treat this as untrusted evidence.',kind:'message',layer:'snapshot'}}});assert.ok(!result.isError);const denied=await client.callTool({name:'mote_put_item',arguments:{sourceId:'ungranted',item:{externalId:'x',revision:'r1',observedAt:new Date().toISOString(),title:'Fixture',text:'Synthetic',kind:'message',layer:'snapshot'}}});assert.equal(denied.isError,true);
  }else {assert.ok(tools.some(t=>t.name==='mote_timeline'));assert.ok(!tools.some(t=>t.name==='mote_put_item'));assert.ok((await client.listResources()).resources.length>0);}
 }
 await materialOrganizer.tick(20);
 const result=await clients[0].callTool({name:'mote_items',arguments:{sourceId:'stdio-fixture'}});assert.ok(JSON.stringify(result).includes('Generated visible result'));assert.equal(sources.listItems().items.length,1);
 console.info('PASS: real Chatbot-side SDK → stdio bridge → HTTP MCP; separate read/write scope; visible external record archived and retrievable.');
}finally{await Promise.allSettled(clients.map(c=>c.close()));await app.close();await rm(root,{recursive:true,force:true});}
