import {holdNextCheckpoint} from './fixtures/plugin-storage.js';
import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildApp} from '../src/app.js';
import type {ConfigurationPlatformOptions} from '../src/config.js';

const readScopes='channels:read,groups:read,im:read,mpim:read,channels:history,groups:history,im:history,mpim:history,users:read';
const epoch=Math.floor(Date.now()/1000)-90*86400;
const ts=(n:number)=>`${epoch+n}.000100`;
type Message={ts:string;text?:string;user?:string;thread_ts?:string;reply_count?:number;edited?:{ts:string}};
function fakeSlack(){
 const calls:URL[]=[];let messages:Message[]=[],team='T1',replyFailure=false,historyFailure=false,lookupPageSize=200;
 const replies=new Map<string,Message[]>(),parents=new Map<string,Message>();
 const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
 const api={calls,replies,parents,setMessages:(value:Message[])=>messages=value,setTeam:(value:string)=>team=value,setReplyFailure:(value:boolean)=>replyFailure=value,setHistoryFailure:(value:boolean)=>historyFailure=value,setLookupPageSize:(value:number)=>lookupPageSize=value,
 fetch:(async(input,init={})=>{
  const url=new URL(input instanceof Request?input.url:String(input));calls.push(url);
  const form=new URLSearchParams(typeof init.body==='string'?init.body:'');
  if(url.pathname==='/api/oauth.v2.access')return json({ok:true,authed_user:{id:'U1',scope:readScopes,access_token:'generated-token-'+team},team:{id:team,name:'Generated '+team}});
  if(url.pathname==='/api/auth.test')return json({ok:true,user_id:'U1',user:'owner',team_id:team,team:'Generated '+team,url:'https://generated.slack.com/'});
  if(url.pathname==='/api/users.info')return json({ok:true,user:{profile:{display_name:url.searchParams.get('user')}}});
  if(url.pathname==='/api/conversations.list')return json({ok:true,channels:[{id:'C1',name:'generated',is_channel:true}],response_metadata:{next_cursor:''}});
  if(!['/api/conversations.history','/api/conversations.replies'].includes(url.pathname))throw Error('Unexpected generated Slack request '+url.pathname+' '+form.toString());
  if(url.pathname.endsWith('.history')&&historyFailure)return json({ok:false,error:'ratelimited'},503);
  if(url.pathname.endsWith('.replies')&&replyFailure)return json({ok:false,error:'ratelimited'},503);
  const thread=url.searchParams.get('ts'),ascending=url.pathname.endsWith('.replies'),limit=Number(url.searchParams.get('limit'));
  const oldest=Number(url.searchParams.get('oldest')??0),latest=Number(url.searchParams.get('latest')??Infinity),inclusive=url.searchParams.get('inclusive')==='true';
  const entries=(ascending?[(parents.get(thread!)??messages.find(value=>value.ts===thread))!,...(replies.get(thread!)??[])]:messages).filter(Boolean).filter(value=>inclusive?Number(value.ts)>=oldest&&Number(value.ts)<=latest:Number(value.ts)>oldest&&Number(value.ts)<latest).sort((a,b)=>ascending?Number(a.ts)-Number(b.ts):Number(b.ts)-Number(a.ts));
  const offset=Number(url.searchParams.get('cursor')?.replace('offset-','')??0),page=entries.slice(offset,offset+(!ascending&&oldest>0?Math.min(limit,lookupPageSize):limit)),next=offset+page.length<entries.length?'offset-'+(offset+page.length):'';
  return json({ok:true,messages:page,has_more:Boolean(next),response_metadata:{next_cursor:next}});
 }) as typeof fetch};return api;
}
async function fixture(t:TestContext,transport=fakeSlack()){
 const root=mkdtempSync(join(tmpdir(),'mote-slack-sync-')),owner='generated-owner-'+randomUUID(),secret='GENERATED_SLACK_'+randomUUID().replaceAll('-','_');process.env[secret]='generated-only';
 const headers={authorization:'Bearer '+owner};
 const config:ConfigurationPlatformOptions={path:(root)+'/mote.yaml',privateCredential:{token:owner,tokenPath:join(root,'owner')},initialDocument:{version:1,revision:0,storage:{dataDir:root,maxExportBytes:1024*1024},server:{host:'127.0.0.1',port:0,profile:'test',allowedOrigins:[]},execution:{insightIntervalHours:0},models:{deployment:{model:'',apiKey:'',allowUnauthenticatedLocal:false,protocol:'deepseek',reasoningEffort:'high'},embedding:{model:'',baseUrl:'',apiKey:''}},diagnostics:{level:'silent'},connectors:{directory:join(root,'connectors'),mcpEnabled:false,mcpReadToken:'',mcpWriteEnabled:false,mcpWriteToken:'',mcpWriteSourceIds:[]}}};
 const boot=()=>buildApp(config,{backgroundWorker:false,connectorTesting:{fetch:transport.fetch},agent:{configured:false,async query(){throw Error('No model in Slack sync fixture');},async close(){}}});
 let node=await boot();t.after(async()=>{await node.app.close();delete process.env[secret];rmSync(root,{recursive:true,force:true});});
 const wait=async(check:()=>boolean)=>{const end=Date.now()+10000;while(!check()){if(Date.now()>end)throw Error('Slack package lifecycle did not settle');await new Promise(resolve=>setTimeout(resolve,10));}};
 const request=async(path:string,payload?:unknown,status=200)=>{const result=await node.app.inject({url:path,headers,...(payload===undefined?{}:{method:'POST' as const,payload})});assert.equal(result.statusCode,status,result.body);return result.json();};
 const preview=await request('/api/plugins/resolve',{repository:'mote/official-slack-connector',tag:'v0.1.0'});
 await request('/api/plugins/install',{previewId:preview.id,expectedRevision:node.pluginCenter.view().revision,operationId:randomUUID()});await wait(()=>node.pluginCenter.view().packages[0]?.state==='installed');
 const instance=await request('/api/plugin-instances',{packageId:node.pluginCenter.view().packages[0]!.id,name:'Generated Slack sync',scope:'default',configuration:{clientId:'generated-id',clientSecret:'${'+secret+'}',redirectUri:'https://central.example/oauth/slack/callback'},expectedRevision:node.pluginCenter.view().revision,operationId:randomUUID()});
 await request('/api/plugin-instances/'+instance.id+'/check',{expectedRevision:instance.revision,operationId:randomUUID()});await wait(()=>node.pluginCenter.instanceView(instance.id).observed==='ready');
 await request('/api/plugin-instances/'+instance.id+'/enable',{expectedRevision:node.pluginCenter.instanceView(instance.id).revision,operationId:randomUUID()});await wait(()=>node.pluginCenter.instanceView(instance.id).desired&&node.pluginCenter.instanceView(instance.id).observed==='ready');
 const connect=async()=>{const start=await request('/api/connectors/slack/start',{}),state=new URL(start.authorizationUrl).searchParams.get('state');const result=await node.app.inject({url:'/oauth/slack/callback?state='+encodeURIComponent(state!)+'&code=generated-read'});assert.equal(result.statusCode,200,result.body);};
 await connect();
 const scan=()=>{const row=node.store.db.prepare("SELECT json FROM plugin_instance_state WHERE key='slack.scan.0'").get();return row?JSON.parse(String(row.json)):undefined;};
 const select=()=>request('/api/connectors/slack/select',{selected:[{id:'C1',type:'channel'}]});await select();
 return {get node(){return node;},transport,headers,request,scan,select,connect,
  source:()=>node.sources.listSources().find(value=>value.kind==='mote.official.slack'&&value.enabled)!,
  async sync(status=200){const before=transport.calls.filter(url=>/conversations\.(history|replies)$/.test(url.pathname)).length;try{return await request('/api/connectors/slack/sync',{},status);}finally{const count=transport.calls.filter(url=>/conversations\.(history|replies)$/.test(url.pathname)).length-before;assert.ok(count<=20,'history progression, thread ownership lookup and replies share the real 20-request budget: '+count);}},
  async restart(){await node.app.close();node=await boot();await wait(()=>node.pluginCenter.instanceView(instance.id).observed==='ready');},
 };
}

