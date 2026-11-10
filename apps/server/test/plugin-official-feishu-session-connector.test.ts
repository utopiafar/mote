import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';
import {Store} from '../src/store.js';
import {ExecutionEngine} from '../src/execution-engine.js';
import {PluginCenter} from '../src/plugin-center.js';
import {GitHubPluginReleases,type PluginReleaseTransport} from '../src/plugin-release.js';
import {OFFICIAL_PLUGIN_CATALOG,officialPluginCatalog} from '../src/official-plugin-catalog.js';
import type {ConnectorManifest} from '../src/connectors/registry.js';
import {LARK_VERSION,larkArguments,type LarkCommand,type LarkRunner} from '../src/connectors/lark-cli.js';
import {createLarkBinding,LARK_IM_READ_SCOPES,LARK_IM_SEND_SCOPES,larkImRequestKind,larkSendScopesOk,type LarkBinding} from '../src/connectors/lark-binding.js';
import {LARK_SCOPES} from '../src/connectors/lark.js';

const repoRoot=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const packageRoot=join(repoRoot,'official-plugins/feishu-session');
const feishu={repository:'mote/official-feishu-session-connector',tag:'v0.1.0',packageId:'mote.official.feishu-session',localDirectory:'official-plugins/feishu-session',kind:'mote.official.feishu-session'};
const owner='generated-feishu-session-owner-'+randomUUID();
const headers={authorization:'Bearer '+owner};
const documentUrl='https://fixture.feishu.cn/docx/DocumentFixture123';
const nowMs=Date.now();
const groupMessageOne={message_id:'om_generated_group_1',msg_type:'text',create_time:String(nowMs-2*3600*1000),chat_id:'oc_generated_group',sender:{id:'ou_alice',id_type:'open_id',sender_type:'user'},body:{content:JSON.stringify({text:'Generated group hello'})}};
const groupMessageTwo={message_id:'om_generated_group_2',msg_type:'text',create_time:String(nowMs-3600*1000),chat_id:'oc_generated_group',sender:{id:'ou_bob',id_type:'open_id',sender_type:'user'},body:{content:JSON.stringify({text:'Generated group follow-up'})}};
const p2pMessage={message_id:'om_generated_p2p_1',msg_type:'text',create_time:String(nowMs-1800*1000),chat_id:'oc_generated_p2p',sender:{id:'ou_carol',id_type:'open_id',sender_type:'user'},body:{content:JSON.stringify({text:'Generated private message that must stay unread'})}};

function waitFor(check:()=>boolean,description:string){
  const until=Date.now()+12000;
  return (async()=>{while(Date.now()<until){if(check())return;await new Promise(resolve=>setTimeout(resolve,25));}throw new Error('Timed out waiting for '+description);})();
}
function rejectingGitHub(calls:string[]):PluginReleaseTransport{
  return async url=>{calls.push(url);throw new Error('GitHub transport must not be used for the in-repo official Feishu session package: '+url);};
}

type FakeMessage={message_id:string;msg_type:string;create_time:string;update_time?:string;deleted?:boolean;updated?:boolean;chat_id:string;sender:{id:string;id_type:string;sender_type:string};body:{content:string}};
type FakeLark={
  calls:LarkCommand[];
  runner:LarkRunner;
  binding:LarkBinding;
  state:{
    connected:boolean;
    scopes:string[];
    pending?:{deviceCode:string;scopes:string[]};
    logins:string[][];
    chats:{chat_id:string;name:string;chat_mode:string}[];
    messages:Record<string,FakeMessage[]>;
    sent:{chatId:string;text:string}[];
    failSend:boolean;
  };
  addMessage:(chatId:string,message:FakeMessage)=>void;
  editMessage:(messageId:string,text:string)=>void;
  sentCalls:()=>LarkCommand[];
  loginCalls:()=>string[][];
};
function fakeLark():FakeLark{
  const calls:LarkCommand[]=[];
  const state:FakeLark['state']={
    connected:false,scopes:[],logins:[],
    chats:[
      {chat_id:'oc_generated_group',name:'Generated group',chat_mode:'group'},
      {chat_id:'oc_generated_p2p',name:'Generated person',chat_mode:'p2p'},
    ],
    messages:{
      oc_generated_group:[{...groupMessageOne},{...groupMessageTwo}],
      oc_generated_p2p:[{...p2pMessage}],
    },
    sent:[],failSend:false,
  };
  const json=(value:unknown)=>JSON.stringify(value);
  const runner:LarkRunner=async(command,options={})=>{
    calls.push(command);
    if(options.signal?.aborted)throw Object.assign(new Error('cancelled'),{name:'ConnectorError',code:'lark_operation_cancelled',statusCode:409});
    switch(command.kind){
      case 'version':return 'lark-cli version '+LARK_VERSION;
      case 'status':return json({appId:'cli_generated',identities:{user:{available:state.connected,openId:'ou_generated_owner',userName:'Generated Feishu Owner',scope:state.scopes.join(' ')}}});
      case 'login':state.pending={deviceCode:'private-generated-device-code',scopes:[...command.scopes]};state.logins.push([...command.scopes]);return json({verification_url:'https://accounts.feishu.cn/authorize?generated=feishu-session',device_code:'private-generated-device-code',expires_in:600});
      case 'complete':
        if(!state.pending)throw Object.assign(new Error('authorization'),{name:'ConnectorError',code:'lark_authorization_state_invalid',statusCode:400});
        state.scopes=state.pending.scopes;state.connected=true;state.pending=undefined;return json({ok:true});
      case 'document':return json({ok:true,data:{document:{document_id:'doc-fixture-1',revision_id:1,content:'Generated Feishu document body'}}});
      case 'documents-search':return json({ok:true,data:{results:[],has_more:false}});
      case 'calendars':return json({data:{calendar_list:[{calendar_id:'cal-1',summary:'Generated calendar',role:'owner',type:'primary'}],has_more:false}});
      case 'events':return json({data:{items:[{event_id:'event-1',summary:'Generated event',start_time:{timestamp:String(Math.floor(nowMs/1000))},end_time:{timestamp:String(Math.floor(nowMs/1000)+3600)}}]}});
      case 'im-chats':return json({ok:true,data:{items:state.chats.map(chat=>({...chat})),has_more:false,page_token:''}});
      case 'im-messages':{
        if(options.signal?.aborted)throw Object.assign(new Error('cancelled'),{name:'ConnectorError',code:'lark_operation_cancelled',statusCode:409});
        const start=Number(command.startTime??0),items=(state.messages[command.chatId]??[]).filter(message=>Number(message.create_time)/1000>=start);
        return json({ok:true,data:{items,has_more:false,page_token:''}});
      }
      case 'im-send':{
        if(state.failSend)throw Object.assign(new Error('generated send failure'),{name:'ConnectorError',code:'lark_command_failed',statusCode:502});
        const messageId='om_generated_sent_'+(state.sent.length+1);
        state.sent.push({chatId:command.chatId,text:command.text});
        return json({ok:true,data:{message_id:messageId,create_time:String(Date.now()+state.sent.length),chat_id:command.chatId,sender:{id:'ou_generated_owner',id_type:'open_id',sender_type:'user'},body:{content:JSON.stringify({text:command.text})}}});
      }
      default:return json({ok:true,data:{}});
    }
  };
  return {
    calls,runner,state,binding:createLarkBinding({runner}),
    addMessage:(chatId,message)=>{state.messages={...state.messages,[chatId]:[...(state.messages[chatId]??[]),{...message}]};},
    editMessage:(messageId,value)=>{for(const [chatId,items] of Object.entries(state.messages))state.messages[chatId]=items.map(message=>message.message_id===messageId?{...message,body:{content:JSON.stringify({text:value})},update_time:String(Date.now()),updated:true}:message);},
    sentCalls:()=>calls.filter(call=>call.kind==='im-send'),
    loginCalls:()=>state.logins,
  };
}

