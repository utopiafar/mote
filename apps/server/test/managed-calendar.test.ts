import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture,owner,text,event,command} from './fixtures/managed-calendar.js';

test('actual HTTP grant dispatches to the paired native consumer and Central retains the same successful action exactly once',async t=>{
 const f=await fixture(t),action=await f.add();assert.equal((await f.request('/api/managed-calendar-deliveries',undefined,f.paired.token)).items.length,0);assert.equal(f.nativeCalls,0);
 await f.grant();const queued=await f.request('/api/managed-calendar-deliveries',undefined,f.paired.token);assert.equal(queued.items.length,1);assert.equal(queued.manualReviewAllowed,false);assert.equal(f.node.actions.get(action.id).managed?.state,'waiting_device');assert.equal(f.node.actions.get(action.id).status,'approved');
 await assert.rejects(()=>f.request('/api/actions/'+action.id+'/claim',{deviceId:'generated-device'},owner),{status:403},'legacy owner channel cannot bypass the grant');
 await f.client().deliver();const result=f.node.actions.get(action.id);assert.equal(result.id,action.id);assert.equal(result.status,'succeeded');assert.equal(result.externalId,'generated-event-1');assert.equal(result.managed?.state,'succeeded');
 await f.client().deliver();assert.equal(f.nativeCalls,1);assert.equal((await f.request('/api/actions')).items[0].externalId,'generated-event-1');
});

test('offline native receipt survives consumer reconstruction, scope withdrawal and OS permission loss without another write',async t=>{
 const f=await fixture(t),grant=await f.grant(),action=await f.add();f.blockReceipts(true);await assert.rejects(()=>f.client().deliver());assert.equal(f.nativeCalls,1);assert.equal(f.node.actions.get(action.id).status,'executing');
 await f.request('/api/action-capability-grants/'+grant.id+'/revoke',command(grant.revision));f.setPermission('required');f.blockReceipts(false);
 await f.client().deliver();assert.equal(f.nativeCalls,1);assert.equal(f.node.actions.get(action.id).status,'succeeded');assert.equal((await f.request('/api/action-capabilities')).grants[0].state,'revoked');
});

test('cancel before claim prevents writing; cancel during native work records the late successful receipt honestly',async t=>{
 const f=await fixture(t);await f.grant();const first=await f.add();await f.request('/api/managed-calendar-deliveries',undefined,f.paired.token);
 await f.request('/api/managed-calendar/'+first.id+'/cancel',{version:f.node.actions.get(first.id).version});await f.client().deliver();assert.equal(f.nativeCalls,0);assert.equal(f.node.actions.get(first.id).managed?.state,'cancelled');
 const next=await f.add();let entered!:()=>void,release!:()=>void;const started=new Promise<void>(resolve=>entered=resolve),hold=new Promise<void>(resolve=>release=resolve);f.onNative(async()=>{entered();await hold;});const running=f.client().deliver();await Promise.race([started,running.then(()=>{throw Error('Native write was not entered');})]);
 try{await f.request('/api/managed-calendar/'+next.id+'/cancel',{version:f.node.actions.get(next.id).version});assert.equal(f.node.actions.get(next.id).managed?.state,'cancel_requested');}finally{release();}await running;
 const result=f.node.actions.get(next.id);assert.equal(result.status,'succeeded');assert.ok(result.managed?.cancelRequestedAt);assert.equal(f.nativeCalls,1);
});

test('future-input scope uses first Central receipt, while plugin withdrawal fences an already queued action',async t=>{
 const f=await fixture(t),old=await f.add();await f.grant(false,true);const fresh=await f.add();const queue=await f.request('/api/managed-calendar-deliveries',undefined,f.paired.token);
 assert.deepEqual(queue.items.map((item:any)=>item.id),[fresh.id]);assert.equal(f.node.actions.get(old.id).status,'proposed');
 await f.request('/api/plugin-instances/'+f.instance.id+'/disable',command(f.node.pluginCenter.instanceView(f.instance.id).revision));
 await assert.rejects(()=>f.request('/api/managed-calendar/'+fresh.id+'/claim',{deviceId:'generated-device'},f.paired.token),{status:403});await f.client().deliver();assert.equal(f.nativeCalls,0);
});