test('installed Slack persists the full 20-page history budget and resumes beyond it after restart',async t=>{
 const f=await fixture(t),entries=Array.from({length:4200},(_,i)=>({ts:ts(i+1),user:'U1',text:'Generated historical message '+i}));f.transport.setMessages(entries);
 await f.sync();const source=f.source(),first=f.scan();assert.ok(f.node.sources.getItem(source.id,ts(4200)),'all must archive the selected 90-day-old history rather than silently truncating to 30 days');assert.equal(first.complete,false);assert.equal(first.history.cursor,'offset-4000');assert.equal(first.processed,4000);assert.equal(first.completeThrough,undefined);
 const status=(await f.request('/api/sources')).items.find((value:any)=>value.id===source.id).status;
 assert.equal(status.state,'idle');assert.equal(status.coverage.state,'partial');assert.equal(status.coverage.remaining,null);assert.deepEqual(status.coverage.limitations,['pagination_pending']);
 const calls=f.transport.calls.filter(url=>url.pathname.endsWith('.history'));assert.equal(calls.length,20);assert.ok(calls.every(url=>url.searchParams.get('limit')==='200'&&url.searchParams.get('oldest')==='0'&&url.searchParams.get('inclusive')==='true'));assert.equal(new Set(calls.map(url=>url.searchParams.get('latest'))).size,1);
 assert.equal(f.node.sources.getItem(source.id,ts(1)),undefined,'the oldest page has not been read yet');
 const later=String(Date.parse(first.window.to)/1000+1);f.transport.setMessages([...entries,{ts:later,user:'U1',text:'Generated after the fixed window'}]);
 await f.restart();await f.sync();assert.equal(f.node.sources.getItem(source.id,later),undefined,'new arrivals cannot leak into or move the unfinished fixed window');assert.equal(f.scan().processed,4200);assert.equal(f.scan().complete,true);assert.deepEqual(f.scan().window,first.window);assert.equal(f.scan().completeThrough,first.window.to);assert.equal(f.node.sources.getSource(source.id).status?.coverage?.state,'complete');assert.match(f.node.sources.getItem(source.id,ts(1))!.text,/historical message 0/);
 const records=f.node.store.db.prepare('SELECT COUNT(*) n FROM source_heads WHERE source_id=?').get(source.id)!;assert.equal(records.n,4200);assert.equal(f.node.sources.history(source.id,ts(1)).length,1);
 const sizes=f.node.store.db.prepare('SELECT COUNT(*) n,MAX(bytes) maximum,SUM(bytes) total FROM plugin_instance_state').get()!;assert.equal(sizes.n,2);assert.ok(Number(sizes.maximum)<65536);assert.ok(Number(sizes.total)<1024*1024);
});