test('official Feishu session manifest, IM command guard and binding allowlist',async()=>{
  const catalog=officialPluginCatalog();
  const entry=catalog.find(value=>value.packageId===feishu.packageId);
  assert.ok(entry);
  assert.equal(entry.repository,feishu.repository);
  assert.equal(entry.tag,feishu.tag);
  assert.equal(entry.group,'connectors');
  assert.equal(entry.runtime,'service');
  assert.equal('localDirectory' in entry,false);
  const internal=OFFICIAL_PLUGIN_CATALOG.find(value=>value.packageId===feishu.packageId);
  assert.equal(internal?.localDirectory,feishu.localDirectory);

  const manifest=JSON.parse(readFileSync(join(packageRoot,'mote-plugin.json'),'utf8')) as Record<string,unknown>;
  assert.equal(manifest.id,feishu.packageId);
  assert.equal(manifest.runtime,'service');
  assert.equal(manifest.trust,'official');
  assert.deepEqual(manifest.capabilities,['source.connector','message.send']);
  assert.deepEqual(manifest.configuration,[]);
  const actions=manifest.actionCapabilities as {id:string;version:number;executionLocation:string;risk:string;constraints:Record<string,boolean>}[];
  assert.deepEqual(actions.map(value=>[value.id,value.version,value.executionLocation,value.risk]),[['message.send',1,'central-connector','message-send']]);
  assert.deepEqual(actions[0]?.constraints,{confirmsEveryMessage:true,currentEvidence:true});
  assert.equal(JSON.stringify(manifest).includes('calendar.manage'),false,'Feishu session declares no calendar write');
  const sourceCatalog=manifest.sourceCatalog as {title:string;kinds:string[];target:{href:string};note:string;attachToBinding?:string}[];
  assert.equal(sourceCatalog[0]?.title,'飞书会话');
  assert.equal(sourceCatalog[0]?.attachToBinding,'lark');
  assert.deepEqual(sourceCatalog[0]?.kinds,[feishu.kind]);
  assert.equal(sourceCatalog[0]?.target.href,'#/connections?setup=official-feishu-session');
  assert.match(sourceCatalog[0]?.note??'',/复用已有飞书账号/);
  assert.match(sourceCatalog[0]?.note??'',/发送走行动平台/);
  assert.match(sourceCatalog[0]?.note??'',/问一问不能发送/);

  const module=await import(pathToFileURL(join(packageRoot,'plugin.mjs')).href) as {connector:ConnectorManifest&{create:unknown;sourceKinds:{kind:string;capabilities:{externalWrite:boolean}}[]}};
  assert.equal(module.connector.id,'official-feishu-session');
  assert.equal(module.connector.sourceKinds.length,1);
  assert.equal(module.connector.sourceKinds[0]?.kind,feishu.kind);
  assert.equal(module.connector.sourceKinds[0]?.capabilities.externalWrite,false);
  assert.equal(typeof module.connector.create,'function');

  assert.deepEqual(larkArguments({kind:'im-chats'}).slice(0,7),['api','GET','/open-apis/im/v1/chats','--params','{"user_id_type":"open_id","sort_type":"ByActiveTimeDesc","page_size":100,"types":"group,p2p"}','--as','user']);
  const messageArgs=larkArguments({kind:'im-messages',chatId:'oc_generated_group',startTime:'1780000000',endTime:'1780086400',pageSize:50});
  assert.deepEqual(messageArgs.slice(0,3),['api','GET','/open-apis/im/v1/messages']);
  assert.match(messageArgs[4]??'',/"container_id":"oc_generated_group"/);
  assert.equal(messageArgs.includes('user'),true);
  const sendArgs=larkArguments({kind:'im-send',chatId:'oc_generated_group',text:'Generated reply',uuid:'generated-operation'});
  assert.deepEqual(sendArgs.slice(0,3),['api','POST','/open-apis/im/v1/messages']);
  const body=JSON.parse(sendArgs[sendArgs.indexOf('--data')+1]??'{}');
  assert.equal(body.receive_id,'oc_generated_group');
  assert.equal(body.msg_type,'text');
  assert.equal(JSON.parse(body.content).text,'Generated reply');
  assert.equal(body.uuid,'generated-operation');
  assert.throws(()=>larkArguments({kind:'im-messages',chatId:'oc_generated_group; touch /tmp/x'}),/lark_command_invalid/);
  assert.throws(()=>larkArguments({kind:'im-send',chatId:'--help',text:'x'}),/lark_command_invalid/);

  for(const [method,path] of [['GET','/open-apis/im/v1/chats'],['GET','/open-apis/im/v1/messages']] as const)assert.equal(larkImRequestKind(method,path),'read');
  assert.equal(larkImRequestKind('POST','/open-apis/im/v1/messages'),'send');
  for(const [method,path] of [
    ['GET','/open-apis/docx/v1/documents/doc-1'],['GET','/open-apis/calendar/v4/calendars'],
    ['GET','/open-apis/minutes/v1/minutes/minute-1/artifacts'],['POST','/open-apis/im/v1/chats'],
    ['DELETE','/open-apis/im/v1/messages/om_1'],['POST','/open-apis/im/v1/messages/om_1'],
    ['GET','/open-apis/im/v1/chats/oc_1'],['POST','/open-apis/contact/v3/users'],
  ] as const)assert.equal(larkImRequestKind(method,path),undefined,'the binding refuses '+method+' '+path);

  const fake=fakeLark();
  const preview=await fake.binding.request({method:'GET',path:'/open-apis/im/v1/chats',query:{page_size:100}});
  assert.deepEqual((preview as {items:{chat_id:string}[]}).items.map(item=>item.chat_id),['oc_generated_group','oc_generated_p2p']);
  const beforeBlocked=fake.calls.length;
  for(const [method,path] of [
    ['GET','/open-apis/docx/v1/documents/doc-1'],['GET','/open-apis/calendar/v4/calendars'],
    ['GET','/open-apis/minutes/v1/minutes/minute-1/artifacts'],['POST','/open-apis/im/v1/messages'],
    ['DELETE','/open-apis/im/v1/messages/om_1'],['GET','/open-apis/im/v1/chats/oc_1'],
  ] as const)await assert.rejects(fake.binding.request({method,path}),/lark_im_path_blocked/);
  await assert.rejects(fake.binding.request({method:'GET',path:'/open-apis/im/v1/messages',query:{container_id_type:'chat',container_id:'oc_generated_group',unexpected:'x'}}),/lark_im_path_blocked/);
  await assert.rejects(fake.binding.listChats({pageSize:101}),/lark_im_input_invalid/);
  assert.equal(fake.calls.length,beforeBlocked,'blocked paths never reach the CLI');

  fake.state.connected=true;fake.state.scopes=[...LARK_IM_READ_SCOPES,...LARK_SCOPES];
  assert.equal(larkSendScopesOk(fake.state.scopes),false);
  await assert.rejects(fake.binding.sendMessage({chatId:'oc_generated_group',text:'Generated write must not leave'}),/lark_send_not_authorized/);
  assert.equal(fake.sentCalls().length,0,'a read-only archive scope cannot send');
  fake.state.scopes=[...LARK_IM_READ_SCOPES,...LARK_SCOPES,...LARK_IM_SEND_SCOPES];
  const sent=await fake.binding.sendMessage({chatId:'oc_generated_group',text:'Generated allowed send'});
  assert.match(sent.messageId,/^om_generated_sent_/);
  assert.equal(fake.sentCalls().length,1);
});

