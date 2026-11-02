import {gmailContext} from '../src/connectors/gmail-context.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,stat,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {OAuth2Client} from 'google-auth-library';
import {GmailConnector,gmailItems,gmailScope} from '../src/connectors/gmail.js';
import {ArchivedFileStore} from '../src/archived-files.js';
import {Store} from '../src/store.js';
import {SourceStore} from '../src/sources.js';
import type {ConnectorContext} from '../src/connectors/types.js';
import {connectorReader} from './fixtures/connector-reader.js';
import type {GoogleDependencies} from '../src/connectors/google.js';
import {MaterialStore,materialId} from '../src/materials.js';
import {MaterialOrganizerRuntime} from '../src/material-organizers.js';
import {MemoryInputAuthorization} from '../src/memory-input-authorization.js';
import {memoryEvidenceFingerprint} from '../src/memory.js';
import {EvidenceReader} from '../src/evidence-reader.js';
import {ServerDiagnostics} from '../src/diagnostics.js';

const message=(id:string,text=`Generated mail ${id}`,day=0)=>({id,threadId:`thread-${id}`,internalDate:String(Date.UTC(2024,0,1)+day*86400000),labelIds:['INBOX'],payload:{mimeType:'text/plain',headers:[{name:'Subject',value:`Generated ${id}`},{name:'From',value:'fixture@example.invalid'},{name:'Date',value:new Date(Date.UTC(2024,0,1)+day*86400000).toUTCString()}],body:{data:Buffer.from(text).toString('base64url')}}});
async function fixture(t:any,handle:(url:URL,init?:RequestInit)=>Promise<Response>|Response){
  const directory=await mkdtemp(join(tmpdir(),'mote-gmail-'));
  const sourceStore=(store:Store)=>new SourceStore(store,undefined,new MemoryInputAuthorization(store,()=>true));
  let store=new Store(join(directory,'vault')),sources=sourceStore(store);
  const ctx:ConnectorContext={evidenceReader:connectorReader(store,sources),store,sources,config:{dataDir:directory,token:'generated-owner-token-1234567890',allowedOrigins:[],connectors:{directory:join(directory,'credentials'),googleClientId:'generated-client',googleClientSecret:'generated-secret',googleRedirectUri:'http://127.0.0.1/oauth/google/callback'}}};
  const oauth=new OAuth2Client({clientId:'generated-client',redirectUri:ctx.config.connectors!.googleRedirectUri});
  oauth.getToken=(async()=>({tokens:{refresh_token:'generated-refresh-secret',access_token:'generated-access-secret',scope:gmailScope}})) as any;
  oauth.getAccessToken=(async()=>({token:'generated-access-secret'})) as any;
  const deps:GoogleDependencies={oauthFactory:()=>oauth,fetch:(async(input,init)=>{assert.equal(init?.method,'GET');assert.equal(new URL(String(input)).hostname,'gmail.googleapis.com');return handle(new URL(String(input)),init);}) as typeof fetch};
  let context=gmailContext(ctx),connector=new GmailConnector(context,deps);await connector.init();
  t.after(async()=>{await connector.close();store.close();await rm(directory,{recursive:true,force:true});});
  const authorize=async()=>{const url=new URL((await connector.start()).authorizationUrl);assert.equal(url.searchParams.get('scope'),gmailScope);assert.equal(url.searchParams.get('code_challenge_method'),'S256');const state=url.searchParams.get('state')!;await connector.callback(state,'generated-code');return state;};
  return {ctx,get context(){return context;},get sources(){return sources;},get store(){return store;},directory,oauth,authorize,get connector(){return connector;},restart:async(reopen=false)=>{await connector.close();if(reopen){store.close();store=new Store(join(directory,'vault'));sources=sourceStore(store);ctx.store=store;ctx.sources=sources;}context=gmailContext(ctx);connector=new GmailConnector(context,deps);await connector.init();}};
}