test('Slack resumes unfinished 100-message reply pages, retains full tails and replays failed checkpoints once',async t=>{
 const f=await fixture(t),root=ts(1),tail='Generated full tail beyond the former aggregate limit',body='x'.repeat(210000)+tail;
 f.transport.setMessages([{ts:root,user:'U1',text:'Generated root',reply_count:2005}]);f.transport.replies.set(root,Array.from({length:2005},(_,i)=>({ts:ts(i+2),user:'U2',thread_ts:root,text:i===2004?body:'Generated reply '+i})));
 // Existing aggregates in the current source retain their original revision.
 await f.node.sources.upsert(f.source().id,{externalId:root,revision:'generated-old-merged',observedAt:new Date().toISOString(),kind:'message',layer:'snapshot',title:'Generated former aggregate',text:'Generated root\nGenerated first reply'});
 f.node.store.db.exec("CREATE TRIGGER generated_slack_checkpoint BEFORE UPDATE ON plugin_instance_state WHEN new.key='slack.scan.0' AND json_extract(new.json,'$.processed')=100 BEGIN SELECT RAISE(ABORT,'generated checkpoint failure'); END");
 await f.sync(502);assert.equal(f.scan().processed,0);assert.equal(f.scan().thread.cursor,'');assert.equal(f.node.sources.getSource(f.source().id).status?.coverage?.failed,1);assert.equal(f.node.sources.history(f.source().id,root).length,2);
 f.node.store.db.exec('DROP TRIGGER generated_slack_checkpoint');await f.restart();const resumed=await f.sync();assert.equal(resumed.duplicates,100);assert.equal(f.scan().processed,2000);assert.equal(f.scan().complete,false);assert.equal(f.scan().thread.cursor,'offset-2000');const fixed=f.scan().window;
 f.transport.setReplyFailure(true);await f.sync(503);assert.equal(f.scan().thread.cursor,'offset-2000');assert.equal(f.scan().failed,1);assert.equal(f.node.sources.getSource(f.source().id).status?.coverage?.state,'partial');f.transport.setReplyFailure(false);
 await f.restart();await f.sync();assert.equal(f.scan().processed,2006);assert.equal(f.scan().complete,true);assert.deepEqual(f.scan().window,fixed);assert.equal(f.scan().thread,undefined);
 const item=(await f.request('/api/sources/'+f.source().id+'/item?externalId='+encodeURIComponent(ts(2006)))).item;
 assert.ok(item.text.endsWith(tail));assert.ok(item.text.length>200000);assert.equal(item.document.originalMetadata.parentExternalId,root);assert.equal(item.document.originalMetadata.channelId,'C1');assert.equal(item.document.originalMetadata.authorId,'U2');assert.equal(item.document.recordedAt,new Date(Number(ts(2006))*1000).toISOString());assert.match(item.document.originalMetadata.threadUri,/archives\/C1/);assert.equal(f.node.sources.history(f.source().id,ts(2006)).length,1);
 assert.ok(f.transport.calls.filter(url=>url.pathname.endsWith('.replies')).every(url=>url.searchParams.get('limit')==='100'));
});

