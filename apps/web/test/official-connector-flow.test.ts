import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import React,{act,useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {JSDOM} from 'jsdom';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {configureLocale,getLocale} from '@mote/shared/i18n';
import {buildApp} from '../../server/src/app.js';
import type {ConfigurationPlatformOptions} from '../../server/src/config.js';
import {createApi,type Api} from '../src/api.js';
import {SourceCatalog} from '../src/plugins/sources/SourceCatalog.js';
import {Sources} from '../src/plugins/sources/Sources.js';
import {pages as sourcePages,connectionsPages} from '../src/plugins/sources/index.js';
import {webFeatures} from '../src/features/registry.js';
import {resources} from '../src/resource-cache.js';
import {LARK_VERSION,type LarkRunner} from '../../server/src/connectors/lark-cli.js';
import {LARK_SCOPES} from '../../server/src/connectors/lark.js';
import type {OfficialProvider} from '../src/plugins/sources/OfficialConnectorSettings.js';

const definitions={notion:{repository:'mote/official-notion-connector',kind:'mote.official.notion',name:'Notion',candidate:'Generated selected page',externalId:'page-generated'},slack:{repository:'mote/official-slack-connector',kind:'mote.official.slack',name:'Slack',candidate:'Generated selected channel',externalId:`${Math.floor(Date.now()/1000)-90*86400}.000100`},'feishu-session':{repository:'mote/official-feishu-session-connector',kind:'mote.official.feishu-session',name:'飞书会话',candidate:'Generated selected group',externalId:'om_generated_ui'}} as const;

function fakeNotion(){
 const calls:{path:string;method:string}[]=[];
 const state={workspace:'generated-workspace-A',failRead:false};
 const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
 const transport:typeof fetch=async(input,init={})=>{
  const url=new URL(String(input)),method=init.method??'GET';calls.push({path:url.pathname,method});
  if(url.hostname!=='api.notion.com')throw Error('No unbounded provider network in the generated official connector fixture');
  if(url.pathname==='/v1/oauth/token')return json({access_token:'generated-private-notion-token',workspace_id:state.workspace,workspace_name:state.workspace,bot_id:'generated-bot'});
  if(state.failRead)return json({code:'unauthorized'},401);
  if(url.pathname==='/v1/search')return json({results:[{object:'page',id:'page-generated',url:'https://www.notion.so/page-generated',properties:{Name:{type:'title',title:[{plain_text:'Generated selected page'}]}}}],has_more:false});
  if(url.pathname==='/v1/pages/page-generated')return json({object:'page',id:'page-generated',url:'https://www.notion.so/page-generated',created_time:'2026-01-01T00:00:00Z',last_edited_time:'2026-11-01T00:00:00Z',properties:{Name:{type:'title',title:[{plain_text:'Generated selected page'}]}}});
  if(url.pathname==='/v1/blocks/page-generated/children')return json({results:[{id:'generated-block',object:'block',type:'paragraph',paragraph:{rich_text:[{plain_text:'Generated actual Notion body through owner HTTP and rendered source settings'}]}}],has_more:false,next_cursor:null});
  throw Error('Unexpected generated Notion request '+url.pathname);
 };
 return {transport,calls,state};
}
function fakeOfficial(provider:OfficialProvider){
 const notion=fakeNotion(),calls:{path:string;method:string}[]=[],commands:string[]=[],logins:string[][]=[];
 const state={account:'ou_generated_owner',team:'T_GENERATED',connected:true,scopes:[...LARK_SCOPES],pending:[] as string[]};
 let releaseAuthorization:(()=>void)|undefined;
 const json=(body:unknown)=>new Response(JSON.stringify(body),{headers:{'content-type':'application/json'}});
 const transport:typeof fetch=async(input,init={})=>{
  const url=new URL(String(input));if(url.hostname==='api.notion.com')return notion.transport(input,init);calls.push({path:url.pathname,method:init.method??'GET'});
  if(url.hostname!=='slack.com')throw Error('No unexpected provider network in generated source flow');
  if(url.pathname==='/api/oauth.v2.access')return json({ok:true,authed_user:{id:'U_GENERATED',access_token:'generated-private-slack-token',scope:'channels:read,groups:read,im:read,mpim:read,channels:history,groups:history,im:history,mpim:history,users:read'},team:{id:state.team,name:'Generated Slack workspace'}});
  if(url.pathname==='/api/auth.test')return json({ok:true,user_id:'U_GENERATED',user:'Generated owner',team_id:state.team,team:'Generated Slack workspace',url:'https://generated.slack.com/'});
  if(url.pathname==='/api/conversations.list')return json({ok:true,channels:[{id:'C_GENERATED',name:'Generated selected channel',is_channel:true}],response_metadata:{next_cursor:''}});
  if(url.pathname==='/api/conversations.history')return json({ok:true,messages:[{ts:definitions.slack.externalId,user:'U_AUTHOR',text:'Generated actual Slack body through owner HTTP'}],has_more:false,response_metadata:{next_cursor:''}});
  if(url.pathname==='/api/users.info')return json({ok:true,user:{profile:{display_name:'Generated author'}}});
  throw Error('A source reading form must not call '+url.pathname);
 };
 const runner:LarkRunner=async(command,options={})=>{
  commands.push(command.kind);
  if(command.kind==='version')return 'lark-cli version '+LARK_VERSION;
  if(command.kind==='status')return JSON.stringify({appId:'generated-cli',identities:{user:{available:state.connected,openId:state.account,userName:'Generated Feishu owner',scope:state.scopes.join(' ')}}});
  if(command.kind==='login'){state.pending=[...command.scopes];logins.push(state.pending);return JSON.stringify({verification_url:'https://accounts.feishu.cn/authorize?generated=official-ui',device_code:'generated-private-device-code',expires_in:600});}
  if(command.kind==='complete'){await new Promise<void>(resolve=>{releaseAuthorization=resolve;options.signal?.addEventListener('abort',()=>resolve(),{once:true});if(options.signal?.aborted)resolve();});if(options.signal?.aborted)throw Object.assign(Error('generated cancelled authorization'),{code:'lark_operation_cancelled',statusCode:409});state.connected=true;state.scopes=state.pending;releaseAuthorization=undefined;return JSON.stringify({ok:true});}
  if(command.kind==='im-chats')return JSON.stringify({ok:true,data:{items:[{chat_id:'oc_generated_ui',name:'Generated selected group',chat_mode:'group'}],has_more:false}});
  if(command.kind==='im-messages')return JSON.stringify({ok:true,data:{items:[{message_id:definitions['feishu-session'].externalId,msg_type:'text',create_time:String(Date.now()-90*86400000),chat_id:'oc_generated_ui',sender:{id:'ou_generated_author',id_type:'open_id',sender_type:'user'},body:{content:JSON.stringify({text:'Generated actual Feishu body through owner HTTP'})}}],has_more:false}});
  throw Error('No CLI effect belongs in the source flow: '+command.kind);
 };
 return {provider,transport,runner,calls,commands,logins,state,notion,authorizationWaiting:()=>Boolean(releaseAuthorization),releaseAuthorization:()=>releaseAuthorization?.()};
}
function Flow({api}:{api:Api}){
 const [hash,setHash]=useState(window.location.hash);
 useEffect(()=>{const changed=()=>setHash(window.location.hash);window.addEventListener('hashchange',changed);return()=>window.removeEventListener('hashchange',changed);},[]);
 return hash.startsWith('#/connections/add')?React.createElement(SourceCatalog,{api,onPage:()=>{}}):React.createElement(Sources,{api,onOpen:()=>{},onImport:()=>{}});
}
async function fixture(t:TestContext,kind:OfficialProvider='notion'){
 const definition=definitions[kind],directory=await mkdtemp(join(tmpdir(),'mote-official-flow-')),owner='generated-owner-'+randomUUID(),secret='GENERATED_OFFICIAL_'+randomUUID().replaceAll('-','_'),provider=fakeOfficial(kind);process.env[secret]='generated-private-client-secret';
 const config:ConfigurationPlatformOptions={path:(directory)+'/mote.yaml',privateCredential:{token:owner,tokenPath:join(directory,'owner')},initialDocument:{version:1,revision:0,storage:{dataDir:directory,maxExportBytes:1024*1024},server:{host:'127.0.0.1',port:0,profile:'test',allowedOrigins:[]},execution:{insightIntervalHours:0},models:{deployment:{model:'',apiKey:'',allowUnauthenticatedLocal:false,protocol:'deepseek',reasoningEffort:'high'},embedding:{model:'',baseUrl:'',apiKey:''}},diagnostics:{level:'silent'},connectors:{directory:join(directory,'connectors'),mcpEnabled:false,mcpReadToken:'',mcpWriteEnabled:false,mcpWriteToken:'',mcpWriteSourceIds:[]}}};
 const node=await buildApp(config,{backgroundWorker:false,connectorTesting:{fetch:provider.transport,lark:provider.runner},agent:{configured:false,async query(){throw Error('No model in the official connector flow');},async close(){}}});
 const origin=await node.app.listen({host:'127.0.0.1',port:0}),nativeFetch=globalThis.fetch,prior=new Map<string,PropertyDescriptor|undefined>(),locale=getLocale();configureLocale(()=> 'zh-CN');
 const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:origin+'/#/connections/add',pretendToBeVisual:true});
 const requests:{path:string;method:string}[]=[],origins=new Map([['Bearer '+owner,origin]]),otherNodes:typeof node[]=[];
 const delayed:{path:string;entered:boolean;released:boolean;release:()=>void;wait:Promise<void>}[]=[];
 // Delay delivery only after the real owner HTTP request has completed. This
 // deliberately ignores cancellation so a late successful transport must be
 // fenced by the mounted account/instance/node generation as well.
 const ownerFetch:typeof fetch=async(input,init={})=>{assert.equal(typeof input,'string');assert.ok(String(input).startsWith('/api/'));requests.push({path:String(input),method:init.method??'GET'});const target=origins.get(new Headers(init.headers).get('authorization')!);assert.ok(target,'Unknown generated owner');const hold=delayed.find(value=>value.path===input&&!value.entered);const response=await nativeFetch(new URL(String(input),target),init);if(!hold)return response;const bytes=await response.arrayBuffer();hold.entered=true;await hold.wait;return new Response(bytes,{status:response.status,headers:response.headers});};
 for(const [key,value] of Object.entries({window:dom.window,location:dom.window.location,document:dom.window.document,HTMLElement:dom.window.HTMLElement,localStorage:dom.window.localStorage,IS_REACT_ACT_ENVIRONMENT:true,fetch:ownerFetch})){prior.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});}
 const api=createApi({token:owner}),root=createRoot(dom.window.document.getElementById('root')!);
 const local=await webFeatures.install({id:'generated.official-flow',version:'1',components:[]},[...sourcePages,...connectionsPages].map(entry=>({surface:'page' as const,entry})));
 t.after(async()=>{for(const hold of delayed)hold.release();await act(async()=>root.unmount());await local.dispose();for(const[key,value]of prior){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}configureLocale(()=>locale);dom.window.close();for(const other of otherNodes)await other.app.close();await node.app.close();delete process.env[secret];await rm(directory,{recursive:true,force:true});});
 const until=async(check:()=>boolean|Promise<boolean>)=>{for(let attempt=0;attempt<800;attempt++){if(await check())return;await act(async()=>new Promise(resolve=>setTimeout(resolve,10)));}throw Error('The generated official source flow did not settle');};
 const request=<T=any>(path:string,body?:unknown)=>api.request<T>(path,body===undefined?undefined:{method:'POST',body:JSON.stringify(body)});
 const preview=await request('/api/plugins/resolve',{repository:definition.repository,tag:'v0.1.0'});await request('/api/plugins/install',{previewId:preview.id,expectedRevision:node.pluginCenter.view().revision,operationId:randomUUID()});await until(()=>node.pluginCenter.view().packages[0]?.state==='installed');
 const installed=await request('/api/plugins'),packageId=installed.packages.find((item:any)=>item.source.repository===definition.repository).id;
 const instance=await request('/api/plugin-instances',{packageId,name:'Generated official source flow',scope:'default',configuration:kind==='feishu-session'?{}:{clientId:'generated-client',clientSecret:'${'+secret+'}',redirectUri:'https://central.example/oauth/'+kind+'/callback'},expectedRevision:node.pluginCenter.view().revision,operationId:randomUUID()});
 await request('/api/plugin-instances/'+instance.id+'/check',{expectedRevision:instance.revision,operationId:randomUUID()});await until(()=>node.pluginCenter.instanceView(instance.id).observed==='ready');await request('/api/plugin-instances/'+instance.id+'/enable',{expectedRevision:node.pluginCenter.instanceView(instance.id).revision,operationId:randomUUID()});await until(()=>node.pluginCenter.instanceView(instance.id).desired&&node.pluginCenter.instanceView(instance.id).observed==='ready');
 const button=(title:string)=>{const value=[...dom.window.document.querySelectorAll('button')].find(value=>value.textContent===title);assert.ok(value,'Missing button '+title);return value;};
 const click=async(title:string)=>act(async()=>{button(title).click();});
 const render=(selectedApi:Api=api)=>act(async()=>root.render(React.createElement(Flow,{api:selectedApi})));
 return {node,dom,api,provider,requests,request,until,button,click,render,instance,definition,
  holdNext(path:string){let release!:()=>void;const wait=new Promise<void>(resolve=>{release=resolve;}),hold={path,entered:false,released:false,release:()=>{hold.released=true;release();},wait};delayed.push(hold);return hold;},
  async otherCentral(){const token='generated-other-'+randomUUID(),other=await buildApp({...config,dataDir:join(directory,'other-central'),token,tokenPath:join(directory,'other-owner')},{backgroundWorker:false,agent:{configured:false,async query(){throw Error('No model in the replacement Central');},async close(){}}});otherNodes.push(other);const nextOrigin=await other.app.listen({host:'127.0.0.1',port:0});origins.set('Bearer '+token,nextOrigin);return {api:createApi({token}),node:other};},
  async replaceAccount(){if(kind==='feishu-session'){provider.state.account='ou_generated_other';await request('/api/connectors/feishu-session/check',{});}else{if(kind==='notion')provider.notion.state.workspace='generated-workspace-B';else provider.state.team='T_GENERATED_OTHER';const started=await request('/api/connectors/'+kind+'/start',{}),target=new URL(started.authorizationUrl);const response=await nativeFetch(origin+'/oauth/'+kind+'/callback?state='+encodeURIComponent(target.searchParams.get('state')!)+'&code=generated-other-code');assert.equal(response.status,200);}await this.refresh();},
  async refresh(){await act(async()=>resources(api).invalidate(key=>key.startsWith('/api/connectors/')||key==='/api/sources'));},
  async authorize(){await until(()=>Boolean([...dom.window.document.querySelectorAll('button')].find(value=>value.textContent==='连接账号')));await click('连接账号');await until(()=>Boolean(dom.window.document.querySelector('.connector-authorization')));const target=new URL(dom.window.document.querySelector<HTMLAnchorElement>('.connector-authorization')!.href);assert.equal(target.hostname,kind==='notion'?'api.notion.com':kind==='slack'?'slack.com':'accounts.feishu.cn');assert.equal(target.searchParams.has('access_token'),false);if(kind==='feishu-session'){await until(provider.authorizationWaiting);provider.releaseAuthorization();await until(()=>provider.state.scopes.includes('im:message.group_msg:get_as_user'));}else{const callback=await nativeFetch(origin+'/oauth/'+kind+'/callback?state='+encodeURIComponent(target.searchParams.get('state')!)+'&code=generated-code');assert.equal(callback.status,200);}await this.refresh();await until(()=>Boolean([...dom.window.document.querySelectorAll('button')].find(value=>value.textContent==='加载可选内容')));},
  assertPrivate(){const html=dom.window.document.documentElement.outerHTML;for(const secret of [owner,'generated-private-notion-token','generated-private-slack-token','generated-private-client-secret','generated-private-device-code'])assert.equal(html.includes(secret),false);assert.ok(requests.every(value=>!value.path.includes(owner)));assert.ok(provider.commands.every(value=>value!=='im-send'));assert.ok(provider.logins.every(scopes=>!scopes.includes('im:message.send_as_user')));},
 };
}

