import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createInterface} from 'node:readline';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type {ActionConnectorChoice} from '@mote/shared';
import {LARK_SCOPES} from '../src/connectors/lark.js';
import type {LarkRunner} from '../src/connectors/lark-cli.js';
import {currentInstructionFixture,gate,until,type ModelRequest} from './fixtures/current-owner-instruction.js';
import {fixtureMemoryResult} from './fixtures/memory-result.js';

const connectionPath='/api/connections/mcp/calendar';
const calendarIds=['generated-write-a','generated-write-b','generated-read-only'];
const event={
  title:'Generated review',start:'2099-09-18T15:00:00Z',end:'2099-09-18T16:00:00Z',
  timeZone:'UTC',allDay:false,location:'',description:'',
};
const instruction='Create Generated review in Generated calendar A on 18 September 2099 from 15:00 to 16:00 UTC.';
const createRequest=(text=instruction)=>({requestId:randomUUID(),instruction:text,event});
const proposal=({envelope}:ModelRequest)=>({
  answer:'Use the original Action receipt for the outcome.',citationIds:[],
  draft:{goal:'Create the requested event',input:'current-action',action:{
    kind:'calendar.create',event:envelope.untrustedCalendarCandidate,targetId:envelope.ownerActionTargets[0].id,
  }},
});