test('Slack new-only skips baseline root bodies but discovers their later replies on the next fixed-window sweep',async t=>{
 const clock=Date.now();t.mock.timers.enable({apis:['Date'],now:clock});
 const f=await fixture(t),root=ts(1);f.transport.setMessages([{ts:root,user:'U1',text:'Generated old private root',reply_count:0}]);
 const id=f.source().id;let response=await f.node.app.inject({method:'PATCH',url:'/api/sources/'+id,headers:f.headers,payload:{initialSync:'new_only'}});assert.equal(response.statusCode,200,response.body);
 await f.sync();assert.equal(f.scan().processed,0);assert.equal(f.node.sources.getItem(id,root),undefined);const baseline=f.scan().baselineAt,oldWindow=f.scan().window;
 const reply=String((clock+1000)/1000);f.transport.setMessages([{ts:root,user:'U1',text:'Generated old private root',reply_count:1}]);f.transport.replies.set(root,[{ts:reply,user:'U2',thread_ts:root,text:'Generated late reply to old root'}]);
 t.mock.timers.tick(2000);await f.restart();await f.sync();assert.equal(f.scan().baselineAt,baseline);assert.notDeepEqual(f.scan().window,oldWindow);assert.equal(f.scan().processed,1);assert.equal(f.node.sources.getItem(id,root),undefined);const item=f.node.sources.getItem(id,reply)!;assert.match(item.text,/late reply/);assert.doesNotMatch(item.text,/private root/);assert.equal(item.document?.originalMetadata?.parentExternalId,root);assert.equal(f.node.sources.getSource(id).status?.coverage?.state,'complete');
});