test('Notion directory opens the formal installed connector, authorizes, saves a scope, syncs and revisits source settings over owner HTTP',async t=>{
 const f=await fixture(t);await f.render();await f.until(()=>Boolean([...f.dom.window.document.querySelectorAll('h3')].find(value=>value.textContent?.startsWith('Notion'))));
 const card=[...f.dom.window.document.querySelectorAll('h3')].find(value=>value.textContent?.startsWith('Notion'))!.closest<HTMLAnchorElement>('a')!;assert.equal(new URL(card.href).hash,'#/connections?setup=official-notion');await act(async()=>card.click());await f.until(()=>Boolean([...f.dom.window.document.querySelectorAll('button')].find(value=>value.textContent==='连接账号')));
 await f.authorize();await f.click('加载可选内容');await f.until(()=>Boolean([...f.dom.window.document.querySelectorAll('label')].find(value=>value.textContent?.includes('Generated selected page'))));
 const checkbox=f.dom.window.document.querySelector<HTMLInputElement>('.official-source-connector input[type=checkbox]')!;await act(async()=>checkbox.click());await f.click('保存并同步');await f.until(()=>f.node.sources.listSources().some(source=>source.kind==='mote.official.notion'&&source.status?.coverage?.state==='complete'));await f.refresh();await f.until(()=>f.dom.window.document.body.textContent!.includes('所选范围已完成'));
 const source=f.node.sources.listSources().find(value=>value.kind==='mote.official.notion')!;assert.equal(source.initialSync,'all');assert.match(f.node.sources.getItem(source.id,'page-generated')!.text,/actual Notion body/);assert.equal(source.status?.coverage?.processed,1);
 const detail=f.dom.window.document.querySelector<HTMLAnchorElement>('a[href="#/connections?sourceId='+source.id+'"]')!;await act(async()=>detail.click());await f.until(()=>Boolean(f.dom.window.document.querySelector('.source-final-tabs')));await f.until(()=>/Generated actual/.test(f.dom.window.document.querySelector('.source-final-content:not([hidden])')?.textContent??''));await act(async()=>f.dom.window.document.querySelector<HTMLButtonElement>('.source-final-tabs button:last-child')!.click());await f.until(()=>Boolean(f.dom.window.document.querySelector('[data-official-provider=notion]')));assert.match(f.dom.window.document.body.textContent!,/generated-workspace-A/);assert.equal(f.node.sources.history(source.id,'page-generated').length,1);f.assertPrivate();
});