test('Central restart preserves a queued operation and an in-flight receipt without granting a second write',async t=>{
 const f=await fixture(t);await f.grant();const a=await f.add();await f.request('/api/managed-calendar-deliveries',undefined,f.paired.token);const queued=f.node.actions.get(a.id);
 await f.restart();assert.equal(f.node.actions.get(a.id).operationId,queued.operationId);assert.equal(f.node.actions.get(a.id).managed?.state,'waiting_device');
 f.blockReceipts(true);await assert.rejects(()=>f.client().deliver());assert.equal(f.nativeCalls,1);
 await f.restart();f.blockReceipts(false);await f.client().deliver();assert.equal(f.nativeCalls,1);assert.equal(f.node.actions.get(a.id).status,'succeeded');
 const nearby=await f.request('/api/actions/by-evidence/'+a.evidence[0].id);assert.equal(nearby.items[0].id,a.id);assert.equal(nearby.items[0].status,'succeeded');assert.equal(nearby.items[0].evidence,undefined);assert.equal((await f.request('/api/actions/'+a.id)).id,a.id);
});

test('foreign devices cannot claim or receive action content, collectors cannot grant, and revoked connections cannot return receipts',async t=>{
 const f=await fixture(t);const grant=await f.grant(),a=await f.add();await f.request('/api/managed-calendar-deliveries',undefined,f.paired.token);
 const invitation=await f.request('/api/connections/collector-invitations',{serverUrl:'https://generated.invalid',label:'Generated other device'}),other=await f.request('/api/connections/redeem',{code:invitation.invitation.code,deviceId:'generated-other',deviceName:'Other generated',platform:'macos'});
 assert.deepEqual((await f.request('/api/managed-calendar-deliveries',undefined,other.token)).items,[]);
 await assert.rejects(()=>f.request('/api/managed-calendar/'+a.id+'/claim',{},other.token),{status:403});
 await assert.rejects(()=>f.request('/api/action-capability-grants',{},f.paired.token,'PUT'),{status:403});
 await assert.rejects(()=>f.request('/api/action-capability-grants/'+grant.id+'/revoke',command(grant.revision),f.paired.token),{status:403});
 const claims=await Promise.all([1,2].map(()=>f.request('/api/managed-calendar/'+a.id+'/claim',{},f.paired.token)));assert.deepEqual(claims.map(c=>c.mutationAllowed).sort(),[false,true]);
 await f.node.connections.revoke(f.paired.credentialId);
 await assert.rejects(()=>f.request('/api/managed-calendar/'+a.id+'/receipt',{operationId:claims[0].operationId,status:'succeeded',externalId:'generated'},f.paired.token),{status:401});assert.equal(f.node.actions.get(a.id).status,'executing');
});

test('overlapping grants retain manual review and multi-source evidence cannot escape the authorized scope',async t=>{
 const f=await fixture(t),first=await f.grant(),second=await f.grant(),a=await f.add();await f.client().deliver();assert.equal(f.nativeCalls,0);assert.equal(f.node.actions.get(a.id).status,'proposed');
 await f.request('/api/action-capability-grants/'+second.id+'/revoke',command(second.revision));
 await f.request('/api/sources',{id:'generated-outside',kind:'custom',name:'Outside fixture',deviceId:'generated-input',platform:'import'});
 // Authorize model reading of both generated sources, while calendar write grants stay on generated-source only.
 const authorization=await f.request('/api/model-authorization');
 await f.request('/api/model-authorization/commands',{revision:authorization.authorization.revision,operationId:randomUUID(),action:'on'});
 const outside=await f.node.sources.upsert('generated-outside',{externalId:'outside',revision:'1',observedAt:'2026-01-01T00:00:00Z',text,title:'Generated outside',kind:'message',layer:'original'});
 // A validated multi-source proposal is the input to the deterministic permission gate.
 // Keep the original real extraction and append a current fixture evidence snapshot.
 await f.node.actions.tick();const outsideAction=f.node.actions.list().find(x=>x.evidence.some(e=>e.id===outside.id))!;assert.ok(outsideAction);
 const record=f.node.store.db.prepare('SELECT json FROM action_proposals WHERE id=?').get(a.id)!;const proposal=JSON.parse(String(record.json));proposal.evidence.push(outsideAction.evidence[0]);f.node.store.db.prepare('UPDATE action_proposals SET json=? WHERE id=?').run(JSON.stringify(proposal),a.id);
 assert.equal(f.node.actions.get(a.id).status,'proposed','multi-source evidence must be current before testing scope');await f.client().deliver();assert.equal(f.nativeCalls,0);assert.equal(f.node.actions.get(a.id).status,'proposed');assert.equal(first.state,'active');
});