test('official Feishu session check requires the host lark binding even before any account login',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-feishu-session-binding-check-')),githubCalls:string[]=[];
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const store=new Store(directory),executor=new ExecutionEngine(store);
  const releases=new GitHubPluginReleases(join(directory,'packages'),rejectingGitHub(githubCalls),repoRoot);
  const plugins=new PluginCenter(store,executor,releases);
  t.after(()=>plugins.close());
  plugins.connectorHost={async install(){},async stop(){},async restart(){},inventory:()=>[],supportsBinding:()=>false};
  const preview=await plugins.resolve({repository:feishu.repository,tag:feishu.tag});
  plugins.install({previewId:preview.id,expectedRevision:plugins.view().revision,operationId:randomUUID()});
  await waitFor(()=>plugins.view().packages[0]?.state==='installed','Feishu session package install');
  const view=plugins.view();
  const instance=plugins.configure(undefined,{packageId:view.packages[0]!.id,name:'Feishu binding check',scope:'default',configuration:{},expectedRevision:view.revision,operationId:randomUUID()});
  plugins.action(instance.id,'check',{expectedRevision:instance.revision,operationId:randomUUID()});
  await waitFor(()=>plugins.instanceView(instance.id).observed==='blocked','binding check failure');
  const blocked=plugins.instanceView(instance.id);
  assert.equal(blocked.issues.some(issue=>issue.includes('account_binding_unavailable:lark')),true);
  assert.equal(blocked.capabilities.some(value=>value.id==='source.connector'&&value.state==='verified'),true);
  assert.equal(blocked.allowedActions.includes('enable'),false);
});