for(const provider of ['slack','feishu-session'] as const)test(`${provider} directory authorizes only reading, saves selected content and revisits the real source coverage`,async t=>{
 const f=await fixture(t,provider);await f.render();await f.until(()=>Boolean([...f.dom.window.document.querySelectorAll('h3')].find(value=>value.textContent===f.definition.name)));
 const card=[...f.dom.window.document.querySelectorAll('h3')].find(value=>value.textContent===f.definition.name)!.closest<HTMLAnchorElement>('a')!;await act(async()=>card.click());await f.authorize();await f.click('加载可选内容');await f.until(()=>Boolean([...f.dom.window.document.querySelectorAll('label')].find(value=>value.textContent?.includes(f.definition.candidate))));
 await act(async()=>f.dom.window.document.querySelector<HTMLInputElement>('.official-source-connector input[type=checkbox]')!.click());await f.click('保存并同步');await f.until(()=>f.node.sources.listSources().some(source=>source.kind===f.definition.kind&&source.status?.coverage?.state==='complete'));await f.refresh();await f.until(()=>f.dom.window.document.body.textContent!.includes('所选范围已完成'));
 const source=f.node.sources.listSources().find(value=>value.kind===f.definition.kind)!;assert.equal(source.initialSync,'all');assert.match(f.node.sources.getItem(source.id,f.definition.externalId)!.text,/Generated actual/);assert.equal(source.status?.coverage?.processed,1);
 const detail=f.dom.window.document.querySelector<HTMLAnchorElement>('a[href="#/connections?sourceId='+source.id+'"]')!;await act(async()=>detail.click());await f.until(()=>Boolean(f.dom.window.document.querySelector('.source-final-tabs')));await f.until(()=>/Generated actual/.test(f.dom.window.document.querySelector('.source-final-content:not([hidden])')?.textContent??''));await act(async()=>f.dom.window.document.querySelector<HTMLButtonElement>('.source-final-tabs button:last-child')!.click());await f.until(()=>Boolean(f.dom.window.document.querySelector('[data-official-provider="'+provider+'"]')));assert.equal(f.node.sources.history(source.id,f.definition.externalId).length,1);f.assertPrivate();
});