async function fixture(t:TestContext,respond=proposal as (request:ModelRequest)=>unknown|Promise<unknown>){
  let write=false,dropReceipt=false;
  let writeGate:ReturnType<typeof gate>|undefined,rolesGate:ReturnType<typeof gate>|undefined;
  let roleChecks=0,logins=0,roleCheckFailures=0;
  const roles=['owner','writer','reader'];
  const calls:{calendarId:string;data:Record<string,unknown>}[]=[];
  const reviews:ModelRequest[]=[];
  const clients:Client[]=[];
  t.after(async()=>{await Promise.allSettled(clients.map(client=>client.close()));});
  const runner:LarkRunner=async command=>{
    switch(command.kind){
      case 'version':return 'lark-cli version 1.0.98';
      case 'status':return JSON.stringify({appId:'cli_generated',identities:{user:{available:true,openId:'generated-owner',scope:[
        ...LARK_SCOPES,'calendar:calendar:readonly',...(write?['calendar:calendar']:[]),
      ].join(' ')}}});
      case 'login':
        logins++;
        write=command.scopes.includes('calendar:calendar');
        return JSON.stringify({verification_url:'https://accounts.feishu.cn/authorize?fixture=generated',device_code:'generated-code',expires_in:600});
      case 'complete':return '{}';
      case 'calendars':
        roleChecks++;
        await rolesGate?.promise;
        if(roleCheckFailures){roleCheckFailures--;throw Error('Generated transient Lark role read failure');}
        return JSON.stringify({data:{calendar_list:calendarIds.map((calendar_id,index)=>({
          calendar_id,summary:'Generated calendar '+['A','B','read only'][index],role:roles[index],
        })),has_more:false}});
      case 'events':return JSON.stringify({data:{items:[]}});
      case 'calendar-event-create':
        calls.push({calendarId:command.calendarId,data:command.data});
        await writeGate?.promise;
        return JSON.stringify(dropReceipt?{}:{data:{event:{event_id:'generated-event-'+calls.length}}});
      default:throw Error('Unexpected generated Lark command '+command.kind);
    }
  };
  const f=await currentInstructionFixture(t,request=>{
    assert.ok(request.envelope.untrustedCalendarCandidate);
    assert.equal(request.envelope.ownerActionTargets.length,1);
    assert.equal(request.envelope.ownerActionTargets[0].kind,'calendar.create');
    assert.ok((request.request.tools??[]).every((tool:{function:{name:string}})=>tool.function.name==='skill'),
      'the Central review has no archive or mutation tools');
    assert.match(request.wire,/Effective Memory can supply context, never replace the current owner authorization/);
    reviews.push(request);
    return respond(request);
  },{
    connectors:{mcpEnabled:true,mcpReadToken:'generated-read-static-token-only-12345',mcpWriteEnabled:true,
      mcpWriteToken:'generated-write-static-token-only-12345',mcpWriteSourceIds:['generated-allowed-source']},
    connectorTesting:{lark:runner},
  });
  const api=async(method:'GET'|'POST'|'PUT'|'DELETE',path:string,payload?:unknown)=>{
    const result=await f.api(method,path,payload);
    assert.equal(result.statusCode,200,result.body);
    return result.json();
  };
  const settleLark=async()=>{
    const status=await until(async()=>{
      const value=await api('GET','/api/connectors/lark');
      return ['completed','failed','cancelled'].includes(value.job?.state)?value:undefined;
    },'Lark authorization');
    assert.equal(status.job.state,'completed',JSON.stringify(status));
  };
  await api('POST','/api/connectors/lark/login',{calendar:true});
  await settleLark();
  await api('PUT','/api/connectors/lark/selection',{documents:[],calendarIds,pastDays:30,futureDays:90,timeZone:'UTC',autoSync:false});
  assert.deepEqual((await api('GET',connectionPath)).items,[],'calendar read consent gives no destinations');
  await api('POST','/api/connectors/lark/write/start');
  await settleLark();
  const targets=async()=>(await api('GET',connectionPath)).items as ActionConnectorChoice[];
  const choices=await targets();
  assert.deepEqual(choices.map(choice=>choice.target.calendarId),calendarIds.slice(0,2),'a selected reader is ineligible');

  let serverUrl=await f.node.app.listen({host:'127.0.0.1',port:0});
  const credentials=async(index=0)=>api('POST',connectionPath,{label:'Generated Codex',serverUrl,target:choices[index].target});
  const connect=async(header:string)=>{
    const client=new Client({name:'generated-detached-client',version:'1'});
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(serverUrl+'/mcp'),{requestInit:{headers:{Authorization:header}}}));
    return client;
  };
  const data=async(client:Client,name:string,args:Record<string,unknown>={})=>{
    const result=await client.callTool({name,arguments:args});
    assert.equal(result.isError,undefined,JSON.stringify(result));
    return result.structuredContent as Record<string,string>;
  };
  const receipt=(client:Client,requestId:string)=>data(client,'mote_calendar_receipt',{requestId});
  const finish=(client:Client,requestId:string)=>until(async()=>{
    const value=await receipt(client,requestId);
    return ['approved','executing'].includes(value.status)?undefined:value;
  },'durable external Action receipt');
  const status=async(id:string)=>api('GET','/api/actions/'+id);
  const rows=()=>f.node.actions.list().filter(action=>action.externalCalendar);
  const standing=async(text:string)=>{
    const id=await f.note(text),record=f.node.store.evidence([id])[0];
    const raw={answer:JSON.stringify({memories:[{
      title:'Generated standing calendar constraint',statement:text+' ['+id+']',uncertainty:'',
      contextPriority:'standing',admission:{layer:'memory',scope:'Generated review events',reason:'Generated owner declaration',attribution:'user'},evidenceIds:[id],
    }]}),citations:[{id,capturedAt:record.capturedAt,appName:'Generated',excerpt:text}],trace:[],runId:randomUUID()};
    const draft=f.node.memories.extract(fixtureMemoryResult(f.node.memories,raw),'generated').items[0]!;
    return f.node.memories.publish(draft.id,draft.version);
  };
  return {get node(){return f.node;},get serverUrl(){return serverUrl;},get roleChecks(){return roleChecks;},get logins(){return logins;},
    directory:f.directory,owner:f.headers,api,raw:f.api,choices,targets,settleLark,
    calls,reviews,credentials,connect,data,receipt,finish,status,rows,standing,
    dropReceipt(){dropReceipt=true;},
    holdWrite(){writeGate=gate();return writeGate;},
    async restart(beforeOpen?:()=>Promise<void>){await f.restart(beforeOpen);serverUrl=await f.node.app.listen({host:'127.0.0.1',port:0});},
    setReadOnly(index:number){roles[index]='reader';},
    holdRoleCheck(){rolesGate=gate();return rolesGate;},
    failNextRoleCheck(){roleCheckFailures++;},
  };
}

const header=(connection:{config:{mcpServers:{mote:{headers:{Authorization:string}}}}})=>connection.config.mcpServers.mote.headers.Authorization;
async function toolError(client:Client,name:string,args:Record<string,unknown>,code:RegExp){
  const result=await client.callTool({name,arguments:args});
  assert.equal(result.isError,true,JSON.stringify(result));
  assert.match(JSON.stringify(result.content),code);
}