test('official Feishu session installs on the existing Lark account, archives selected chats and sends only through a confirmed action',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-feishu-session-journey-'));
  const config:Config={dataDir:directory,token:owner,tokenPath:join(directory,'owner-token'),host:'127.0.0.1',port:0,profile:'test',tokenFromEnvironment:true,maxStorageBytes:30*1024*1024,maxExportBytes:1024*1024,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'https://api.deepseek.com',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',logLevel:'silent',connectors:{directory:join(directory,'connectors'),syncIntervalMs:60000,mcpEnabled:false,mcpReadToken:'',mcpWriteEnabled:false,mcpWriteToken:'',mcpWriteSourceIds:[]}};
  const fake=fakeLark();
  const networkCalls:string[]=[];
  const node=await buildApp(config,{backgroundWorker:false,connectorTesting:{lark:fake.runner,larkBinding:fake.binding,fetch:async url=>{networkCalls.push(String(url));throw new Error('No network request belongs in the Feishu session fixture');}},agent:{configured:false,async query(){throw Error('No model request belongs in the Feishu session fixture');},async close(){}}});
  const githubCalls:string[]=[];
  Object.defineProperty(node.pluginCenter.releases,'transport',{value:rejectingGitHub(githubCalls)});
  t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});

  let view=node.pluginCenter.view();
  assert.ok(view.catalog.some(entry=>entry.repository===feishu.repository&&entry.tag===feishu.tag));
  assert.equal(view.sourceContributions?.length??0,0);

  const wrongTag=await node.app.inject({method:'POST',url:'/api/plugins/resolve',headers,payload:{repository:feishu.repository,tag:'v9.9.9'}});
  assert.equal(wrongTag.statusCode,422);
  const withPath=await node.app.inject({method:'POST',url:'/api/plugins/resolve',headers,payload:{repository:feishu.repository,tag:feishu.tag,localDirectory:feishu.localDirectory}});
  assert.equal(withPath.statusCode,400);
  assert.equal(githubCalls.length,0);

  const resolved=await node.app.inject({method:'POST',url:'/api/plugins/resolve',headers,payload:{repository:feishu.repository,tag:feishu.tag}});
  assert.equal(resolved.statusCode,200);
  const preview=resolved.json() as {id:string;installable:boolean;source:{repository:string;tag:string;digest:string}};
  assert.equal(preview.installable,true);
  assert.equal(preview.source.repository,feishu.repository);
  assert.equal(resolved.body.includes(feishu.localDirectory),false);

  const install=await node.app.inject({method:'POST',url:'/api/plugins/install',headers,payload:{previewId:preview.id,expectedRevision:view.revision,operationId:randomUUID()}});
  assert.equal(install.statusCode,200);
  await waitFor(()=>node.pluginCenter.view().packages[0]?.state==='installed','Feishu session install');
  view=node.pluginCenter.view();
  assert.equal(view.instances.length,0,'installation creates no default instance and starts no scan');
  assert.equal(view.sourceContributions?.[0]?.title,'飞书会话');
  assert.equal(view.sourceContributions?.[0]?.attachToBinding,'lark');
  assert.equal(view.sourceContributions?.[0]?.state,'installed');
  assert.equal(fake.calls.length,0,'install creates no Lark CLI request');

  const packageId=view.packages[0]!.id;
  const configured=await node.app.inject({method:'POST',url:'/api/plugin-instances',headers,payload:{packageId,name:'Feishu session archive',scope:'default',configuration:{},expectedRevision:view.revision,operationId:randomUUID()}});
  assert.equal(configured.statusCode,200,configured.body);
  const instance=configured.json() as {id:string;revision:number};
  assert.equal(fake.calls.length,0,'configuration asks for no second Feishu app credential');

  const check=await node.app.inject({method:'POST',url:'/api/plugin-instances/'+instance.id+'/check',headers,payload:{expectedRevision:instance.revision,operationId:randomUUID()}});
  assert.equal(check.statusCode,200,check.body);
  await waitFor(()=>node.pluginCenter.instanceView(instance.id).observed==='ready','Feishu session check');
  const checkedView=node.pluginCenter.instanceView(instance.id);
  assert.equal(checkedView.capabilities.some(value=>value.id==='source.connector'&&value.state==='verified'),true);
  assert.equal(checkedView.capabilities.some(value=>value.id==='message.send'&&value.state==='verified'),true);
  assert.equal(fake.calls.length,0,'check verifies package and host binding without a Feishu login');

  const enable=await node.app.inject({method:'POST',url:'/api/plugin-instances/'+instance.id+'/enable',headers,payload:{expectedRevision:checkedView.revision,operationId:randomUUID()}});
  assert.equal(enable.statusCode,200);
  await waitFor(()=>{const value=node.pluginCenter.instanceView(instance.id);return value.desired&&value.observed==='ready';},'Feishu session enable');
  await waitFor(()=>node.pluginCenter.view().sourceContributions?.[0]?.state==='enabled','Feishu session source contribution enabled');
  for(let attempt=0;attempt<200;attempt++){
    if((await node.app.inject({url:'/api/connectors/feishu-session',headers})).statusCode===200)break;
    if(attempt===199)throw new Error('Timed out waiting for Feishu session owner routes');
    await new Promise(resolve=>setTimeout(resolve,25));
  }
  assert.equal(node.sources.listSources().length,0,'enabling is not authorization and starts no scan');
  assert.equal(fake.calls.length,0,'enabling does not log in or read Feishu');
  assert.equal((await node.app.inject({method:'POST',url:'/api/connectors/feishu-session/archive/start',payload:{}})).statusCode,401,'Feishu session owner routes reject missing owner authorization');

  const disconnectedArchive=await node.app.inject({method:'POST',url:'/api/connectors/feishu-session/archive/start',headers,payload:{}});
  assert.equal(disconnectedArchive.statusCode,401,disconnectedArchive.body);
  assert.equal(disconnectedArchive.json().error,'feishu_session_not_connected');
  assert.equal(fake.loginCalls().length,0,'the package never opens a second Feishu document/calendar login');
  const disconnectedSend=await node.app.inject({method:'POST',url:'/api/connectors/feishu-session/send/start',headers,payload:{}});
  assert.equal(disconnectedSend.statusCode,403,disconnectedSend.body);
  assert.equal(fake.loginCalls().length,0);

  let inventory=(await node.app.inject({url:'/api/action-capabilities',headers})).json() as {executionEnabled:boolean;centralConnectors:{name:string;capability:{id:string;version:number};target:Record<string,unknown>}[];providers:{identity:Record<string,unknown>;capability:{id:string}}[];grants:{id:string;state:string;capability:{id:string}}[]};
  const messageChoice=inventory.centralConnectors.find(value=>value.capability.id==='message.send');
  assert.ok(messageChoice);
  assert.equal(messageChoice.target.executionLocation,'central-connector');
  assert.equal(messageChoice.target.packageId,packageId);
  assert.equal(inventory.executionEnabled,false,'install, check and enable never grant execution');
  assert.deepEqual(inventory.providers.map(provider=>provider.capability.id),['message.send']);

  // The existing built-in Feishu document/calendar connector connects first.
  const larkCheck=await node.app.inject({method:'POST',url:'/api/connectors/lark/check',headers,payload:{}});
  assert.equal(larkCheck.statusCode,200,larkCheck.body);
  const larkLogin=await node.app.inject({method:'POST',url:'/api/connectors/lark/login',headers,payload:{calendar:true}});
  assert.equal(larkLogin.statusCode,200,larkLogin.body);
  for(let attempt=0;attempt<400;attempt++){
    const status=(await node.app.inject({url:'/api/connectors/lark',headers})).json() as {connected:boolean;job?:{state:string}};
    if(status.connected&&(!status.job||!['waiting','running'].includes(status.job.state)))break;
    if(attempt===399)throw new Error('Timed out waiting for the existing Feishu login');
    await new Promise(resolve=>setTimeout(resolve,25));
  }
  const selection={documents:[documentUrl],calendarIds:['cal-1'],pastDays:30,futureDays:90,timeZone:'Asia/Shanghai',autoSync:false,documentDiscovery:{created:false,edited:false,opened:false,firstSyncDays:30}};
  const selected=await node.app.inject({method:'PUT',url:'/api/connectors/lark/selection',headers,payload:selection});
  assert.equal(selected.statusCode,200,selected.body);
  const larkSync=await node.app.inject({method:'POST',url:'/api/connectors/lark/sync',headers,payload:{}});
  assert.equal(larkSync.statusCode,200,larkSync.body);
  for(let attempt=0;attempt<400;attempt++){
    const status=(await node.app.inject({url:'/api/connectors/lark',headers})).json() as {job?:{state:string}};
    if(!status.job||!['waiting','running'].includes(status.job.state))break;
    if(attempt===399)throw new Error('Timed out waiting for the existing Feishu document sync');
    await new Promise(resolve=>setTimeout(resolve,25));
  }
  const larkStatusBefore=(await node.app.inject({url:'/api/connectors/lark',headers})).json() as {connected:boolean;selection:unknown};
  assert.equal(larkStatusBefore.connected,true);
  const larkSourcesBefore=()=>node.sources.listSources().filter(source=>source.kind==='lark-docs'||source.kind==='lark-calendar');
  assert.equal(larkSourcesBefore().length,2);
  assert.equal(larkSourcesBefore().every(source=>source.enabled),true);
  assert.equal(node.sources.listItems({kind:'file'}).items.length>=1,true);
  const storedLark=readFileSync(join(directory,'connectors','lark.json'),'utf8');

  fake.calls.length=0;
  const archiveStart=await node.app.inject({method:'POST',url:'/api/connectors/feishu-session/archive/start',headers,payload:{}});
  assert.equal(archiveStart.statusCode,200,archiveStart.body);
  const archiveJob=archiveStart.json() as {job?:{state:string;authorizationUrl?:string}};
  assert.equal(archiveJob.job?.authorizationUrl?.startsWith('https://accounts.feishu.cn/'),true);
  assert.equal(JSON.stringify(archiveJob).includes('device-code'),false,'the device code never reaches the owner response');
  for(let attempt=0;attempt<400;attempt++){
    const status=(await node.app.inject({url:'/api/connectors/feishu-session',headers})).json() as {archiveAuthorized:boolean;sendAuthorized:boolean};
    if(status.archiveAuthorized)break;
    if(attempt===399)throw new Error('Timed out waiting for Feishu session archive authorization');
    await new Promise(resolve=>setTimeout(resolve,25));
  }
  const archiveStatus=(await node.app.inject({url:'/api/connectors/feishu-session',headers})).json() as {connected:boolean;archiveAuthorized:boolean;sendAuthorized:boolean;selected:unknown[];account:string};
  assert.equal(archiveStatus.connected,true);
  assert.equal(archiveStatus.archiveAuthorized,true);
  assert.equal(archiveStatus.sendAuthorized,false,'archive authorization never grants sending');
  assert.deepEqual(archiveStatus.selected,[]);
  assert.equal(archiveStatus.account,'Generated Feishu Owner');
  const archiveLogin=fake.loginCalls().at(-1)!;
  for(const scope of LARK_IM_READ_SCOPES)assert.equal(archiveLogin.includes(scope),true,'archive authorization requests '+scope);
  for(const scope of LARK_SCOPES)assert.equal(archiveLogin.includes(scope),true,'existing document scope '+scope+' is preserved');
  assert.equal(archiveLogin.includes('calendar:calendar:readonly'),true,'existing calendar scope is preserved');
  assert.equal(archiveLogin.includes('im:message.send_as_user'),false,'archive authorization never requests a send scope');
  assert.equal(archiveLogin.includes('im:message'),false,'archive authorization never requests the send-capable message scope');
  assert.equal(fake.calls.some(call=>call.kind==='im-chats'||call.kind==='im-messages'),false,'authorization alone reads no chat or message');
  assert.equal(node.sources.listSources().filter(source=>source.kind===feishu.kind).length,0);
  const larkStatusAfterAuth=(await node.app.inject({url:'/api/connectors/lark',headers})).json() as {connected:boolean;selection:unknown};
  assert.deepEqual(larkStatusAfterAuth.selection,larkStatusBefore.selection,'adding message scopes leaves the document/calendar selection unchanged');
  assert.equal(larkSourcesBefore().every(source=>source.enabled),true,'existing document/calendar sources stay enabled');
  assert.equal(readFileSync(join(directory,'connectors','lark.json'),'utf8'),storedLark,'the package never rewrites lark.json');

  const candidates=await node.app.inject({method:'POST',url:'/api/connectors/feishu-session/candidates',headers,payload:{}});
  assert.equal(candidates.statusCode,200,candidates.body);
  const listed=candidates.json() as {channels:{id:string;type:string;name:string}[];directMessages:{id:string;type:string;name:string}[];items:unknown[]};
  assert.deepEqual(listed.channels.map(item=>[item.id,item.type,item.name]),[['oc_generated_group','group','Generated group']]);
  assert.deepEqual(listed.directMessages.map(item=>[item.id,item.type,item.name]),[['oc_generated_p2p','p2p','Generated person']]);
  assert.equal(listed.items.length,2);
  assert.equal(fake.calls.some(call=>call.kind==='im-messages'),false,'previewing names reads no message body');
  assert.equal(fake.calls.some(call=>call.kind==='im-chats'),true);

  const selectedGroup=await node.app.inject({method:'POST',url:'/api/connectors/feishu-session/select',headers,payload:{selected:[{id:'oc_generated_group',type:'group'}]}});
  assert.equal(selectedGroup.statusCode,200,selectedGroup.body);
  const selectedStatus=selectedGroup.json() as {selected:{id:string;type:string;name:string}[]};
  assert.deepEqual(selectedStatus.selected,[{id:'oc_generated_group',type:'group',name:'Generated group'}]);
  const officialSources=()=>node.sources.listSources().filter(source=>source.kind===feishu.kind);
  assert.equal(officialSources().length,1,'only the explicitly checked group enters the scope');
  assert.equal(officialSources()[0]!.enabled,true);
  assert.equal(officialSources().some(source=>source.name.includes('私信')),false,'unchecked direct messages stay outside the scope');
  assert.equal(fake.calls.some(call=>call.kind==='im-messages'),false,'selection alone reads no message body');

  const firstSync=await node.app.inject({method:'POST',url:'/api/connectors/feishu-session/sync',headers,payload:{}});
  assert.equal(firstSync.statusCode,200,firstSync.body);
  const sourceId=officialSources()[0]!.id;
  const historyCalls=fake.calls.filter(call=>call.kind==='im-messages');
  assert.equal(historyCalls.length,1,'only the checked group is read');
  assert.equal(historyCalls[0]!.kind==='im-messages'?historyCalls[0]!.chatId:undefined,'oc_generated_group');
  const firstStart=Number(historyCalls[0]!.kind==='im-messages'?historyCalls[0]!.startTime:0);
  assert.equal(Math.abs(firstStart-(Math.floor(Date.now()/1000)-30*86400))<180,true,'the first sync window defaults to about 30 days');
  assert.equal(fake.calls.some(call=>call.kind==='im-messages'&&call.chatId==='oc_generated_p2p'),false,'unchecked direct messages are never read');
  const firstItem=node.sources.getItem(sourceId,'om_generated_group_1');
  assert.equal(firstItem?.title.includes('Generated group'),true);
  assert.match(firstItem?.text??'',/Generated group hello/);
  assert.equal(node.sources.history(sourceId,'om_generated_group_1').length,1);
  assert.equal(node.sources.getItem(sourceId,'om_generated_p2p_1'),undefined);

  fake.editMessage('om_generated_group_2','Generated group follow-up edited');
  fake.addMessage('oc_generated_group',{message_id:'om_generated_group_3',msg_type:'text',create_time:String(Date.now()+1000),chat_id:'oc_generated_group',sender:{id:'ou_dave',id_type:'open_id',sender_type:'user'},body:{content:JSON.stringify({text:'Generated new group message'})}});
  const secondSync=await node.app.inject({method:'POST',url:'/api/connectors/feishu-session/sync',headers,payload:{}});
  assert.equal(secondSync.statusCode,200,secondSync.body);
  const secondHistory=fake.calls.filter(call=>call.kind==='im-messages').at(-1)!;
  assert.equal(secondHistory.kind==='im-messages'?secondHistory.chatId:undefined,'oc_generated_group');
  assert.equal(secondHistory.kind==='im-messages'?secondHistory.startTime:undefined,String(Math.floor(Number(groupMessageTwo.create_time)/1000)),'later syncs resume from the last archived message');
  const followUpHistory=node.sources.history(sourceId,'om_generated_group_2');
  assert.equal(followUpHistory.length,2,'an edited message enters the version chain');
  assert.match(followUpHistory[0]!.text,/follow-up edited/);
  assert.match(followUpHistory[1]!.text,/follow-up/);
  assert.equal(node.sources.getItem(sourceId,'om_generated_group_3')?.text.includes('Generated new group message'),true);
  assert.equal(fake.calls.some(call=>call.kind==='im-messages'&&call.chatId==='oc_generated_p2p'),false);

  inventory=(await node.app.inject({url:'/api/action-capabilities',headers})).json() as typeof inventory;
  const currentChoice=inventory.centralConnectors.find(value=>value.capability.id==='message.send')!;
  const provider=inventory.providers.find(value=>value.capability.id==='message.send')!;
  const officialSource=officialSources()[0]!;
  const sourceIdentity={sourceId:officialSource.id,kind:officialSource.kind,deviceId:officialSource.deviceId,platform:officialSource.platform};
  let actionsView=(await node.app.inject({url:'/api/actions',headers})).json() as {messageRevision:number};
  assert.equal(actionsView.messageRevision,0);
  const beforeGrant=await node.app.inject({method:'POST',url:'/api/actions/messages',headers,payload:{operationId:randomUUID(),expectedRevision:actionsView.messageRevision,target:currentChoice.target,message:{conversationId:'oc_generated_group',conversationName:'Generated group',text:'Generated message before grant'}}});
  assert.equal(beforeGrant.statusCode,403,'a message proposal requires the owner message.send grant');
  assert.equal(fake.sentCalls().length,0);

  const draft=await node.app.inject({method:'PUT',url:'/api/action-capability-drafts',headers,payload:{operationId:randomUUID(),expectedRevision:0,id:randomUUID(),capability:{id:'message.send',version:1},target:currentChoice.target,inputs:{sources:[sourceIdentity],existingArchived:true,futureInputs:true}}});
  assert.equal(draft.statusCode,200,draft.body);
  const draftValue=draft.json() as {id:string;revision:number};
  const missingAck=await node.app.inject({method:'PUT',url:'/api/action-capability-grants',headers,payload:{operationId:randomUUID(),expectedRevision:0,id:randomUUID(),draftId:draftValue.id,draftRevision:draftValue.revision,plugin:provider.identity}});
  assert.equal(missingAck.statusCode,400,'message.send authorization requires acknowledgeMessageSends');
  const granted=await node.app.inject({method:'PUT',url:'/api/action-capability-grants',headers,payload:{operationId:randomUUID(),expectedRevision:0,id:randomUUID(),draftId:draftValue.id,draftRevision:draftValue.revision,plugin:provider.identity,acknowledgeMessageSends:true}});
  assert.equal(granted.statusCode,200,granted.body);
  const grantValue=granted.json() as {id:string;state:string;capability:{id:string}};
  assert.equal(grantValue.capability.id,'message.send');
  inventory=(await node.app.inject({url:'/api/action-capabilities',headers})).json() as typeof inventory;
  assert.equal(inventory.executionEnabled,true);
  assert.equal(inventory.grants.some(value=>value.id===grantValue.id&&value.state==='active'),true);
  assert.equal(fake.sentCalls().length,0,'a grant alone never sends a message');

  actionsView=(await node.app.inject({url:'/api/actions',headers})).json() as {messageRevision:number};
  const readOnlyProposalResponse=await node.app.inject({method:'POST',url:'/api/actions/messages',headers,payload:{operationId:randomUUID(),expectedRevision:actionsView.messageRevision,target:currentChoice.target,message:{conversationId:'oc_generated_group',conversationName:'Generated group',text:'Generated message before send authorization'}}});
  assert.equal(readOnlyProposalResponse.statusCode,200,readOnlyProposalResponse.body);
  const readOnlyProposal=readOnlyProposalResponse.json() as {proposal:{id:string;status:string;version:number;message:{conversationId:string;text:string}};revision:number};
  assert.equal(readOnlyProposal.proposal.status,'proposed');
  assert.equal(fake.sentCalls().length,0,'creating a proposal never sends');
  const readOnlyConfirm=await node.app.inject({method:'POST',url:'/api/actions/'+readOnlyProposal.proposal.id+'/confirm',headers,payload:{version:readOnlyProposal.proposal.version,target:currentChoice.target,message:readOnlyProposal.proposal.message}});
  assert.equal(readOnlyConfirm.statusCode,200,readOnlyConfirm.body);
  await waitFor(()=>node.actions.get(readOnlyProposal.proposal.id).status==='uncertain','a send without the second authorization settles uncertain');
  assert.equal(fake.sentCalls().length,0,'archive authorization alone can never call the send path');
  assert.equal(node.actions.get(readOnlyProposal.proposal.id).externalId,undefined);

  const sendStart=await node.app.inject({method:'POST',url:'/api/connectors/feishu-session/send/start',headers,payload:{}});
  assert.equal(sendStart.statusCode,200,sendStart.body);
  for(let attempt=0;attempt<400;attempt++){
    const status=(await node.app.inject({url:'/api/connectors/feishu-session',headers})).json() as {sendAuthorized:boolean};
    if(status.sendAuthorized)break;
    if(attempt===399)throw new Error('Timed out waiting for Feishu session send authorization');
    await new Promise(resolve=>setTimeout(resolve,25));
  }
  const sendStatus=(await node.app.inject({url:'/api/connectors/feishu-session',headers})).json() as {sendAuthorized:boolean;archiveAuthorized:boolean;selected:{id:string}[]};
  assert.equal(sendStatus.sendAuthorized,true,'sending needs the second user-scope authorization');
  assert.equal(sendStatus.archiveAuthorized,true);
  assert.equal(sendStatus.selected[0]?.id,'oc_generated_group');
  assert.equal(fake.sentCalls().length,0,'the send authorization alone never sends');
  const sendLogin=fake.loginCalls().at(-1)!;
  for(const scope of LARK_IM_SEND_SCOPES)assert.equal(sendLogin.includes(scope),true,'send authorization requests '+scope);
  for(const scope of LARK_IM_READ_SCOPES)assert.equal(sendLogin.includes(scope),true,'send authorization preserves the read scope '+scope);
  for(const scope of LARK_SCOPES)assert.equal(sendLogin.includes(scope),true,'send authorization preserves the document scope '+scope);
  assert.equal(readFileSync(join(directory,'connectors','lark.json'),'utf8'),storedLark,'send authorization never rewrites lark.json');

  actionsView=(await node.app.inject({url:'/api/actions',headers})).json() as {messageRevision:number};
  const approvedProposalResponse=await node.app.inject({method:'POST',url:'/api/actions/messages',headers,payload:{operationId:randomUUID(),expectedRevision:actionsView.messageRevision,target:currentChoice.target,message:{conversationId:'oc_generated_group',conversationName:'Generated group',text:'Generated owner approved feishu message'}}});
  assert.equal(approvedProposalResponse.statusCode,200,approvedProposalResponse.body);
  const approvedProposal=approvedProposalResponse.json() as {proposal:{id:string;status:string;version:number;message:{conversationId:string;text:string}};revision:number};
  assert.equal(fake.sentCalls().length,0,'an authorized proposal still waits for owner confirmation');
  const approvedConfirm=await node.app.inject({method:'POST',url:'/api/actions/'+approvedProposal.proposal.id+'/confirm',headers,payload:{version:approvedProposal.proposal.version,target:currentChoice.target,message:approvedProposal.proposal.message}});
  assert.equal(approvedConfirm.statusCode,200,approvedConfirm.body);
  await waitFor(()=>node.actions.get(approvedProposal.proposal.id).status==='succeeded','the host dispatches the confirmed message');
  assert.equal(fake.sentCalls().length,1);
  const sentCall=fake.sentCalls()[0]!;
  assert.equal(sentCall.kind==='im-send'?sentCall.chatId:undefined,'oc_generated_group');
  assert.equal(sentCall.kind==='im-send'?sentCall.text:undefined,'Generated owner approved feishu message');
  const completed=node.actions.get(approvedProposal.proposal.id);
  assert.equal(completed.target&&'executionLocation' in completed.target?completed.target.executionLocation:undefined,'central-connector');
  assert.ok(completed.operationId);
  const sentMessageId='om_generated_sent_1';
  assert.equal(completed.externalId,'oc_generated_group:'+sentMessageId);
  const archivedSent=node.sources.getItem(sourceId,sentMessageId);
  assert.equal(archivedSent?.text.includes('Generated owner approved feishu message'),true,'the sent message is archived again');
  assert.equal(node.sources.history(sourceId,sentMessageId).length,1);

  actionsView=(await node.app.inject({url:'/api/actions',headers})).json() as {messageRevision:number};
  const unselectedProposalResponse=await node.app.inject({method:'POST',url:'/api/actions/messages',headers,payload:{operationId:randomUUID(),expectedRevision:actionsView.messageRevision,target:currentChoice.target,message:{conversationId:'oc_generated_p2p',conversationName:'Unselected direct message',text:'Generated message outside the selected scope'}}});
  assert.equal(unselectedProposalResponse.statusCode,200);
  const unselectedProposal=unselectedProposalResponse.json() as {proposal:{id:string;version:number;message:{conversationId:string;text:string}}};
  assert.equal((await node.app.inject({method:'POST',url:'/api/actions/'+unselectedProposal.proposal.id+'/confirm',headers,payload:{version:unselectedProposal.proposal.version,target:currentChoice.target,message:unselectedProposal.proposal.message}})).statusCode,200);
  await waitFor(()=>node.actions.get(unselectedProposal.proposal.id).status==='uncertain','an unselected conversation cannot be sent to');
  assert.equal(fake.sentCalls().length,1,'no send leaves the selected scope');

  const sendDisconnect=await node.app.inject({method:'POST',url:'/api/connectors/feishu-session/send/disconnect',headers,payload:{}});
  assert.equal(sendDisconnect.statusCode,200);
  assert.equal((await node.app.inject({url:'/api/connectors/feishu-session',headers})).json().sendAuthorized,false);
  actionsView=(await node.app.inject({url:'/api/actions',headers})).json() as {messageRevision:number};
  const revokedProposalResponse=await node.app.inject({method:'POST',url:'/api/actions/messages',headers,payload:{operationId:randomUUID(),expectedRevision:actionsView.messageRevision,target:currentChoice.target,message:{conversationId:'oc_generated_group',conversationName:'Generated group',text:'Generated message after send revocation'}}});
  assert.equal(revokedProposalResponse.statusCode,200);
  const revokedProposal=revokedProposalResponse.json() as {proposal:{id:string;version:number;message:{conversationId:string;text:string}}};
  assert.equal((await node.app.inject({method:'POST',url:'/api/actions/'+revokedProposal.proposal.id+'/confirm',headers,payload:{version:revokedProposal.proposal.version,target:currentChoice.target,message:revokedProposal.proposal.message}})).statusCode,200);
  await waitFor(()=>node.actions.get(revokedProposal.proposal.id).status==='uncertain','a revoked send authorization stops execution');
  assert.equal(fake.sentCalls().length,1);

  const shrink=await node.app.inject({method:'POST',url:'/api/connectors/feishu-session/select',headers,payload:{selected:[]}});
  assert.equal(shrink.statusCode,200,shrink.body);
  assert.equal(officialSources().every(source=>!source.enabled),true);
  assert.equal((await node.app.inject({method:'POST',url:'/api/connectors/feishu-session/sync',headers,payload:{}})).statusCode,409,'shrinking to no selection stops new sync');
  assert.equal(fake.calls.filter(call=>call.kind==='im-messages').length,2,'shrinking issues no new history read');
  assert.equal(node.sources.getItem(sourceId,sentMessageId)?.text.includes('Generated owner approved feishu message'),true,'shrinking keeps archived messages');

  const reselect=await node.app.inject({method:'POST',url:'/api/connectors/feishu-session/select',headers,payload:{selected:[{id:'oc_generated_group',type:'group'}]}});
  assert.equal(reselect.statusCode,200,reselect.body);
  assert.equal(officialSources()[0]!.enabled,true);
  const beforeDisconnectCalls=fake.calls.length;
  const disconnected=await node.app.inject({method:'POST',url:'/api/connectors/feishu-session/disconnect',headers,payload:{}});
  assert.equal(disconnected.statusCode,200,disconnected.body);
  const afterDisconnect=disconnected.json() as {connected:boolean;archiveAuthorized:boolean;sendAuthorized:boolean;selected:unknown[]};
  assert.equal(afterDisconnect.archiveAuthorized,false);
  assert.equal(afterDisconnect.sendAuthorized,false);
  assert.deepEqual(afterDisconnect.selected,[]);
  assert.equal(officialSources().every(source=>!source.enabled),true);
  assert.equal(fake.calls.length,beforeDisconnectCalls,'disconnect issues no Feishu request');
  const beforeDisconnectedSync=fake.calls.length;
  assert.equal((await node.app.inject({method:'POST',url:'/api/connectors/feishu-session/sync',headers,payload:{}})).statusCode,403,'disconnect stops every new Feishu session read');
  assert.equal(fake.calls.slice(beforeDisconnectedSync).some(call=>call.kind==='im-messages'),false,'a disconnected source never reads history');
  assert.equal(node.sources.getItem(sourceId,sentMessageId)?.text.includes('Generated owner approved feishu message'),true,'disconnect keeps archived messages');
  assert.equal(node.sources.history(sourceId,'om_generated_group_2').length,2,'disconnect keeps the prior version chain');
  const retainedState=node.store.db.prepare("SELECT json FROM plugin_instance_state WHERE key='feishu-session'").all().map(row=>String((row as {json:string}).json)).join('\n');
  assert.equal(retainedState.includes('private-generated-device-code'),false,'the device code is never persisted');
  assert.equal(retainedState.includes('accessToken'),false,'the package stores no Feishu token');

  const larkStatusAfter=(await node.app.inject({url:'/api/connectors/lark',headers})).json() as {connected:boolean;selection:unknown};
  assert.equal(larkStatusAfter.connected,true,'the existing Feishu connection stays connected');
  assert.deepEqual(larkStatusAfter.selection,larkStatusBefore.selection,'the existing document/calendar selection is untouched');
  assert.equal(larkSourcesBefore().every(source=>source.enabled),true,'existing document/calendar sources stay enabled');
  assert.equal(readFileSync(join(directory,'connectors','lark.json'),'utf8'),storedLark,'disconnect never rewrites lark.json');

  const invitation=await node.app.inject({method:'POST',url:'/api/connections/collector-invitations',headers,payload:{serverUrl:'https://generated.invalid',label:'Generated Feishu session review device'}});
  const paired=await node.app.inject({method:'POST',url:'/api/connections/redeem',payload:{code:invitation.json().invitation.code,deviceId:'generated-feishu-session-collector-device',deviceName:'Generated Feishu session collector',platform:'macos'}});
  const collector={authorization:'Bearer '+paired.json().token};
  assert.equal((await node.app.inject({method:'POST',url:'/api/actions/messages',headers:collector,payload:{operationId:randomUUID(),expectedRevision:0,target:currentChoice.target,message:{conversationId:'oc_generated_group',text:'Generated collector attempt'}}})).statusCode,403,'a collector cannot create a message send proposal');
  assert.equal((await node.app.inject({method:'POST',url:'/api/actions/'+revokedProposal.proposal.id+'/confirm',headers:collector,payload:{version:node.actions.get(revokedProposal.proposal.id).version,target:currentChoice.target,message:revokedProposal.proposal.message}})).statusCode,403,'a collector cannot confirm a message send');
  assert.equal(node.actions.catalog().items.some(item=>item.id===approvedProposal.proposal.id),false,'the read-only Ask catalog never exposes message sends');

  assert.deepEqual(networkCalls,[],'the package uses no network transport');
  assert.equal(fake.calls.some(call=>['document','documents-search','calendars','events','minutes-search','minutes-metadata','minutes-transcript','minutes-media','setup','configure','install'].includes(call.kind)),false,'the official package calls no document, calendar, Minutes or setup command');
  assert.equal(fake.calls.filter(call=>call.kind==='im-send').length,1,'only the one confirmed send reached the IM send path');
});