async function open(f:Awaited<ReturnType<typeof fixture>>){
 await f.render();await f.until(()=>Boolean([...f.dom.window.document.querySelectorAll('h3')].find(value=>value.textContent?.startsWith(f.definition.name))));const card=[...f.dom.window.document.querySelectorAll('h3')].find(value=>value.textContent?.startsWith(f.definition.name))!.closest<HTMLAnchorElement>('a')!;await act(async()=>card.click());await f.authorize();
}
async function choose(f:Awaited<ReturnType<typeof fixture>>,mode:'all'|'new_only'='all'){
 await f.click('加载可选内容');await f.until(()=>Boolean(f.dom.window.document.querySelector('.official-source-connector input[type=checkbox]')));await act(async()=>f.dom.window.document.querySelector<HTMLInputElement>('.official-source-connector input[type=checkbox]')!.click());
 if(mode==='new_only')await act(async()=>{const select=f.dom.window.document.querySelector<HTMLSelectElement>('.official-source-connector select')!;select.value=mode;select.dispatchEvent(new f.dom.window.Event('change',{bubbles:true}));});
}
for(const provider of ['notion','slack','feishu-session'] as const)test(`${provider} saves new-only in the real source before enabling it and legacy selection preserves that policy`,async t=>{
 const f=await fixture(t,provider);await open(f);await choose(f,'new_only');
 f.node.store.db.exec(`CREATE TABLE generated_enable_modes(mode TEXT);
  CREATE TRIGGER generated_mode_insert AFTER INSERT ON source_connections WHEN json_extract(new.json,'$.kind')='${f.definition.kind}' AND json_extract(new.json,'$.enabled')=1 BEGIN INSERT INTO generated_enable_modes VALUES(json_extract(new.json,'$.initialSync'));END;
  CREATE TRIGGER generated_mode_update AFTER UPDATE ON source_connections WHEN json_extract(new.json,'$.kind')='${f.definition.kind}' AND json_extract(old.json,'$.enabled')=0 AND json_extract(new.json,'$.enabled')=1 BEGIN INSERT INTO generated_enable_modes VALUES(json_extract(new.json,'$.initialSync'));END;`);
 await f.click('保存并同步');await f.until(()=>f.node.sources.listSources().some(value=>value.kind===f.definition.kind&&value.status?.coverage?.state==='complete'));
 const source=f.node.sources.listSources().find(value=>value.kind===f.definition.kind)!;assert.equal(source.initialSync,'new_only');assert.equal(source.status?.coverage?.processed,0);assert.equal(f.node.sources.getItem(source.id,f.definition.externalId),undefined,'baseline history cannot be read during a transient default-all window');assert.deepEqual(f.node.store.db.prepare('SELECT mode FROM generated_enable_modes').all().map(value=>value.mode),['new_only']);
 const current=await f.request('/api/connectors/'+provider),selected=current.selected[0];assert.equal(selected.sourceId,source.id);assert.equal(selected.initialSync,'new_only');await f.request('/api/connectors/'+provider+'/select',{selected:[{id:selected.id,type:selected.type}]});assert.equal(f.node.sources.getSource(source.id).initialSync,'new_only','an existing consumer omitting policy preserves the host-owned policy');f.assertPrivate();
});