test('Gmail history counter and JSON key order replays preserve immutable sources, original assets and Material across storage restart',async t=>{
  let runtime:MaterialOrganizerRuntime;t.after(()=>runtime?.close());
  let current:any={...message('stable','Generated long mail. '.repeat(2000)),historyId:'100',sizeEstimate:42000};
  const f=await fixture(t,url=>{
    const path=url.pathname.split('/me/')[1];
    if(path==='profile')return Response.json({emailAddress:'generated@example.invalid',historyId:'100'});
    if(path==='messages')return Response.json({messages:[{id:current.id}]});
    if(path==='history')return Response.json({history:[{messages:[{id:current.id},{id:current.id}]}],historyId:current.historyId});
    return Response.json(current);
  });
  await f.authorize();assert.equal((await f.connector.sync()).imported,2);
  const source=f.sources.listSources()[0],initial=f.sources.getItem(source.id,'stable:0')!,initialTail=f.sources.getItem(source.id,'stable:1')!;
  const archived=new ArchivedFileStore(f.store),original=archived.read(initial.document!.fileId!);
  const fingerprint=memoryEvidenceFingerprint(f.store.evidence([initial.captureId])[0]);
  const grants=f.store.db.prepare('SELECT * FROM memory_input_authorizations ORDER BY input_key').all();assert.equal(grants.length,2);
  let materials=new MaterialStore(f.store);runtime=new MaterialOrganizerRuntime(f.store,materials);
  const material=async()=>{for(let i=0;i<20;i++){await runtime.tick();const value=materials.get(materialId(source.id,'stable:0'));if(value)return value;}throw Error('Generated Material did not publish');};
  const first=await material(),firstRead=materials.read(first.ref);
  const diagnostics=new ServerDiagnostics({enabled:false,directory:join(f.directory,'diagnostics')});
  const modelRead=()=>new EvidenceReader(f.store,f.sources,undefined,undefined,undefined,materials).agent({diagnostics}).evidence({ids:materials.evidenceIds(first.ref).slice(0,1)});
  const firstModelRead=await modelRead();assert.equal(firstModelRead.length,1);
  assert.deepEqual(firstModelRead[0].provenance?.document?.originalMetadata?.labels,['INBOX']);
  const check=async()=>{
    assert.deepEqual(await f.connector.sync(),{imported:0,duplicates:2,hasMore:false});
    assert.deepEqual(f.sources.getItem(source.id,'stable:0'),initial);
    assert.deepEqual(f.sources.getItem(source.id,'stable:1'),initialTail);
    assert.equal(f.sources.history(source.id,'stable:0').length,1);
    assert.equal(f.store.db.prepare("SELECT count(*) n FROM changes WHERE operation='supersede'").get()!.n,0);
    assert.equal(f.store.db.prepare('SELECT count(*) n FROM archived_files').get()!.n,1);
    assert.deepEqual(f.store.db.prepare('SELECT * FROM memory_input_authorizations ORDER BY input_key').all(),grants);
    assert.equal(memoryEvidenceFingerprint(f.store.evidence([initial.captureId])[0]),fingerprint);
    assert.deepEqual(new ArchivedFileStore(f.store).read(initial.document!.fileId!),original);
    assert.equal((await material()).ref,first.ref);
    assert.deepEqual(materials.read(first.ref),firstRead);
    assert.deepEqual(await modelRead(),firstModelRead);
  };
  current.historyId='101';await check();await check();
  const reverse=(value:any):any=>Array.isArray(value)?value.map(reverse):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).reverse().map(([k,v])=>[k,reverse(v)])):value;
  current=reverse(current);await check();
  await runtime.close();await f.restart(true);materials=new MaterialStore(f.store);runtime=new MaterialOrganizerRuntime(f.store,materials);
  current.historyId='102';await check();
});