test('attempting crash with a lost native result only reconciles after restart and grant withdrawal',async t=>{
 const f=await fixture(t),grant=await f.grant(),a=await f.add();f.onNative(async()=>{f.setNativePresent();throw Error('Generated crash after native commit');});
 await assert.rejects(()=>f.client().deliver());assert.equal(f.nativeCalls,1);assert.equal(f.node.actions.get(a.id).status,'uncertain');
 await f.request('/api/action-capability-grants/'+grant.id+'/revoke',command(grant.revision));await f.restart();await f.client().deliver();
 assert.equal(f.nativeCalls,1);assert.equal(f.reconciliations,1);assert.equal(f.node.actions.get(a.id).status,'succeeded');
});

test('queued expired events and changed original evidence cannot obtain a new native mutation',async t=>{
 const f=await fixture(t);await f.grant();const expired=await f.add();await f.request('/api/managed-calendar-deliveries',undefined,f.paired.token);
 const a=f.node.actions.get(expired.id);a.event={...a.event,start:'2000-01-01T12:00:00Z',end:'2000-01-01T13:00:00Z'};f.node.store.db.prepare('UPDATE action_proposals SET json=? WHERE id=?').run(JSON.stringify(a),a.id);
 await assert.rejects(()=>f.request('/api/managed-calendar/'+a.id+'/claim',{},f.paired.token),{status:409});
 const changed=await f.add();await f.request('/api/managed-calendar-deliveries',undefined,f.paired.token);const record=f.node.actions.read([changed.evidence[0].id])[0];
 await f.node.sources.upsert('generated-source',{externalId:record.provenance!.externalId,revision:'2',observedAt:'2026-01-02T00:00:00Z',text:'Generated replacement without an event',title:'Changed original',kind:'message',layer:'original'});
 await assert.rejects(()=>f.request('/api/managed-calendar/'+changed.id+'/claim',{},f.paired.token));assert.equal(f.nativeCalls,0);assert.equal(f.node.actions.get(changed.id).status,'stale');
});

test('scoped updates and cancellations reach the real device consumer once, always on the original calendar and event',async t=>{
 const f=await fixture(t);await f.grant();const original=await f.add();await f.client().deliver();
 const created=f.node.actions.get(original.id);assert.equal(created.status,'succeeded');
 await f.grant(true,true,'generated-other-calendar');
 const update=await f.change(created,'calendar.update');await f.client().deliver();
 const updated=f.node.actions.get(update.id),current=f.node.actions.get(original.id);
 assert.equal(updated.status,'succeeded');assert.equal(updated.managed?.state,'succeeded');assert.equal(updated.externalId,created.externalId);
 assert.equal(current.event.start,'2099-09-19T15:00:00Z');assert.equal(current.nativeOperationId,updated.operationId);
 assert.equal(f.nativeChanges[0].calendarId,created.target!.calendarId);assert.equal(f.nativeChanges[0].externalId,created.externalId);
 assert.ok(f.nativeChanges[0].description.includes('[Mote:'+original.id+']'));assert.ok(f.nativeChanges[0].expected.description.includes('[Mote-operation:'+created.operationId+']'));
 const cancel=await f.change(current,'calendar.cancel');f.blockReceipts(true);await assert.rejects(()=>f.client().deliver());assert.equal(f.nativeCalls,3);
 await f.restart();f.blockReceipts(false);await f.client().deliver();await f.client().deliver();
 assert.equal(f.nativeCalls,3);assert.equal(f.node.actions.get(original.id).resolution,'cancelled');assert.equal(f.node.actions.get(cancel.id).status,'succeeded');assert.equal(f.node.actions.get(cancel.id).externalId,created.externalId);
});