for(const failed of [false,true])test(`Slack mode ABA rejects an old ${failed?'failed':'successful'} history response without old writes or coverage`,async t=>{
 const transport=fakeSlack(),delegate=transport.fetch;let armed=false,enter!:()=>void,release!:()=>void;const entered=new Promise<void>(resolve=>enter=resolve),gate=new Promise<void>(resolve=>release=resolve);
 transport.fetch=async(input,init)=>{if(armed&&String(input).includes('/api/conversations.history')){armed=false;enter();await gate;if(failed)return new Response(JSON.stringify({ok:false,error:'rate_limited'}),{status:503});}return delegate(input,init);};
 const f=await fixture(t,transport);transport.setMessages([{ts:ts(1),user:'U1',text:'Generated old range'}]);let running:Promise<unknown>|undefined;
 try{armed=true;running=f.sync(409);await entered;const checkpoint=f.scan(),source=f.source();for(const initialSync of ['new_only','all']){const changed=await f.node.app.inject({method:'PATCH',url:'/api/sources/'+source.id,headers:f.headers,payload:{initialSync}});assert.equal(changed.statusCode,200,changed.body);}release();await running;assert.deepEqual(f.scan(),checkpoint);assert.equal(f.node.sources.getSource(source.id).status?.coverage,undefined);assert.equal(f.node.sources.getItem(source.id,ts(1)),undefined);}
 finally{release();await running?.catch(()=>{});}
});

test('Slack same-channel workspace changes preserve the old archive under its original source',async t=>{
 const f=await fixture(t);f.transport.setMessages([{ts:ts(1),user:'U1',text:'Generated T1 original'}]);await f.sync();const prior=f.source();
 f.transport.setTeam('T2');await f.connect();await f.select();f.transport.setMessages([{ts:ts(1),user:'U1',text:'Generated T2 original'}]);await f.sync();const current=f.source();assert.notEqual(current.id,prior.id);assert.equal(f.node.sources.getSource(prior.id).enabled,false);assert.match(f.node.sources.getItem(prior.id,ts(1))!.text,/T1 original/);assert.match(f.node.sources.getItem(current.id,ts(1))!.text,/T2 original/);assert.equal(f.node.sources.history(prior.id,ts(1)).length,1);assert.equal(f.node.sources.history(current.id,ts(1)).length,1);
});

for(const signal of ['missing','conflict','repeat','invalid_type','terminal_conflict'])test(`Slack ${signal} paging signals fail partial and keep the committed position`,async t=>{
 const transport=fakeSlack(),delegate=transport.fetch;let armed=true;
 transport.fetch=async(input,init)=>{const response=await delegate(input,init);if(armed&&String(input).includes('/api/conversations.history')){const body=await response.json() as any;if(signal==='missing')delete body.has_more;else if(signal==='conflict')body.has_more=true;else if(signal==='invalid_type')body.response_metadata.next_cursor=0;else if(signal==='terminal_conflict')body.response_metadata.next_cursor='unexpected-more';else {body.has_more=true;body.response_metadata.next_cursor='same';}return new Response(JSON.stringify(body));}return response;};
 const f=await fixture(t,transport);transport.setMessages([{ts:ts(1),user:'U1',text:'Generated paging signal'}]);
 if(signal==='repeat'){await f.sync(502);assert.equal(f.scan().history.cursor,'same');}else await f.sync(502);
 assert.equal(f.scan().complete,false);assert.equal(f.scan().completeThrough,undefined);assert.equal(f.scan().failed,1);assert.equal(f.node.sources.getSource(f.source().id).status?.coverage?.state,'partial');armed=false;await f.sync();assert.equal(f.scan().complete,true);
});