test('Gmail keeps genuine state, time, authorship, body and raw attachment changes observable and never revives an old revision',async t=>{
  const base:any={...message('changes'),historyId:'100'};let current=structuredClone(base);
  const f=await fixture(t,url=>{
    const path=url.pathname.split('/me/')[1];
    if(path==='profile')return Response.json({emailAddress:'generated@example.invalid',historyId:'100'});
    if(path==='messages')return Response.json({messages:[{id:current.id}]});
    if(path==='history')return Response.json({history:[{labelsAdded:[{message:{id:current.id}}]}],historyId:'200'});
    return Response.json(current);
  });await f.authorize();await f.connector.sync();
  const source=f.sources.listSources()[0],original=f.sources.getItem(source.id,'changes:0')!;
  const variants:[string,(m:any)=>void][]=[
    ['labels',m=>{m.labelIds=['INBOX','UNREAD'];}],
    ['thread',m=>{m.threadId='another-generated-thread';}],
    ['received time',m=>{m.internalDate=String(Number(m.internalDate)+1000);}],
    ...['Subject','From','To','Cc','Date'].map(name=>[name,(m:any)=>{m.payload.headers=m.payload.headers.filter((h:any)=>h.name!==name);m.payload.headers.push({name,value:name==='Date'?'Tue, 02 Jan 2024 00:00:00 GMT':`Changed ${name}`});}] as [string,(m:any)=>void]),
    ['body',m=>{m.payload.body.data=Buffer.from('Generated changed body').toString('base64url');}],
    ['unprojected header',m=>{m.payload.headers.push({name:'Reply-To',value:'generated-reply@example.invalid'});}],
    ['attachment',m=>{m.payload={mimeType:'multipart/mixed',headers:m.payload.headers,parts:[m.payload,{filename:'generated.pdf',mimeType:'application/pdf',body:{attachmentId:'generated-asset-a',size:100}}]};}],
    ['attachment locator',m=>{m.payload.parts[1].body.attachmentId='generated-asset-b';}],
    ['attachment MIME absent',m=>{delete m.payload.parts[1].mimeType;}],
    ['unknown provider evidence',m=>{m.classificationLabelValues=[{labelId:'generated-policy'}];}],
  ];
  let prior=original;
  for(const [name,change]of variants){
    change(current);current.historyId=String(Number(current.historyId)+1);
    assert.equal((await f.connector.sync()).imported,1,name);
    const next=f.sources.getItem(source.id,'changes:0')!;assert.notEqual(next.revision,prior.revision,name);assert.notEqual(next.captureId,prior.captureId,name);
    assert.deepEqual(JSON.parse(new ArchivedFileStore(f.store).read(next.document!.fileId!).toString()),current,name);
    assert.deepEqual((await f.connector.sync()),{imported:0,duplicates:1,hasMore:false},`${name} duplicate ACK`);
    prior=next;
  }
  current=structuredClone(base);await f.connector.sync();const reverted=f.sources.getItem(source.id,'changes:0')!;
  assert.notEqual(reverted.revision,original.revision);assert.notEqual(reverted.captureId,original.captureId);
  assert.equal(reverted.document!.fileId,original.document!.fileId);
  assert.equal(f.sources.history(source.id,'changes:0').length,variants.length+2);
  assert.equal(f.store.evidence([original.captureId])[0].ocrText,original.text);
});