test('external MCP grants one exact writable calendar and persists one Action for concurrent replay',async t=>{
  const held=gate();
  t.after(()=>held.release());
  const f=await fixture(t,async request=>{await held.promise;return proposal(request);});
  const ineligible=await f.raw('POST',connectionPath,{label:'Generated wrong target',serverUrl:f.serverUrl,
    target:{...f.choices[0].target,calendarId:calendarIds[2]}});
  assert.equal(ineligible.statusCode,409,ineligible.body);
  const connection=await f.credentials(),client=await f.connect(header(connection));
  assert.equal(connection.credential.scope,'mcp-calendar');
  assert.notEqual(header(connection),f.owner.authorization);
  assert.deepEqual((await client.listTools()).tools.map(tool=>tool.name).sort(),['mote_calendar_create','mote_calendar_receipt','mote_calendar_target']);
  assert.deepEqual(await f.data(client,'mote_calendar_target'),{calendarName:connection.credential.calendarName,available:true});
  const inventory=await f.api('GET','/api/connections');
  assert.ok(!JSON.stringify(inventory).includes(header(connection)));
  assert.ok(!JSON.stringify(inventory).includes('releaseDigest'));
  for(const [method,url] of [['GET',connectionPath],['POST',connectionPath],['GET','/api/actions']] as const){
    const denied=await f.node.app.inject({method,url,headers:{authorization:header(connection)}});
    assert.equal(denied.statusCode,403,denied.body);
  }
  for(const access of ['read','write'] as const){
    const issued=await f.api('POST','/api/connections/mcp',{label:'Generated '+access,access,serverUrl:f.serverUrl});
    const restricted=await f.connect(header(issued));
    assert.ok(!(await restricted.listTools()).tools.some(tool=>tool.name.startsWith('mote_calendar_')));
  }
  const request=createRequest();
  await toolError(client,'mote_calendar_create',{...request,target:'foreign'},/Unrecognized key/);
  await toolError(client,'mote_calendar_create',{...request,event:{...event,attendees:['generated']}},/Unrecognized key/);
  const first=f.data(client,'mote_calendar_create',request);
  void first.catch(()=>{});
  await until(()=>f.reviews.length===1?true:undefined,'current instruction review');
  assert.equal(f.reviews[0].envelope.request,request.instruction);
  assert.equal(f.rows().length,0);
  assert.equal(f.calls.length,0);
  const replay=f.data(client,'mote_calendar_create',request);
  void replay.catch(()=>{});
  await toolError(client,'mote_calendar_create',{...request,event:{...event,title:'Substituted'}},/calendar_request_conflict/);
  held.release();
  const [accepted,duplicate]=await Promise.all([first,replay]);
  assert.equal(accepted.actionId,duplicate.actionId);
  const settled=await f.finish(client,request.requestId);
  assert.equal(settled.status,'succeeded');
  assert.equal(settled.externalId,'generated-event-1');
  assert.deepEqual(await f.data(client,'mote_calendar_create',request),settled);
  const action=await f.status(settled.actionId);
  assert.equal(action.operationId,settled.operationId);
  assert.equal(action.status,'succeeded');
  assert.deepEqual(action.target,f.choices[0].target);
  assert.deepEqual(action.event,event);
  assert.match(String(f.calls[0].data.description),new RegExp(settled.operationId));
  assert.deepEqual(f.calls.map(call=>call.calendarId),[calendarIds[0]]);
  assert.equal(f.reviews.length,1);
  const other=await f.connect(header(await f.credentials(1)));
  await toolError(other,'mote_calendar_receipt',{requestId:request.requestId},/calendar_receipt_not_found/);
});

test('external current instruction and effective Memory gate the exact calendar payload',async t=>{
  const held=gate();
  t.after(()=>held.release());
  const f=await fixture(t,async request=>{
    const {envelope}=request;
    if(envelope.request.startsWith('Summarize'))return {answer:'Generated summary.',citationIds:[],draft:null};
    if(envelope.request.endsWith('memory change.')){await held.promise;return proposal(request);}
    if(envelope.untrustedMemoryLeads?.some((memory:{statement:string})=>memory.statement.includes('GENERATED_NO_WRITES'))){
      return {answer:'GENERATED_NO_WRITES',citationIds:[],draft:null};
    }
    const draft=proposal(request);
    draft.draft.action.event={...event,title:'Substituted candidate'};
    return draft;
  });
  const client=await f.connect(header(await f.credentials()));
  await toolError(client,'mote_calendar_create',createRequest('Summarize this quote: "'+instruction+'"'),/calendar_instruction_not_authorized/);
  await toolError(client,'mote_calendar_create',createRequest(),/calendar_instruction_not_authorized/);
  const card=await f.standing('GENERATED_NO_WRITES: do not create generated review events.');
  await toolError(client,'mote_calendar_create',createRequest(),/^((?!GENERATED_NO_WRITES).)*calendar_instruction_not_authorized/s);
  assert.ok(f.reviews.at(-1)!.envelope.untrustedMemoryLeads.some((lead:{id:string})=>lead.id===card.id));
  const pending=f.data(client,'mote_calendar_create',createRequest(instruction+' This fixture will hold for a memory change.'));
  const invalidated=assert.rejects(pending,/source_operation_failed/);
  await until(()=>f.reviews.length===4?true:undefined,'review with pinned Memory');
  try{
    assert.ok(f.reviews.at(-1)!.envelope.untrustedMemoryLeads.some((lead:{id:string})=>lead.id===card.id));
    await f.api('DELETE','/api/memories/'+card.id);
  }finally{held.release();}
  await invalidated;
  assert.equal(f.rows().length,0);
  assert.equal(f.calls.length,0);
});