test('Slack mode ABA fences source upserts queued behind an earlier write',async t=>{
 const f=await fixture(t);f.transport.setMessages([{ts:ts(1),user:'U1',text:'Generated original before queue'}]);await f.sync();
 const source=f.source(),prior=f.node.sources.getItem(source.id,ts(1))!,version=source.syncScopeVersion??0;
 const {captureId,sourceId,receivedAt,current,...item}=prior;let entered!:()=>void,release!:()=>void,queued!:()=>void,hold=true;
 const gate=new Promise<void>(resolve=>release=resolve),preparing=new Promise<void>(resolve=>entered=resolve),waiting=new Promise<void>(resolve=>queued=resolve),prepare=f.node.store.prepare.bind(f.node.store),upsert=f.node.sources.upsert.bind(f.node.sources);
 t.mock.method(f.node.store,'prepare',async(raw:unknown)=>{if(hold){hold=false;entered();await gate;}return prepare(raw);});
 const blocker=upsert(source.id,item,()=>{f.node.sources.assertSyncScope(source.id,version);}).then(()=>{throw Error('The queued old scope must fail');},error=>assert.equal(error.statusCode,409));
 let running:Promise<unknown>|undefined;
 try{
  await preparing;f.transport.setMessages([{ts:ts(1),user:'U1',text:'Generated edit forbidden after range change',edited:{ts:ts(2)}}]);
  t.mock.method(f.node.sources,'upsert',(...args:Parameters<typeof upsert>)=>{queued();return upsert(...args);});running=f.sync(409);await waiting;const checkpoint=f.scan();
  for(const initialSync of ['new_only','all']){const response=await f.node.app.inject({method:'PATCH',url:'/api/sources/'+source.id,headers:f.headers,payload:{initialSync}});assert.equal(response.statusCode,200,response.body);}
  release();await blocker;await running;assert.deepEqual(f.scan(),checkpoint);assert.equal(f.node.sources.getSource(source.id).status?.coverage,undefined);assert.equal(f.node.sources.history(source.id,ts(1)).length,1);assert.equal(f.node.sources.getItem(source.id,ts(1))?.captureId,prior.captureId);
 }finally{release();await blocker;await running?.catch(()=>{});}
});

test('Slack checkpoint CAS rechecks the real host range after the plugin precheck',async t=>{
 const held=holdNextCheckpoint(t,'slack.scan.0');
 const f=await fixture(t);f.transport.setMessages([{ts:ts(1),user:'U1',text:'Generated legal archive before CAS'}]);const source=f.source();
 let running:Promise<unknown>|undefined;
 try{running=f.sync(409);const condition=await Promise.race([held.entered,running.then(()=>assert.fail('The real checkpoint CAS was not reached'))]);assert.deepEqual(condition,{sourceId:source.id,syncScopeVersion:source.syncScopeVersion??0});const checkpoint=f.scan();assert.ok(f.node.sources.getItem(source.id,ts(1)),'an archive committed before the range change remains valid');for(const initialSync of ['new_only','all']){const changed=await f.node.app.inject({method:'PATCH',url:'/api/sources/'+source.id,headers:f.headers,payload:{initialSync}});assert.equal(changed.statusCode,200,changed.body);}held.release();await running;assert.deepEqual(f.scan(),checkpoint);assert.equal(f.node.sources.getSource(source.id).status?.coverage,undefined);assert.equal(f.node.sources.history(source.id,ts(1)).length,1);}
 finally{held.release();await running?.catch(()=>{});}
});

test('Slack all-history review discovers later replies without rewriting a complete parent as an aggregate',async t=>{
 const f=await fixture(t),root=ts(1);f.transport.setMessages([{ts:root,user:'U1',text:'Generated complete parent'}]);await f.sync();const first=f.scan().completeThrough,id=f.source().id;
 f.transport.setMessages([{ts:root,user:'U1',text:'Generated complete parent',reply_count:1}]);f.transport.replies.set(root,[{ts:ts(2),thread_ts:root,user:'U2',text:'Generated later response'}]);await f.sync();assert.ok(f.scan().completeThrough>=first);assert.equal(f.scan().processed,2);assert.match(f.node.sources.getItem(id,ts(2))!.text,/later response/);assert.equal(f.node.sources.history(id,root).length,1);assert.doesNotMatch(f.node.sources.getItem(id,root)!.text,/later response/);
});