test('completion changes only the Mote resolution, and targetless proposals are resolved locally without guessing a device',async t=>{
 const f=await fixture(t);await f.grant();const native=await f.add();await f.client().deliver();const complete=await f.change(f.node.actions.get(native.id),'calendar.complete');
 await f.client().deliver();assert.equal(f.node.actions.get(complete.id).status,'succeeded');assert.equal(f.node.actions.get(complete.id).managed?.state,'succeeded');assert.equal(f.node.actions.get(native.id).resolution,'completed');assert.equal(f.nativeCalls,1);assert.equal(f.nativeChanges.length,0);
 for(const kind of ['calendar.update','calendar.cancel','calendar.complete'] as const){
  const original=await f.add();f.node.actions.dismiss(original.id,original.version);const before=f.node.actions.get(original.id),change=await f.change(before,kind);
  const queue=await f.request('/api/managed-calendar-deliveries',undefined,f.paired.token);
  assert.equal(f.node.actions.get(change.id).status,'succeeded');assert.equal(f.node.actions.get(change.id).target,undefined);assert.equal(f.node.actions.get(original.id).target,undefined);assert.ok(!queue.items.some((item:any)=>item.id===change.id));
  if(kind==='calendar.update')assert.equal(f.node.actions.get(original.id).event.start,'2099-09-19T15:00:00Z');
  else assert.equal(f.node.actions.get(original.id).resolution,kind==='calendar.cancel'?'cancelled':'completed');
 }
 assert.equal(f.nativeCalls,1);
});

test('a managed change cannot claim after destination substitution, relation change, grant withdrawal or expiry',async t=>{
 for(const mutation of ['target','relation','revoke','expiry'] as const){
  const f=await fixture(t),grant=await f.grant(),original=await f.add();await f.client().deliver();const change=await f.change(f.node.actions.get(original.id),'calendar.update');
  await f.request('/api/managed-calendar-deliveries',undefined,f.paired.token);const queued=f.node.actions.get(change.id);
  if(mutation==='target'){queued.target!.calendarId='generated-other-calendar';f.node.store.db.prepare('UPDATE action_proposals SET json=? WHERE id=?').run(JSON.stringify(queued),queued.id);}
  if(mutation==='relation')f.node.store.db.prepare("UPDATE action_proposals SET json=json_set(json,'$.version',json_extract(json,'$.version')+1) WHERE id=?").run(original.id);
  if(mutation==='revoke')await f.request('/api/action-capability-grants/'+grant.id+'/revoke',command(grant.revision));
  if(mutation==='expiry'){queued.event={...queued.event,start:'2000-01-01T12:00:00Z',end:'2000-01-01T13:00:00Z'};f.node.store.db.prepare('UPDATE action_proposals SET json=? WHERE id=?').run(JSON.stringify(queued),queued.id);}
  await assert.rejects(()=>f.request('/api/managed-calendar/'+change.id+'/claim',{},f.paired.token));assert.equal(f.nativeCalls,1);
 }
});

test('native identity or content changes leave cancellation uncertain, while withdrawn scope only reconciles an interrupted change',async t=>{
 const f=await fixture(t),grant=await f.grant(),original=await f.add();await f.client().deliver();const cancel=await f.change(f.node.actions.get(original.id),'calendar.cancel');f.setChangedNative();
 await assert.rejects(()=>f.client().deliver());assert.equal(f.node.actions.get(cancel.id).status,'uncertain');assert.equal(f.node.actions.get(original.id).resolution,undefined);assert.equal(f.nativeCalls,1,'the native boundary refused the changed original');
 await f.request('/api/action-capability-grants/'+grant.id+'/revoke',command(grant.revision));await f.restart();await assert.rejects(()=>f.client().deliver());assert.equal(f.nativeCalls,1);
 const g=await fixture(t),ggrant=await g.grant(),other=await g.add();await g.client().deliver();const update=await g.change(g.node.actions.get(other.id),'calendar.update');g.onNative(async()=>{throw Error('Generated interruption after native change');});
 await assert.rejects(()=>g.client().deliver());assert.equal(g.nativeCalls,2);await g.request('/api/action-capability-grants/'+ggrant.id+'/revoke',command(ggrant.revision));await g.restart();g.onNative(async()=>{});await g.client().deliver();
 assert.equal(g.nativeCalls,2);assert.equal(g.reconciliations,1);assert.equal(g.node.actions.get(update.id).status,'succeeded');assert.equal(g.nativeChanges.at(-1).mutationAllowed,false);
});