for(const provider of ['notion','slack','feishu-session'] as const)for(const failure of ['mode','selection','enable'])test(`${provider} ${failure} write failure never starts a new selection with an unconfirmed history policy`,async t=>{
 const f=await fixture(t,provider);await open(f);await choose(f,'new_only');
 const stateKey=provider==='feishu-session'?'feishu-session':provider;
 const sql=failure==='selection'?`CREATE TRIGGER generated_write_failure BEFORE UPDATE ON plugin_instance_state WHEN new.key='${stateKey}' AND json_array_length(json_extract(new.json,'$.selected'))>0 BEGIN SELECT RAISE(ABORT,'generated selection write failure');END;`:`CREATE TRIGGER generated_write_failure BEFORE UPDATE ON source_connections WHEN json_extract(new.json,'$.kind')='${f.definition.kind}' AND ${failure==='enable'?"json_extract(new.json,'$.enabled')=1":"json_extract(new.json,'$.initialSync')='new_only'"} BEGIN SELECT RAISE(ABORT,'generated source write failure');END;`;
 f.node.store.db.exec(sql);await f.click('保存并同步');await f.until(()=>Boolean(f.dom.window.document.querySelector('.official-source-connector [role=alert]')));
 const sources=f.node.sources.listSources().filter(value=>value.kind===f.definition.kind);assert.equal(sources.length,1);assert.equal(sources[0]!.enabled,false);assert.equal(sources[0]!.initialSync,'new_only');assert.equal(f.node.sources.getItem(sources[0]!.id,f.definition.externalId),undefined);assert.equal(f.dom.window.document.body.textContent!.includes('同步范围已保存。'),false);assert.notEqual(sources[0]!.status?.coverage?.state,'complete');
 const status=await f.request('/api/connectors/'+provider);assert.equal(status.selected.length,failure==='enable'?1:0,'failed durable selection cannot remain as a new in-memory scan range');
 f.node.store.db.exec('DROP TRIGGER generated_write_failure');await f.click('保存并同步');await f.until(()=>f.node.sources.getSource(sources[0]!.id).status?.coverage?.state==='complete');assert.equal(f.node.sources.getSource(sources[0]!.id).initialSync,'new_only');assert.equal(f.node.sources.getItem(sources[0]!.id,f.definition.externalId),undefined);f.assertPrivate();
});