test('Slack missing reply body remains partial until the complete independent message is available',async t=>{
 const f=await fixture(t),root=ts(1);f.transport.setMessages([{ts:root,user:'U1',text:'Generated complete parent',reply_count:1}]);f.transport.replies.set(root,[{ts:ts(2),thread_ts:root,user:'U2'}]);await f.sync(502);
 assert.equal(f.scan().complete,false);assert.equal(f.scan().processed,0);assert.equal(f.scan().failed,1);assert.deepEqual(f.node.sources.getSource(f.source().id).status?.coverage?.limitations,['pagination_pending','content_partial']);assert.equal(f.node.sources.getItem(f.source().id,ts(2)),undefined);
 f.transport.replies.set(root,[{ts:ts(2),thread_ts:root,user:'U2',text:'Generated recovered full body'}]);await f.sync();assert.equal(f.scan().processed,2);assert.equal(f.scan().complete,true);assert.equal(f.node.sources.getSource(f.source().id).status?.coverage?.state,'complete');assert.match(f.node.sources.getItem(f.source().id,ts(2))!.text,/recovered full body/);
});


test('Slack orphan broadcast references recover full root and replies once through the installed package',async t=>{
 const f=await fixture(t),root=ts(1),first=ts(2),last=ts(3),id=f.source().id;
 f.transport.setMessages([{ts:first,thread_ts:root,user:'U2',text:'Generated pointer only, not the full first reply'},{ts:last,thread_ts:root,user:'U3',text:'Generated pointer only, not the full last reply'}]);
 f.transport.parents.set(root,{ts:root,user:'U1',text:'Generated full orphan root',reply_count:2});
 f.transport.replies.set(root,[{ts:first,thread_ts:root,user:'U2',text:'Generated first full reply from replies API'},{ts:last,thread_ts:root,user:'U3',text:'Generated last full reply from replies API'}]);
 await f.sync();assert.equal(f.scan().complete,true);assert.equal(f.scan().processed,3);assert.equal(f.node.sources.getSource(id).status?.coverage?.processed,3);
 assert.match(f.node.sources.getItem(id,root)!.text,/full orphan root/);assert.match(f.node.sources.getItem(id,first)!.text,/first full reply from replies API/);assert.match(f.node.sources.getItem(id,last)!.text,/last full reply from replies API/);assert.doesNotMatch(f.node.sources.getItem(id,last)!.text,/pointer only/);assert.equal(f.node.sources.getItem(id,last)!.document?.originalMetadata?.parentExternalId,root);
 await f.sync();assert.equal(f.scan().processed,3);for(const externalId of [root,first,last])assert.equal(f.node.sources.history(id,externalId).length,1,'multiple pointers and root traversal do not create duplicate source revisions');
 const replies=f.transport.calls.filter(url=>url.pathname.endsWith('.replies'));assert.equal(replies.length,2,'one canonical thread traversal per fixed-window scan');assert.ok(replies.every(url=>url.searchParams.get('ts')===root));
});