test('480 generated Gmail messages over 480 days: restart paging, dedupe, delta edits/deletes and expired history rescan',async t=>{
  let history=100,expired=false,failSecond=false;const messages=new Map(Array.from({length:480},(_,i)=>[String(i),message(String(i),undefined,i)]));
  let changes:string[]=[];const requested:string[]=[];
  const f=await fixture(t,url=>{
    const path=url.pathname.split('/me/')[1];requested.push(path);
    if(path==='profile')return Response.json({emailAddress:'generated@example.invalid',historyId:String(history)});
    if(path==='messages'){
      const offset=Number(url.searchParams.get('pageToken')??0);if(offset===100&&failSecond)return new Response('',{status:429});
      const ids=[...messages.keys()],next=offset+100;return Response.json({messages:ids.slice(offset,next).map(id=>({id})),...(next<ids.length?{nextPageToken:String(next)}:{})});
    }
    if(path==='history'){if(expired){expired=false;return new Response('',{status:404});}return Response.json({history:[{messages:changes.map(id=>({id}))}],historyId:String(history)});}
    const value=messages.get(path.split('/')[1]);return value?Response.json(value):new Response('',{status:404});
  });
  const state=await f.authorize();await assert.rejects(f.connector.callback(state,'replay'),/state_invalid/);
  assert.equal((await stat(join(f.directory,'credentials/gmail.json'))).mode&0o777,0o600);
  assert.ok(!JSON.stringify(f.connector.status()).includes('generated-refresh-secret'));
  assert.equal((await f.connector.sync()).imported,100);failSecond=true;await assert.rejects(f.connector.sync(),/rate_limited/);
  await f.restart();failSecond=false;let more=true;while(more)more=(await f.connector.sync()).hasMore;
  const source=f.sources.listSources().find(s=>s.kind==='gmail')!;let cursor:string|undefined;const ids:string[]=[];
  do{const page=f.sources.listItems({sourceId:source.id,limit:137,cursor});ids.push(...page.items.map(i=>i.externalId));cursor=page.nextCursor??undefined;}while(cursor);
  assert.equal(ids.length,480);assert.equal(new Set(ids).size,480);
  assert.equal(f.sources.getItem(source.id,'0:0')!.document!.recordedAt,'2024-01-01T00:00:00.000Z');
  const archived=new ArchivedFileStore(f.store);const original=f.sources.getItem(source.id,'0:0')!;assert.deepEqual(JSON.parse(archived.read(original.document!.fileId!).toString()),messages.get('0'));assert.equal(archived.listForCapture(original.captureId).length,1);
  assert.equal((await f.connector.sync()).imported,0);
  const first=f.sources.getItem(source.id,'1:0')!.revision;
  messages.set('1',message('1','Edited generated mail',1));messages.delete('2');changes=['1','1','2'];history=101;
  await f.connector.sync();assert.notEqual(f.sources.getItem(source.id,'1:0')!.revision,first);assert.equal(f.sources.getItem(source.id,'2:0')!.deleted,true);
  assert.equal((await f.connector.sync()).imported,0,'replayed delta does not create versions');
  messages.set('1',message('1',undefined,1));await f.connector.sync();assert.equal(f.sources.getItem(source.id,'1:0')!.text,'Generated mail 1','provider content reverting still creates a current version');
  expired=true;messages.delete('3');changes=[];assert.equal((await f.connector.sync()).hasMore,true);
  do{more=(await f.connector.sync()).hasMore;}while(more);
  assert.equal(f.sources.getItem(source.id,'3:0')!.deleted,true,'only a complete rescan tombstones missing mail');
  assert.equal(f.sources.listItems({sourceId:source.id,limit:200}).items.length,200);
  const portable=await f.store.exportArchive();const restored=new Store(join(f.directory,'restored'));try{await restored.importArchive(portable);const item=new SourceStore(restored).getItem(source.id,'0:0')!;assert.deepEqual(new ArchivedFileStore(restored).read(item.document!.fileId!),archived.read(original.document!.fileId!));}finally{restored.close();}
  await f.connector.disconnect();assert.equal(f.sources.getSource(source.id).enabled,false);await assert.rejects(readFile(join(f.directory,'credentials/gmail.json')),{code:'ENOENT'});
  assert.ok(requested.every(path=>path==='profile'||path==='messages'||path==='history'||path.startsWith('messages/')));
});

test('Gmail MIME parts retain long original text, headers and attachment references; HTML never executes',()=>{
  const text='合成邮件正文\n'.repeat(17000),m=message('abc',text);const items=gmailItems(m,'2026-09-21T00:00:00Z');
  assert.equal(items.map(i=>i.text).join(''),text);assert.ok(items.length>3);assert.ok(items.every(i=>i.text.length<=32000));
  const html={...message('html'),payload:{mimeType:'multipart/mixed',parts:[{mimeType:'text/html',body:{data:Buffer.from('<script>sendMail()</script><p>Generated content</p>').toString('base64url')}},{filename:'generated.pdf',mimeType:'application/pdf',body:{attachmentId:'attachment-fixture'}}]}};
  const converted=gmailItems(html,'2026-09-21T00:00:00Z')[0];assert.equal(converted.text,'Generated content');assert.equal(converted.document?.attachments?.[0].name,'generated.pdf');assert.equal(converted.document?.attachments?.[0].id,undefined);
  assert.equal(gmailItems(m,'2026-09-21T00:00:00Z',true)[0].text,'');
});