for(const provider of ['notion','slack','feishu-session'] as const)test(`${provider} disconnect withdraws an already completed candidate response even when its delivery ignores abort`,async t=>{
 const f=await fixture(t,provider);await open(f);const hold=f.holdNext('/api/connectors/'+provider+'/candidates');await f.click('加载可选内容');await f.until(()=>hold.entered);
 await f.click('断开连接');await f.click('取消');assert.equal((await f.request('/api/connectors/'+provider)).connected,true,'opening and cancelling review has no external effect');
 await f.click('断开连接');await f.click('确认断开');await f.until(async()=>{const status=await f.request('/api/connectors/'+provider);return provider==='feishu-session'?!status.archiveAuthorized:!status.connected;});await f.until(()=>!f.dom.window.document.querySelector('.official-source-connector form'));
 await act(async()=>hold.release());await f.until(()=>!f.dom.window.document.querySelector('.official-source-connector input[type=checkbox]'));assert.equal(f.node.sources.listSources().filter(value=>value.kind===f.definition.kind).length,0);assert.equal(f.dom.window.document.querySelector('.official-source-connector [role=alert]'),null);if(provider==='feishu-session')assert.equal((await f.request('/api/connectors/'+provider)).connected,true,'withdrawing message archiving preserves the shared Lark account binding');f.assertPrivate();
});

for(const provider of ['notion','slack','feishu-session'] as const)test(`${provider} an observed upstream account change retires the former account's late candidate list`,async t=>{
 const f=await fixture(t,provider);await open(f);const before=await f.request('/api/connectors/'+provider),hold=f.holdNext('/api/connectors/'+provider+'/candidates');assert.equal(typeof before.accountId,'string');await f.click('加载可选内容');await f.until(()=>hold.entered);
 await f.replaceAccount();await f.until(()=>{const value=resources(f.api).get<any>('/api/connectors/'+provider).getSnapshot().data;return value?.accountId&&value.accountId!==before.accountId;});
 await act(async()=>hold.release());await act(async()=>new Promise(resolve=>setTimeout(resolve,20)));assert.equal(f.dom.window.document.querySelector('.official-source-connector input[type=checkbox]'),null);assert.equal(f.dom.window.document.querySelector('.official-source-connector [role=alert]'),null);assert.equal(f.node.sources.listSources().filter(value=>value.kind===f.definition.kind).length,0);f.assertPrivate();
});

test('a real old-account read error delivered after account replacement cannot overwrite the current form',async t=>{
 const f=await fixture(t);await open(f);f.provider.notion.state.failRead=true;const hold=f.holdNext('/api/connectors/notion/candidates');await f.click('加载可选内容');await f.until(()=>hold.entered);f.provider.notion.state.failRead=false;const before=(await f.request('/api/connectors/notion')).accountId;
 await f.replaceAccount();await f.until(()=>{const status=resources(f.api).get<any>('/api/connectors/notion').getSnapshot().data;return status?.accountId&&status.accountId!==before;});await act(async()=>hold.release());await act(async()=>new Promise(resolve=>setTimeout(resolve,20)));assert.equal(f.dom.window.document.querySelector('.official-source-connector [role=alert]'),null);assert.match(f.dom.window.document.querySelector('.official-source-connector')!.textContent!,/generated-workspace-B/);assert.equal(f.dom.window.document.querySelector('.official-source-connector input[type=checkbox]'),null);f.assertPrivate();
});