test('Slack multiple roots and broadcasts resume ownership and reply phases under one 20-request budget',async t=>{
 const f=await fixture(t),a=ts(1),b=ts(2);f.transport.setLookupPageSize(1);
 const fillers=Array.from({length:23},(_,i)=>({ts:ts(100+i),user:'U1',text:'Generated unrelated visible message '+i}));
 f.transport.setMessages([...fillers,{ts:ts(40),thread_ts:a,user:'U2',text:'Generated second A pointer'},{ts:ts(39),thread_ts:a,user:'U2',text:'Generated first A pointer'},{ts:ts(30),thread_ts:b,user:'U3',text:'Generated B pointer'},{ts:b,thread_ts:b,user:'U1',text:'Generated B root',reply_count:0}]);
 f.transport.parents.set(a,{ts:a,user:'U1',text:'Generated A root outside history',reply_count:2});
 f.transport.replies.set(a,[{ts:ts(39),thread_ts:a,user:'U2',text:'Generated first A complete reply'},{ts:ts(40),thread_ts:a,user:'U2',text:'Generated second A complete reply'}]);
 f.transport.replies.set(b,[{ts:ts(29),thread_ts:b,user:'U3',text:'Generated first B complete reply'},{ts:ts(30),thread_ts:b,user:'U3',text:'Generated second B complete reply'}]);
 await f.sync();assert.equal(f.scan().processed,23);assert.equal(f.scan().thread.phase,'owner');assert.equal(f.scan().thread.cursor,'offset-19');assert.equal(f.scan().completeThrough,undefined);const window=f.scan().window;
 let rounds=1;while(!f.scan().complete&&rounds<20){await f.restart();await f.sync();assert.deepEqual(f.scan().window,window);rounds++;}
 assert.ok(rounds>2&&rounds<20,'all bounded continuations must advance to completion');assert.equal(f.scan().complete,true);assert.equal(f.scan().processed,29);assert.equal(f.scan().completeThrough,window.to);
 const id=f.source().id;assert.equal(f.node.store.db.prepare('SELECT COUNT(*) n FROM source_heads WHERE source_id=?').get(id)!.n,29);
 for(const externalId of [a,b,ts(29),ts(30),ts(39),ts(40)])assert.equal(f.node.sources.history(id,externalId).length,1);
 assert.match(f.node.sources.getItem(id,ts(40))!.text,/second A complete reply/);assert.match(f.node.sources.getItem(id,ts(30))!.text,/second B complete reply/);
 assert.ok(f.transport.calls.filter(url=>url.pathname.endsWith('.history')).every(url=>url.searchParams.get('limit')==='200'),'short provider pages do not shrink the requested history page size');
});


// Slack permits null, absent and empty-metadata terminal cursor forms.
// See https://docs.slack.dev/apis/web-api/pagination/#just-the-facts
for(const phase of ['history','replies'])for(const shape of ['null','absent','empty-metadata'])
test(`Slack ${phase} accepts an official ${shape} terminal cursor`,async t=>{
 const transport=fakeSlack(),delegate=transport.fetch;
 transport.fetch=async(input,init)=>{
  const response=await delegate(input,init),url=new URL(String(input));
  if(!url.pathname.endsWith('.'+phase))return response;
  const body=await response.json() as any;
  if(body.has_more===false){if(shape==='null')body.response_metadata.next_cursor=null;else if(shape==='empty-metadata')body.response_metadata={};else delete body.response_metadata;}
  return new Response(JSON.stringify(body),{status:response.status,headers:{'content-type':'application/json'}});
 };
 const f=await fixture(t,transport),root=ts(1),reply=ts(2);
 transport.setMessages([{ts:root,user:'U1',text:'Generated complete root',...(phase==='replies'?{reply_count:1}:{})}]);
 if(phase==='replies')transport.replies.set(root,[{ts:reply,thread_ts:root,user:'U2',text:'Generated complete reply'}]);
 const result=await f.node.app.inject({method:'POST',url:'/api/connectors/slack/sync',headers:f.headers,payload:{}});
 assert.equal(result.statusCode,200,result.body);
 assert.equal(f.scan().complete,true);assert.equal(f.scan().processed,phase==='replies'?2:1);assert.equal(f.scan().history.cursor,'');assert.equal(f.scan().completeThrough,f.scan().window.to);
 assert.equal(f.node.sources.getSource(f.source().id).status?.coverage?.state,'complete');
 assert.match(f.node.sources.getItem(f.source().id,phase==='replies'?reply:root)!.text,/Generated complete/);
});