test('connection withdrawal blocks a late review and role loss blocks the selected destination',async t=>{
  const held=gate();
  t.after(()=>held.release());
  const f=await fixture(t,async request=>{await held.promise;return proposal(request);});
  const revoked=await f.credentials(),client=await f.connect(header(revoked));
  const pending=toolError(client,'mote_calendar_create',createRequest(),/connection_revoked|source_operation_failed/);
  void pending.catch(()=>{});
  await until(()=>f.reviews.length===1?true:undefined,'review before connection revocation');
  await f.api('DELETE','/api/connections/'+revoked.credential.id);
  held.release();
  await pending;
  await assert.rejects(()=>client.listTools(),/mcp_unauthorized/);
  assert.equal(f.rows().length,0);
  assert.equal(f.calls.length,0);
  const remaining=await f.credentials(),stillConnected=await f.connect(header(remaining));
  f.setReadOnly(0);
  await f.api('GET','/api/connectors/lark/calendars');
  assert.deepEqual(await f.data(stillConnected,'mote_calendar_target'),{calendarName:remaining.credential.calendarName,available:false});
  await toolError(stillConnected,'mote_calendar_create',createRequest(),/calendar_target_unavailable/);
  assert.equal(f.reviews.length,1);
  assert.equal(f.calls.length,0);
});

test('revoking a connection after connector dispatch retains the actual late receipt',async t=>{
  const f=await fixture(t),connection=await f.credentials(),client=await f.connect(header(connection));
  const held=f.holdWrite();
  try{
    const input=createRequest(),accepted=await f.data(client,'mote_calendar_create',input);
    await until(()=>f.calls.length===1?true:undefined,'issued calendar effect');
    assert.equal((await f.status(accepted.actionId)).status,'executing');
    await f.api('DELETE','/api/connections/'+connection.credential.id);
    await assert.rejects(()=>f.receipt(client,input.requestId),/mcp_unauthorized/);
    held.release();
    const receipt=await until(async()=>{
      const action=await f.status(accepted.actionId);
      return action.status==='succeeded'?action:undefined;
    },'late provider receipt');
    assert.equal(receipt.externalId,'generated-event-1');
    assert.equal(f.calls.length,1);
  }finally{held.release();}
});

test('missing provider receipt and restart never resubmit a claimed calendar create',async t=>{
  const f=await fixture(t),connection=await f.credentials(),client=await f.connect(header(connection)),request=createRequest();
  f.dropReceipt();
  await f.data(client,'mote_calendar_create',request);
  const original=await f.finish(client,request.requestId);
  assert.equal(original.status,'uncertain');
  assert.equal(original.externalId,undefined);
  assert.equal(f.calls.length,1);
  await client.close();
  await f.restart();
  const reconnected=await f.connect(header(connection));
  assert.deepEqual(await f.receipt(reconnected,request.requestId),original);
  assert.deepEqual(await f.data(reconnected,'mote_calendar_create',request),original);
  await f.node.actionsServices.poll();
  assert.equal(f.calls.length,1);
  assert.equal(f.reviews.length,1);
});

test('ordinary restart and sync restore actual Lark write roles for an existing authorized selection',async t=>{
  const f=await fixture(t),path=join(f.directory,'connectors','lark.json'),logins=f.logins;
  const saved=async()=>JSON.parse(await readFile(path,'utf8'));
  const legacy=async()=>{
    const config=await saved();
    assert.equal(config.calendarWriteAuthorized,true);
    assert.deepEqual(config.selection.calendarIds,calendarIds);
    delete config.writableCalendars;
    await writeFile(path,JSON.stringify(config),{mode:0o600});
  };
  f.setReadOnly(1);
  const held=f.holdRoleCheck(),priorChecks=f.roleChecks;
  try{
    await f.restart(legacy);
    await until(()=>f.roleChecks>priorChecks?true:undefined,'startup fetches roles from Lark');
    assert.deepEqual(await f.targets(),[],'unknown roles cannot grant a write while recovery is pending');
    held.release();
    await until(async()=>{const choices=await f.targets();return choices.length?[...choices]:undefined;},'startup restores only actual write roles');
  }finally{held.release();}
  assert.deepEqual((await f.targets()).map(choice=>choice.target.calendarId),[calendarIds[0]]);
  assert.deepEqual((await saved()).selection.calendarIds,calendarIds,'role recovery preserves every selected read source');

  f.failNextRoleCheck();
  await f.restart(legacy);
  await until(async()=>{const status=await f.api('GET','/api/connectors/lark');return status.error==='lark_operation_failed'?status:undefined;},
    'startup records that provider roles could not be read');
  assert.deepEqual(await f.targets(),[]);
  await f.api('POST','/api/connectors/lark/sync',{});
  await f.settleLark();
  assert.deepEqual((await f.targets()).map(choice=>choice.target.calendarId),[calendarIds[0]]);
  assert.deepEqual((await saved()).selection.calendarIds,calendarIds);
  assert.equal(f.logins,logins,'neither recovery path requests OAuth again');
  assert.equal(f.calls.length,0);
});