test('restarting and uninstalling the installed package withdraws its former form and delayed successful candidate list',async t=>{
 const f=await fixture(t);await open(f);const hold=f.holdNext('/api/connectors/notion/candidates');await f.click('加载可选内容');await f.until(()=>hold.entered);
 await f.request('/api/plugin-instances/'+f.instance.id+'/disable',{expectedRevision:f.node.pluginCenter.instanceView(f.instance.id).revision,operationId:randomUUID()});await f.until(()=>f.node.pluginCenter.instanceView(f.instance.id).observed==='disabled');
 await f.request('/api/plugin-instances/'+f.instance.id+'/enable',{expectedRevision:f.node.pluginCenter.instanceView(f.instance.id).revision,operationId:randomUUID()});await f.until(()=>f.node.pluginCenter.instanceView(f.instance.id).observed==='ready');await act(async()=>resources(f.api).invalidate(key=>key==='/api/plugins'));await f.until(()=>resources(f.api).get<any>('/api/plugins').getSnapshot().data?.instances[0]?.revision===f.node.pluginCenter.instanceView(f.instance.id).revision);
 await act(async()=>hold.release());await act(async()=>new Promise(resolve=>setTimeout(resolve,20)));assert.equal(f.dom.window.document.querySelector('.official-source-connector input[type=checkbox]'),null,'a restarted instance cannot publish its former candidate response even if the browser never saw the brief disabled state');
 await f.request('/api/plugin-instances/'+f.instance.id+'/disable',{expectedRevision:f.node.pluginCenter.instanceView(f.instance.id).revision,operationId:randomUUID()});await f.until(()=>f.node.pluginCenter.instanceView(f.instance.id).observed==='disabled');
 await f.request('/api/plugins/'+encodeURIComponent(f.instance.packageId)+'/uninstall',{expectedRevision:f.node.pluginCenter.view().revision,operationId:randomUUID()});await act(async()=>resources(f.api).invalidate(key=>key==='/api/plugins'));await f.until(()=>!f.dom.window.document.querySelector('.official-source-connector'));
 assert.equal(f.dom.window.document.querySelector('.official-source-connector'),null);assert.match(f.dom.window.document.body.textContent!,/尚未安装/);assert.equal(f.node.sources.listSources().length,0);f.assertPrivate();
});

test('changing the authenticated Central discards the previous node form and its delayed candidate response',async t=>{
 const f=await fixture(t);await open(f);const hold=f.holdNext('/api/connectors/notion/candidates');await f.click('加载可选内容');await f.until(()=>hold.entered);const next=await f.otherCentral();await f.render(next.api);await f.until(()=>f.dom.window.document.body.textContent!.includes('尚未安装'));
 await act(async()=>hold.release());await act(async()=>new Promise(resolve=>setTimeout(resolve,20)));assert.equal(f.dom.window.document.querySelector('.official-source-connector'),null);assert.equal(next.node.sources.listSources().length,0);assert.equal(f.node.sources.listSources().length,0);f.assertPrivate();
});

test('confirmed Feishu message-read revocation withdraws its saved form and persistent complete coverage without granting sending',async t=>{
 const f=await fixture(t,'feishu-session');await open(f);await choose(f);await f.click('保存并同步');await f.until(()=>f.node.sources.listSources().some(value=>value.kind===f.definition.kind&&value.status?.coverage?.state==='complete'));const source=f.node.sources.listSources().find(value=>value.kind===f.definition.kind)!;
 f.provider.state.scopes=f.provider.state.scopes.filter(scope=>scope!=='im:message:readonly');await f.request('/api/connectors/feishu-session/check',{});await f.refresh();await f.until(()=>!f.dom.window.document.querySelector('.official-source-connector form'));
 const withdrawn=f.node.sources.getSource(source.id);assert.equal(withdrawn.enabled,false);assert.equal(withdrawn.syncScopeVersion,(source.syncScopeVersion??0)+1);assert.equal(withdrawn.syncPolicyVersion,source.syncPolicyVersion);assert.notEqual(withdrawn.status?.coverage?.state,'complete');assert.match(f.node.sources.getItem(source.id,f.definition.externalId)!.text,/Generated actual Feishu body/);f.assertPrivate();
});

test('a pending Feishu read authorization is recoverable from real status after leaving the page and can be cancelled before retry',async t=>{
 const f=await fixture(t,'feishu-session');await f.render();await f.until(()=>Boolean([...f.dom.window.document.querySelectorAll('h3')].find(value=>value.textContent===f.definition.name)));await act(async()=>[...f.dom.window.document.querySelectorAll('h3')].find(value=>value.textContent===f.definition.name)!.closest<HTMLAnchorElement>('a')!.click());await f.until(()=>Boolean([...f.dom.window.document.querySelectorAll('button')].find(value=>value.textContent==='连接账号')));await f.click('连接账号');await f.until(f.provider.authorizationWaiting);await f.until(()=>Boolean(f.dom.window.document.querySelector('.connector-authorization')));
 await act(async()=>{f.dom.window.location.hash='#/connections/add';});await f.until(()=>!f.dom.window.document.querySelector('.official-source-connector'));await act(async()=>{f.dom.window.location.hash='#/connections?setup=official-feishu-session';});await f.until(()=>Boolean(f.dom.window.document.querySelector('.connector-authorization')));assert.equal(f.button('连接账号').disabled,true);f.assertPrivate();await f.click('取消');await f.until(()=>!f.dom.window.document.querySelector('.connector-authorization'));assert.equal((await f.request('/api/connectors/feishu-session')).archiveAuthorized,false);assert.equal(f.node.sources.listSources().length,0);await f.authorize();f.assertPrivate();
});

