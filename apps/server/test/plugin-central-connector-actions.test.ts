import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';
import {authorizeFixtureModels} from './fixtures/model-authorization.js';
import {hostRun} from './fixtures/host-run.js';

const owner='generated-central-connector-owner';
const headers={authorization:'Bearer '+owner};
const source={sourceId:'generated-source',kind:'custom',deviceId:'generated-input',platform:'import'};
const event={title:'Generated Central appointment',start:'2099-09-18T15:00:00Z',end:'2099-09-18T16:00:00Z',timeZone:'UTC',allDay:false,location:'',description:''};
const command=(expectedRevision:number)=>({operationId:randomUUID(),expectedRevision});
const until=async(check:()=>boolean,message:string)=>{const end=Date.now()+8000;while(!check()){assert.ok(Date.now()<end,message);await new Promise(resolve=>setTimeout(resolve,25));}};

test('the official fixture appears as a Central connector target; message.send stays manual and a calendar write executes through the host with a receipt',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-central-connector-actions-')),config:Config={dataDir:directory,token:owner,tokenPath:join(directory,'owner-token'),host:'127.0.0.1',port:0,profile:'test',tokenFromEnvironment:true,maxStorageBytes:30*1024*1024,maxExportBytes:1024*1024,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'https://api.deepseek.com',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',logLevel:'silent',connectors:{directory:join(directory,'connectors'),mcpEnabled:false,mcpReadToken:'',mcpWriteEnabled:false,mcpWriteToken:'',mcpWriteSourceIds:[]}};
 const text='Generated appointment is scheduled on 18 September 2099.';
 let node=await buildApp(config,{backgroundWorker:false,agent:{configured:true,async close(){},async query(input){
  hostRun(input);const id=input.evidenceIds![0],evidence=[{id,quote:text}];
  if(input.skill==='calendar-extraction')return {runId:randomUUID(),answer:JSON.stringify({actions:[{kind:'calendar.create',event,uncertainty:'',sameAs:null,evidence}]}),citations:[{id,capturedAt:'2026-01-01T00:00:00Z',appName:'Generated',excerpt:text}],trace:[]};
  return {runId:randomUUID(),answer:JSON.stringify({summary:'Generated appointment',evidence,events:[],memoryCandidates:[],actionCues:[{kind:'calendar.create',event,uncertainty:'',evidence}]}),citations:[{id,capturedAt:'2026-01-01T00:00:00Z',appName:'Generated',excerpt:text}],trace:[]};
 }}});
 t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});
 const resolve=await node.app.inject({method:'POST',url:'/api/plugins/resolve',headers,payload:{repository:'mote/official-fixture-connector',tag:'v0.1.0'}});
 assert.equal(resolve.statusCode,200,resolve.body);const preview=resolve.json();
 let view=node.pluginCenter.view();
 assert.equal((await node.app.inject({method:'POST',url:'/api/plugins/install',headers,payload:{...command(view.revision),previewId:preview.id}})).statusCode,200);
 await until(()=>node.pluginCenter.view().packages[0]?.state==='installed','official fixture installs');
 view=node.pluginCenter.view();
 const configured=await node.app.inject({method:'POST',url:'/api/plugin-instances',headers,payload:{...command(view.revision),packageId:view.packages[0]!.id,name:'Generated fixture connector',scope:'default',configuration:{}}});
 assert.equal(configured.statusCode,200,configured.body);const instance=configured.json();
 assert.equal((await node.app.inject({method:'POST',url:'/api/plugin-instances/'+instance.id+'/check',headers,payload:command(instance.revision)})).statusCode,200);
 await until(()=>node.pluginCenter.instanceView(instance.id).observed==='ready','official fixture checks: '+JSON.stringify(node.pluginCenter.instanceView(instance.id)));
 const checked=node.pluginCenter.instanceView(instance.id);
 assert.equal((await node.app.inject({method:'POST',url:'/api/plugin-instances/'+instance.id+'/enable',headers,payload:command(checked.revision)})).statusCode,200);
 await until(()=>{const value=node.pluginCenter.instanceView(instance.id);return value.desired&&value.observed==='ready';},'official fixture enables');

 const inventory=(await node.app.inject({url:'/api/action-capabilities',headers})).json();
 const connectors=inventory.centralConnectors as {name:string;capability:{id:string;version:number};target:any}[];
 assert.deepEqual(connectors.map(item=>item.capability.id).sort(),['calendar.manage','message.send']);
 assert.equal(inventory.executionEnabled,false,'install, check and enable never grant execution');
 const providerFor=(id:string)=>inventory.providers.find((provider:any)=>provider.capability.id===id);
 const choice=(id:string)=>connectors.find(item=>item.capability.id===id)!;
 const save=async(id:string)=>{const capability=choice(id),draft=await node.app.inject({method:'PUT',url:'/api/action-capability-drafts',headers,payload:{...command(0),id:randomUUID(),capability:{id:capability.capability.id,version:capability.capability.version},target:capability.target,inputs:{sources:[source],existingArchived:true,futureInputs:true}}});assert.equal(draft.statusCode,200,draft.body);return draft.json();};
 const grant=async(draft:any,id:string,ack:Record<string,true>)=>{const granted=await node.app.inject({method:'PUT',url:'/api/action-capability-grants',headers,payload:{...command(0),id:randomUUID(),draftId:draft.id,draftRevision:draft.revision,plugin:providerFor(id).identity,...ack}});assert.equal(granted.statusCode,200,granted.body);return granted.json();};

 await authorizeFixtureModels(node);
 node.sources.register({id:source.sourceId,kind:source.kind,name:'Generated source',deviceId:source.deviceId,platform:source.platform});
 const settings=(await node.app.inject({url:'/api/actions',headers})).json();
 assert.equal((await node.app.inject({method:'PUT',url:'/api/actions/settings',headers,payload:{revision:settings.revision,authorizationRevision:settings.authorizationRevision,settings:{enabled:true,timeZone:'UTC',reviewDeviceIds:[]}}})).statusCode,200);
 const record=await node.sources.upsert(source.sourceId,{externalId:randomUUID(),revision:'1',observedAt:'2026-01-01T00:00:00Z',text,title:'Generated original',kind:'message',layer:'original'});
 await node.actions.tick();const action=node.actions.list().find(item=>item.evidence.some(evidence=>evidence.id===record.id));
 assert.ok(action,'the real extraction host publishes a validated proposal');assert.equal(action.status,'proposed');

 const invitation=await node.app.inject({method:'POST',url:'/api/connections/collector-invitations',headers,payload:{serverUrl:'https://generated.invalid',label:'Generated review device'}});
 const paired=await node.app.inject({method:'POST',url:'/api/connections/redeem',payload:{code:invitation.json().invitation.code,deviceId:'generated-review-device',deviceName:'Generated review device',platform:'macos'}});
 const review={authorization:'Bearer '+paired.json().token};
 const tick=async()=>{await node.app.inject({url:'/api/managed-calendar-deliveries',headers:review});};
 const status=async()=>(await node.app.inject({url:'/api/connectors/official-fixture-connector/status',headers})).json();

 const message=await save('message.send');await grant(message,'message.send',{acknowledgeMessageSends:true});
 await tick();
 assert.equal(node.actions.get(action.id).status,'proposed','a message.send grant never auto-sends or auto-writes a calendar');
 assert.equal((await status()).actionCalls,0);

 const calendar=await save('calendar.manage'),calendarGrant=await grant(calendar,'calendar.manage',{acknowledgeCalendarWrites:true});
 await tick();await until(()=>node.actions.get(action.id).status==='succeeded','Central auto dispatch settles');
 const completed=node.actions.get(action.id);
 assert.equal(completed.status,'succeeded');assert.equal(completed.managed?.state,'succeeded');assert.ok(completed.operationId);assert.match(completed.externalId!,/^fixture-event-/);
 assert.equal((completed.target as any).executionLocation,'central-connector');
 assert.equal((await status()).actionCalls,1,'the host dispatched exactly one Central connector write');

 const active=(await node.app.inject({url:'/api/action-capabilities',headers})).json().grants.find((item:any)=>item.capability.id==='calendar.manage'&&item.state==='active');
 assert.equal(active.id,calendarGrant.id);
 assert.equal((await node.app.inject({method:'POST',url:'/api/action-capability-grants/'+calendarGrant.id+'/revoke',headers,payload:{operationId:randomUUID(),expectedRevision:active.revision}})).statusCode,200);
 const secondRecord=await node.sources.upsert(source.sourceId,{externalId:randomUUID(),revision:'1',observedAt:'2026-01-02T00:00:00Z',text,title:'Generated second original',kind:'message',layer:'original'});
 await node.actions.tick();const second=node.actions.list().find(item=>item.evidence.some(evidence=>evidence.id===secondRecord.id));
 assert.ok(second);assert.equal(second.status,'proposed');
 const manual=await node.app.inject({method:'POST',url:'/api/actions/'+second.id+'/confirm',headers,payload:{version:second.version,event:second.event,target:choice('calendar.manage').target}});
 assert.equal(manual.statusCode,200,manual.body);
 await until(()=>node.actions.get(second.id).status==='succeeded','manual Central confirmation dispatches');
 assert.equal((await status()).actionCalls,2,'manual confirmation reuses the host operation and receipt path');
});