const codexBinary=process.env.MOTE_CALENDAR_TEST_CODEX;
test('installed Codex discovers and calls the calendar MCP tools using the generated TOML format',{skip:!codexBinary},async t=>{
  const f=await fixture(t),connection=await f.credentials();
  const {url,headers}=connection.config.mcpServers.mote;
  const codexDirectory=join(f.directory,'isolated-codex');
  await mkdir(codexDirectory,{mode:0o700});
  await writeFile(join(codexDirectory,'config.toml'),[
    'model_provider = "generated"',
    'model = "generated-unused"',
    'web_search = "disabled"',
    '[model_providers.generated]',
    'name = "Generated local model"',
    'base_url = '+JSON.stringify(f.serverUrl+'/unused'),
    '[mcp_servers.mote_calendar]',
    'url = '+JSON.stringify(url),
    'http_headers = { Authorization = '+JSON.stringify(headers.Authorization)+' }',
    'tool_timeout_sec = 120',
  ].join('\n'),{mode:0o600});
  const child=spawn(codexBinary!,['app-server','--strict-config'],{
    cwd:codexDirectory,
    env:{PATH:process.env.PATH,TMPDIR:process.env.TMPDIR,CODEX_HOME:codexDirectory},
    stdio:['pipe','pipe','pipe'],
  });
  const exited=once(child,'close');
  let stderr='';
  child.stderr.on('data',data=>{stderr=(stderr+data).slice(-4000);});
  const replies=new Map<number,{result?:any;error?:unknown}>();
  const lines=createInterface({input:child.stdout});
  lines.on('line',line=>{
    const reply=JSON.parse(line);
    if(typeof reply.id==='number')replies.set(reply.id,reply);
  });
  let sequence=0;
  const rpc=async(method:string,params:Record<string,unknown>)=>{
    const id=++sequence;
    child.stdin.write(JSON.stringify({id,method,params})+'\n');
    const reply=await until(()=>replies.get(id),method+' '+stderr);
    assert.equal(reply.error,undefined,JSON.stringify(reply.error));
    return reply.result;
  };
  try{
    await rpc('initialize',{clientInfo:{name:'mote-calendar-test',version:'1.0.0'},capabilities:{experimentalApi:true}});
    child.stdin.write(JSON.stringify({method:'initialized'})+'\n');
    const server='mote_calendar',listing=await rpc('mcpServerStatus/list',{serverName:server,detail:'toolsAndAuthOnly'});
    const tools=listing.data.find((entry:{name:string})=>entry.name===server).tools;
    assert.deepEqual(Object.keys(tools).sort(),['mote_calendar_create','mote_calendar_receipt','mote_calendar_target']);
    const started=await rpc('thread/start',{cwd:codexDirectory,ephemeral:true});
    const call=async(tool:string,args:Record<string,unknown>)=>{
      const result=await rpc('mcpServer/tool/call',{threadId:started.thread.id,server,tool,arguments:args});
      assert.notEqual(result.isError,true,JSON.stringify(result));
      return result.structuredContent;
    };
    const input=createRequest();
    const accepted=await call('mote_calendar_create',input);
    const receipt=await until(async()=>{
      const result=await call('mote_calendar_receipt',{requestId:input.requestId});
      return result.status==='succeeded'?result:undefined;
    },'Codex sees the provider receipt');
    assert.equal(receipt.operationId,accepted.operationId);
    assert.equal(receipt.externalId,'generated-event-1');
    assert.equal(f.reviews.length,1);
    assert.equal(f.calls.length,1);
  }finally{
    child.stdin.end();
    child.kill();
    await exited;
    lines.close();
  }
});