for(const provider of ['notion','slack','feishu-session'] as const)test(`${provider} failed selection persistence pauses an existing source whose requested history policy changed`,async t=>{
 const f=await fixture(t,provider);await open(f);await choose(f);await f.click('保存并同步');await f.until(()=>f.node.sources.listSources().some(value=>value.kind===f.definition.kind&&value.status?.coverage?.state==='complete'));await f.refresh();await f.until(()=>!f.button('保存并同步').closest('fieldset')!.disabled);
 const source=f.node.sources.listSources().find(value=>value.kind===f.definition.kind)!,stateKey=provider==='feishu-session'?'feishu-session':provider;
 await act(async()=>{const select=f.dom.window.document.querySelector<HTMLSelectElement>('.official-source-connector select')!;select.value='new_only';select.dispatchEvent(new f.dom.window.Event('change',{bubbles:true}));});
 f.node.store.db.exec(`CREATE TRIGGER generated_existing_selection_failure BEFORE UPDATE ON plugin_instance_state WHEN new.key='${stateKey}' AND json_array_length(json_extract(new.json,'$.selected'))>0 BEGIN SELECT RAISE(ABORT,'generated existing selection failure');END;`);
 await f.click('保存并同步');await f.until(()=>Boolean(f.dom.window.document.querySelector('.official-source-connector [role=alert]')));assert.equal(f.node.sources.getSource(source.id).enabled,false,'a failed selection cannot leave its staged new history policy scanning on the old enabled range');assert.equal(f.node.sources.history(source.id,f.definition.externalId).length,1,'the retained original is not removed or rewritten');
 f.node.store.db.exec('DROP TRIGGER generated_existing_selection_failure');await f.click('保存并同步');await f.until(()=>f.node.sources.getSource(source.id).enabled&&f.node.sources.getSource(source.id).status?.coverage?.state==='complete');assert.equal(f.node.sources.getSource(source.id).initialSync,'new_only');f.assertPrivate();
});

for(const provider of ['notion','slack','feishu-session'] as const)test(`${provider} a failed prerequisite pause keeps deselection retryable and cannot confirm the new scope`,async t=>{
 const f=await fixture(t,provider);await open(f);await choose(f);await f.click('保存并同步');await f.until(()=>f.node.sources.listSources().some(value=>value.kind===f.definition.kind&&value.status?.coverage?.state==='complete'));await f.until(()=>!f.button('立即同步').disabled);
 const source=f.node.sources.listSources().find(value=>value.kind===f.definition.kind)!,before=await f.request('/api/connectors/'+provider);
 f.node.store.db.exec(`CREATE TRIGGER generated_removed_pause_failure BEFORE UPDATE ON source_connections WHEN new.id='${source.id}' AND json_extract(new.json,'$.enabled')=0 BEGIN SELECT RAISE(ABORT,'generated removed source pause failure');END;`);
 await act(async()=>f.dom.window.document.querySelector<HTMLInputElement>('.official-source-connector input[type=checkbox]')!.click());await f.click('保存并同步');await f.until(()=>Boolean(f.dom.window.document.querySelector('.official-source-connector [role=alert]'))||f.dom.window.document.body.textContent!.includes('同步范围已保存。'));
 assert.ok(f.dom.window.document.querySelector('.official-source-connector [role=alert]'),'a failed pause must be reported instead of claiming deselection');assert.equal(f.dom.window.document.body.textContent!.includes('同步范围已保存。'),false);
 const failed=await f.request('/api/connectors/'+provider);assert.deepEqual(failed.selected.map((item:any)=>[item.id,item.type,item.sourceId,item.initialSync]),before.selected.map((item:any)=>[item.id,item.type,item.sourceId,item.initialSync]));assert.equal(f.node.sources.getSource(source.id).enabled,true);assert.equal(f.node.sources.getSource(source.id).initialSync,source.initialSync);assert.equal(f.node.sources.history(source.id,f.definition.externalId).length,1);assert.equal(f.dom.window.document.querySelector<HTMLInputElement>('.official-source-connector input[type=checkbox]')!.checked,false,'the unsaved deselection remains available for retry');
 f.node.store.db.exec('DROP TRIGGER generated_removed_pause_failure');await f.click('保存并同步');await f.until(async()=>(await f.request('/api/connectors/'+provider)).selected.length===0);await f.until(()=>f.dom.window.document.body.textContent!.includes('同步范围已保存。'));assert.equal(f.node.sources.getSource(source.id).enabled,false);assert.equal(f.node.sources.getSource(source.id).initialSync,source.initialSync);assert.equal(f.node.sources.history(source.id,f.definition.externalId).length,1);f.assertPrivate();
});
