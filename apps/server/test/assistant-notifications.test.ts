import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import type {QueryScope} from '@mote/shared';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';
import type {AssistantCardPublication} from '../src/assistant-cards.js';

const all:QueryScope={kind:'all'};
const options={backgroundWorker:false,agent:{configured:false,query:async()=>{throw Error('Unexpected model call');},close:async()=>{}}};

async function fixture(t:import('node:test').TestContext,at='2026-11-13T13:50:00.000Z'){
 t.mock.timers.enable({apis:['Date'],now:new Date(at)});
 const directory=mkdtempSync(join(tmpdir(),'mote-assistant-notification-'));
 const config:Config={dataDir:directory,token:'generated-notification-owner',tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:30_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',logLevel:'silent'};
 let node=await buildApp(config,options);
 t.after(async()=>{t.mock.timers.reset();await node.app.close();rmSync(directory,{recursive:true,force:true});});
 const headers={authorization:'Bearer '+config.token};
 const scopeQuery=(scope:QueryScope=all)=>new URLSearchParams({scope:JSON.stringify(scope)});
 const notifications=async(scope:QueryScope=all)=>{
  const response=await node.app.inject({url:'/api/assistant-notifications?'+scopeQuery(scope),headers});assert.equal(response.statusCode,200,response.body);return response.json().items as {id:string;revision:number;title:string;reason:string;eligibleAt:string;expiresAt:string}[];
 };
 const setPreferences=async(value:object)=>{
  const view=await node.app.inject({url:'/api/configuration',headers});assert.equal(view.statusCode,200,view.body);
  const response=await node.app.inject({method:'PUT',url:'/api/configuration/notifications',headers,payload:{revision:view.json().revision,value}});
  assert.equal(response.statusCode,200,response.body);return response.json();
 };
 const capture=async(text:string,deviceId='generated-device')=>{const id=randomUUID();await node.store.ingest({id,deviceId,deviceName:'Generated',platform:'import',source:'note',capturedAt:new Date().toISOString(),durationMs:0,ocrText:text});return id;};
 const publication=(id:string,original:string,version='v1',extra:Partial<AssistantCardPublication>={}):AssistantCardPublication=>({id,kind:'suggestion',matterId:null,version,state:'open',title:'Generated '+version,body:'Generated card content',reminderReason:'Generated reason to remind',evidence:[{id:original,quote:'Generated evidence'}],evidenceDependencies:{version:1,complete:true,ids:[original]},...extra});
 const publish=(input:AssistantCardPublication,revision?:number)=>node.featureServices.assistantCards.publish(input,revision,all,()=>{});
 const feedback=(id:string,revision:number,action:'read'|'later'|'ignore'|'never_remind',until?:string)=>node.featureServices.assistantCards.feedback(id,{expectedRevision:revision,action,...(until?{until}:{})},all);
 const setTime=(iso:string)=>t.mock.timers.setTime(Date.parse(iso));
 return {get node(){return node;},headers,scopeQuery,notifications,setPreferences,capture,publication,publish,feedback,setTime,restart:async()=>{await node.app.close();node=await buildApp(config,options);}};
}

test('quiet hours cross midnight and the frequency limit suppresses closely spaced proposals',async t=>{
 const f=await fixture(t),original=await f.capture('Generated evidence');
 await f.setPreferences({enabled:true,timeZone:'Asia/Shanghai',quietHours:{start:'22:00',end:'07:00'},minIntervalMinutes:60});
 const first=f.publish(f.publication(randomUUID(),original));assert.equal((await f.notifications())[0].id,first.id);
 f.setTime('2026-11-13T14:10:00.000Z');const second=f.publish(f.publication(randomUUID(),original));assert.deepEqual(await f.notifications(),[]);
 f.setTime('2026-11-13T15:20:00.000Z');const quietLatest=f.publish(f.publication(randomUUID(),original));assert.deepEqual(await f.notifications(),[]);
 f.setTime('2026-11-13T22:59:00.000Z');assert.deepEqual(await f.notifications(),[]);
 f.setTime('2026-11-13T23:00:00.000Z');assert.equal((await f.notifications())[0].id,quietLatest.id,'quiet-period candidates coalesce to one current event');
 f.setTime('2026-11-13T23:30:00.000Z');const suppressed=f.publish(f.publication(randomUUID(),original));
 assert.equal((await f.notifications())[0].id,quietLatest.id,'a second proposal inside the interval cannot replace the admitted event');
 f.setTime('2026-11-14T00:01:00.000Z');const next=f.publish(f.publication(randomUUID(),original));assert.equal((await f.notifications())[0].id,next.id);
 assert.equal(f.node.featureServices.assistantCards.get(suppressed.id,all).readAt,null,'suppression never marks or removes the card');
 assert.equal(f.node.featureServices.assistantCards.get(second.id,all).readAt,null);
});

test('card identity and owner feedback control eligibility without creating another unread fact',async t=>{
 const f=await fixture(t,'2026-11-13T10:00:00.000Z'),original=await f.capture('Generated evidence'),id=randomUUID(),input=f.publication(id,original);
 let card=f.publish(input);assert.equal(f.publish(structuredClone(input)).revision,card.revision);
 let [event]=await f.notifications();assert.equal(event.id,id);assert.equal(event.revision,card.revision);const originalEligibleAt=event.eligibleAt;
 assert.deepEqual(await f.notifications(),[event],'polling again is the same persistent event');
 card=f.publish(f.publication(id,original,'v2'),card.revision);[event]=await f.notifications();assert.equal(event.id,id);assert.equal(event.revision,card.revision);
 assert.equal(event.eligibleAt,originalEligibleAt,'a content revision does not create another alert identity');
 assert.equal(card.readAt,null,'showing and updating do not mark the card read');
 card=f.feedback(id,card.revision,'read');assert.deepEqual(await f.notifications(),[]);
 card=f.publish(f.publication(id,original,'v3'),card.revision);assert.ok(card.readAt);assert.deepEqual(await f.notifications(),[],'a content update cannot re-open a read card');
 assert.equal(f.node.featureServices.assistantCards.page({scope:all}).items.filter(item=>item.id===id).length,1);
});

test('later, ignore, never remind, resolution and withdrawal suppress old notifications',async t=>{
 const f=await fixture(t,'2026-11-13T10:00:00.000Z'),original=await f.capture('Generated evidence');
 let card=f.publish(f.publication(randomUUID(),original));card=f.feedback(card.id,card.revision,'later','2026-11-13T11:00:00.000Z');
 assert.deepEqual(await f.notifications(),[]);f.setTime('2026-11-13T11:00:00.000Z');assert.equal((await f.notifications())[0].id,card.id);
 card=f.feedback(card.id,card.revision,'never_remind');assert.deepEqual(await f.notifications(),[]);
 card=f.publish(f.publication(card.id,original,'v2'),card.revision);assert.deepEqual(await f.notifications(),[]);
 f.setTime('2026-11-13T12:01:00.000Z');let ignored=f.publish(f.publication(randomUUID(),original));ignored=f.feedback(ignored.id,ignored.revision,'ignore');assert.deepEqual(await f.notifications(),[]);
 f.setTime('2026-11-13T13:02:00.000Z');let resolved=f.publish(f.publication(randomUUID(),original));resolved=f.publish(f.publication(resolved.id,original,'resolved',{state:'resolved'}),resolved.revision);assert.deepEqual(await f.notifications(),[]);
 f.setTime('2026-11-13T14:03:00.000Z');const withdrawnOriginal=await f.capture('Generated evidence'),withdrawn=f.publish(f.publication(randomUUID(),withdrawnOriginal));assert.equal((await f.notifications())[0].id,withdrawn.id);
 f.node.store.delete(withdrawnOriginal);assert.deepEqual(await f.notifications(),[]);assert.throws(()=>f.node.featureServices.assistantCards.get(withdrawn.id,all),{statusCode:404});
 assert.equal(f.node.store.db.prepare('SELECT private_json FROM assistant_card_versions WHERE card_id=?').get(withdrawn.id)!.private_json,null,'withdrawal removes the stored reminder reason with the card body');
 assert.equal(f.node.featureServices.assistantCards.get(card.id,all).state,'open','suppressing a notification retains the card');
});

test('reconnection projects only the newest timely event, keeps cards and enforces scope',async t=>{
 const f=await fixture(t,'2026-11-13T08:00:00.000Z'),a=await f.capture('Generated evidence','device-a'),b=await f.capture('Generated evidence','device-b');
 const first=f.publish(f.publication(randomUUID(),a));assert.deepEqual((await f.notifications({kind:'all',deviceId:'device-a'})).map(event=>event.id),[first.id]);
 f.setTime('2026-11-13T09:01:00.000Z');const second=f.publish(f.publication(randomUUID(),b));
 f.setTime('2026-11-13T10:02:00.000Z');const latest=f.publish(f.publication(randomUUID(),b));
 f.setTime('2026-11-13T11:00:00.000Z');assert.deepEqual((await f.notifications()).map(event=>event.id),[latest.id]);
 assert.deepEqual(await f.notifications({kind:'all',deviceId:'device-a'}),[],'a notification that missed its interval expires even when its card is still visible');
 assert.deepEqual(await f.notifications({kind:'selection',evidenceIds:[]}),[]);
 assert.equal(f.node.featureServices.assistantCards.page({scope:all}).items.length,3,'a lost OS notification never loses cards');
 f.setTime('2026-11-14T11:00:01.000Z');assert.deepEqual(await f.notifications(),[],'outdated notifications are not replayed');
 assert.equal(f.node.featureServices.assistantCards.get(second.id,all).readAt,null);
 const missing=await f.node.app.inject({url:'/api/assistant-notifications',headers:f.headers});assert.equal(missing.statusCode,400);
 assert.equal((await f.node.app.inject({url:'/api/assistant-notifications?'+f.scopeQuery()})).statusCode,401);
});

test('settings and current notification survive restart, with the original card as authority',async t=>{
 const f=await fixture(t,'2026-11-13T10:00:00.000Z'),original=await f.capture('Generated evidence');
 await f.setPreferences({enabled:true,timeZone:'UTC',quietHours:null,minIntervalMinutes:120});
 const saved=f.publish(f.publication(randomUUID(),original));const before=await f.notifications();assert.equal(before[0].id,saved.id);
 await f.restart();assert.deepEqual(await f.notifications(),before);assert.equal(f.node.featureServices.assistantCards.get(saved.id,all).readAt,null);
});

test('only a proposal with a reason can notify, and an indefinite later or disabled setting preserves the card',async t=>{
 const f=await fixture(t,'2026-11-13T10:00:00.000Z'),original=await f.capture('Generated evidence');
 const withoutReason=f.publication(randomUUID(),original);delete withoutReason.reminderReason;
 const plain=f.publish(withoutReason);assert.deepEqual(await f.notifications(),[]);
 f.setTime('2026-11-13T11:01:00.000Z');let later=f.publish(f.publication(randomUUID(),original));later=f.feedback(later.id,later.revision,'later');
 assert.deepEqual(await f.notifications(),[]);
 f.setTime('2026-11-13T13:00:00.000Z');assert.deepEqual(await f.notifications(),[]);
 f.setTime('2026-11-13T14:00:00.000Z');const active=f.publish(f.publication(randomUUID(),original));assert.equal((await f.notifications())[0].id,active.id);
 await f.setPreferences({enabled:false});assert.deepEqual(await f.notifications(),[]);
 assert.equal(f.node.featureServices.assistantCards.get(plain.id,all).readAt,null);assert.equal(f.node.featureServices.assistantCards.get(active.id,all).readAt,null);
});

test('deferring a displayed event does not erase its frequency reservation',async t=>{
 const f=await fixture(t,'2026-11-13T10:00:00.000Z'),original=await f.capture('Generated evidence');
 let first=f.publish(f.publication(randomUUID(),original));assert.equal((await f.notifications())[0].id,first.id);
 first=f.feedback(first.id,first.revision,'later','2026-11-13T12:00:00.000Z');
 f.setTime('2026-11-13T10:30:00.000Z');const second=f.publish(f.publication(randomUUID(),original));
 assert.deepEqual(await f.notifications(),[],'snoozing does not make another alert eligible within the original interval');
 assert.equal(f.node.featureServices.assistantCards.get(second.id,all).readAt,null);
 f.setTime('2026-11-13T11:01:00.000Z');const third=f.publish(f.publication(randomUUID(),original));assert.equal((await f.notifications())[0].id,third.id);
});

test('a reason added to an unread existing card starts its notification at that version',async t=>{
 const f=await fixture(t,'2026-11-13T08:00:00.000Z'),original=await f.capture('Generated evidence'),input=f.publication(randomUUID(),original);
 delete input.reminderReason;let card=f.publish(input);assert.deepEqual(await f.notifications(),[]);
 f.setTime('2026-11-13T10:00:00.000Z');card=f.publish(f.publication(card.id,original,'v2'),card.revision);
 let [event]=await f.notifications();assert.equal(event.id,card.id);assert.equal(event.eligibleAt,'2026-11-13T10:00:00.000Z');
 f.setTime('2026-11-13T10:10:00.000Z');card=f.publish(f.publication(card.id,original,'v3'),card.revision);
 [event]=await f.notifications();assert.equal(event.eligibleAt,'2026-11-13T10:00:00.000Z');assert.equal(event.revision,card.revision);
});

test('a card resolved during quiet hours cannot displace a still-current quiet-period candidate',async t=>{
 const f=await fixture(t,'2026-11-13T10:10:00.000Z'),original=await f.capture('Generated evidence');
 await f.setPreferences({timeZone:'UTC',quietHours:{start:'10:00',end:'11:00'}});
 const current=f.publish(f.publication(randomUUID(),original));
 f.setTime('2026-11-13T10:20:00.000Z');let resolved=f.publish(f.publication(randomUUID(),original));
 resolved=f.publish(f.publication(resolved.id,original,'resolved',{state:'resolved'}),resolved.revision);
 f.setTime('2026-11-13T11:00:00.000Z');assert.equal((await f.notifications())[0].id,current.id);
});

test('a source revision makes its prior card notification ineligible',async t=>{
 const f=await fixture(t,'2026-11-13T10:00:00.000Z'),sourceId='generated-notification-source';
 f.node.sources.register({id:sourceId,name:'Generated source',kind:'custom',deviceId:'generated-device',platform:'import'});
 const source={externalId:'document',revision:'1',observedAt:'2026-11-13T09:00:00Z',kind:'message' as const,layer:'original' as const,text:'Generated evidence'};
 const first=await f.node.sources.upsert(sourceId,source),card=f.publish(f.publication(randomUUID(),first.id));
 assert.equal((await f.notifications())[0].id,card.id);
 await f.node.sources.upsert(sourceId,{...source,revision:'2',observedAt:'2026-11-13T10:01:00Z',text:'Generated revised evidence'});
 assert.equal(f.node.featureServices.assistantCards.get(card.id,all).state,'stale');assert.deepEqual(await f.notifications(),[]);
});

test('quiet-period coalescing uses the latest reminder proposal, not the card creation date',async t=>{
 const f=await fixture(t,'2026-11-13T09:50:00.000Z'),original=await f.capture('Generated evidence');
 await f.setPreferences({timeZone:'UTC',quietHours:{start:'10:00',end:'11:00'}});
 const input=f.publication(randomUUID(),original);delete input.reminderReason;let older=f.publish(input);
 f.setTime('2026-11-13T10:15:00.000Z');f.publish(f.publication(randomUUID(),original));
 f.setTime('2026-11-13T10:30:00.000Z');older=f.publish(f.publication(older.id,original,'v2'),older.revision);
 f.setTime('2026-11-13T11:00:00.000Z');assert.equal((await f.notifications())[0].id,older.id);
});

test('quiet windows resolve DST gaps and repeated local times using the routine rules',async t=>{
 const f=await fixture(t,'2026-03-08T06:30:00.000Z'),original=await f.capture('Generated evidence');
 await f.setPreferences({enabled:true,timeZone:'America/New_York',quietHours:{start:'01:00',end:'02:30'},minIntervalMinutes:120});
 const gap=f.publish(f.publication(randomUUID(),original));assert.deepEqual(await f.notifications(),[]);
 f.setTime('2026-03-08T07:00:00.000Z');assert.equal((await f.notifications())[0].id,gap.id,'a skipped 02:30 ends at the first valid instant');
 f.setTime('2026-11-01T05:10:00.000Z');await f.setPreferences({quietHours:{start:'00:30',end:'01:30'}});
 const repeated=f.publish(f.publication(randomUUID(),original));assert.deepEqual(await f.notifications(),[]);
 f.setTime('2026-11-01T05:30:00.000Z');assert.equal((await f.notifications())[0].id,repeated.id);
 f.setTime('2026-11-01T06:10:00.000Z');assert.equal((await f.notifications())[0].id,repeated.id,'the second occurrence of 01:10 does not reopen quiet hours');
});

test('invalid preferences are rejected and notifications never expose out-of-scope card content',async t=>{
 const f=await fixture(t,'2026-11-13T10:00:00.000Z'),a=await f.capture('Generated evidence','device-a'),b=await f.capture('Generated evidence','device-b');
 const view=(await f.node.app.inject({url:'/api/configuration',headers:f.headers})).json();
 for(const value of [{timeZone:'+08:00'},{quietHours:{start:'10:00',end:'10:00'}},{minIntervalMinutes:0}]){
  const invalid=await f.node.app.inject({method:'PUT',url:'/api/configuration/notifications',headers:f.headers,payload:{revision:view.revision,value}});assert.equal(invalid.statusCode,400);
 }
 await f.setPreferences({minIntervalMinutes:61});
 const stale=await f.node.app.inject({method:'PUT',url:'/api/configuration/notifications',headers:f.headers,payload:{revision:view.revision,value:{enabled:false}}});assert.equal(stale.statusCode,409);
 const input=f.publication(randomUUID(),b,'mixed',{title:'GENERATED_PRIVATE_TITLE',reminderReason:'GENERATED_PRIVATE_REASON',evidence:[{id:a,quote:'Generated evidence'},{id:b,quote:'Generated evidence'}],evidenceDependencies:{version:1,complete:true,ids:[a,b]}});
 f.publish(input);
 assert.doesNotMatch(JSON.stringify(await f.notifications({kind:'selection',evidenceIds:[b]})),/GENERATED_PRIVATE/);
 assert.equal((await f.notifications())[0].reason,'GENERATED_PRIVATE_REASON');
 let feedbackCard=f.node.featureServices.assistantCards.get(input.id,all);
 feedbackCard=f.feedback(input.id,feedbackCard.revision,'never_remind');
 feedbackCard=f.publish(f.publication(input.id,b,'narrow',{title:'Generated narrow card'}),feedbackCard.revision);
 assert.deepEqual(await f.notifications({kind:'selection',evidenceIds:[b]}),[],'hidden historical no-reminder feedback cannot resurrect an alert');
 assert.deepEqual(f.node.featureServices.assistantCards.get(input.id,{kind:'selection',evidenceIds:[b]}).feedback,[],'hidden feedback is not disclosed');
 f.setTime('2026-11-13T11:02:00.000Z');let changed=f.publish(f.publication(randomUUID(),a,'old',{reminderReason:'GENERATED_HIDDEN_OLD_REASON'}));
 changed=f.publish(f.publication(changed.id,b,'current',{reminderReason:'Generated current reason'}),changed.revision);
 assert.equal((await f.notifications())[0].id,changed.id);
 assert.deepEqual(await f.notifications({kind:'selection',evidenceIds:[b]}),[],'an inaccessible old version cannot be used to invent a fresh event');
 const {invitation}=f.node.connections.invite({serverUrl:'https://fixture.invalid',label:'Generated collector'},'collector');
 const collector=await f.node.connections.redeem({code:invitation.code,deviceId:'generated-collector',deviceName:'Generated',platform:'android'});
 const denied=await f.node.app.inject({url:'/api/assistant-notifications?'+f.scopeQuery(),headers:{authorization:'Bearer '+collector.token}});assert.equal(denied.statusCode,403);
 const deniedSettings=await f.node.app.inject({method:'PUT',url:'/api/configuration/notifications',headers:{authorization:'Bearer '+collector.token},payload:{revision:view.revision,value:{enabled:false}}});assert.equal(deniedSettings.statusCode,403);
});