test('Gmail missing scope and revoked authorization never advance checkpoints or expose partial new mail',async t=>{
  let revoked=false;const f=await fixture(t,url=>url.pathname.endsWith('/profile')?Response.json({emailAddress:'generated@example.invalid',historyId:'100'}):new Response('',{status:revoked?403:429}));
  f.oauth.getToken=(async()=>({tokens:{refresh_token:'generated',scope:'https://www.googleapis.com/auth/calendar.events.readonly'}})) as any;
  await assert.rejects(f.authorize(),/scope_missing/);assert.equal(f.connector.status().connected,false);
  f.oauth.getToken=(async()=>({tokens:{refresh_token:'generated',scope:gmailScope}})) as any;
  await f.authorize();revoked=true;await assert.rejects(f.connector.sync(),/permission_required/);assert.equal(f.connector.status().state,'permission_required');
  assert.equal(f.sources.listItems().items.length,0);
  const checkpoint=JSON.parse(await readFile(join(f.directory,'credentials/gmail.json'),'utf8'));assert.equal(checkpoint.historyId,undefined);assert.equal(checkpoint.full.pageToken,undefined);
});

test('disconnect aborts an in-flight Gmail read and prevents late source commits',async t=>{
  let began!:()=>void;const started=new Promise<void>(resolve=>{began=resolve;});
  const f=await fixture(t,async(url,init)=>{
    if(url.pathname.endsWith('/profile'))return Response.json({emailAddress:'generated@example.invalid',historyId:'1'});
    if(url.pathname.endsWith('/messages'))return Response.json({messages:[{id:'late'}]});
    began();await new Promise<void>(resolve=>init?.signal?.addEventListener('abort',()=>resolve(),{once:true}));
    // Even a transport ignoring cancellation must not commit its late response.
    return Response.json(message('late'));
  });
  await f.authorize();const sync=f.connector.sync();const rejected=assert.rejects(sync,/connector_closed/);await started;
  await f.connector.disconnect();await rejected;assert.equal(f.sources.listItems().items.length,0);assert.equal(f.connector.status().connected,false);
  assert.equal(f.sources.listSources()[0].enabled,false);
});


test('Gmail projected capabilities preserve message parts and full-sync membership across reopen without global Store or owner credentials',async t=>{
  const f=await fixture(t,url=>url.pathname.endsWith('/profile')?Response.json({emailAddress:'generated@example.invalid',historyId:'100'}):url.pathname.endsWith('/messages')?Response.json({messages:[{id:'projection'}]}):Response.json(message('projection','Generated original. '.repeat(2000))));
  const context=f.context;
  assert.deepEqual(Object.keys(context).sort(),['archives','configuration','directory','sources','syncState']);
  for(const object of [context,context.sources,context.archives,context.syncState,context.configuration]){
    assert.equal('store' in object,false);assert.equal('token' in object,false);assert.equal('mcpTokens' in object,false);assert.equal('capabilities' in object,false);
  }
  assert.deepEqual(Object.keys(context.sources).sort(),['getItem','getSource','register','reportStatus','update','upsert','upsertBatch']);
  await f.authorize();assert.equal((await f.connector.sync()).imported,2);
  const sourceId=f.sources.listSources()[0].id;
  assert.deepEqual(context.syncState.partIds(sourceId,'projection'),['projection:0','projection:1']);
  assert.deepEqual(context.syncState.partIds(sourceId,'project'),[],'part lookup is an exact message prefix');
  assert.deepEqual(context.syncState.staleMembers(sourceId,'another-epoch'),['projection']);
  const original=f.sources.getItem(sourceId,'projection:0')!.document!.fileId!;
  await f.restart(true);
  assert.deepEqual(f.context.syncState.partIds(sourceId,'projection'),['projection:0','projection:1']);
  assert.ok(f.context.archives.read(original).includes(Buffer.from('projection')));
  f.context.syncState.touchMember(sourceId,'projection','new-epoch');
  assert.deepEqual(f.context.syncState.staleMembers(sourceId,'new-epoch'),[]);
  f.context.syncState.forgetMember(sourceId,'projection');
  assert.deepEqual(f.context.syncState.staleMembers(sourceId,'another-epoch'),[]);
});
