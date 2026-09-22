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
import type {GoogleDependencies} from '../src/connectors/google.js';

const message=(id:string,text=`Generated mail ${id}`,day=0)=>({id,threadId:`thread-${id}`,internalDate:String(Date.UTC(2024,0,1)+day*86400000),labelIds:['INBOX'],payload:{mimeType:'text/plain',headers:[{name:'Subject',value:`Generated ${id}`},{name:'From',value:'fixture@example.invalid'},{name:'Date',value:new Date(Date.UTC(2024,0,1)+day*86400000).toUTCString()}],body:{data:Buffer.from(text).toString('base64url')}}});
async function fixture(t:any,handle:(url:URL,init?:RequestInit)=>Promise<Response>|Response){
  const directory=await mkdtemp(join(tmpdir(),'mote-gmail-')),store=new Store(join(directory,'vault')),sources=new SourceStore(store);
  const ctx:ConnectorContext={store,sources,config:{dataDir:directory,token:'generated-owner-token-1234567890',allowedOrigins:[],connectors:{directory:join(directory,'credentials'),googleClientId:'generated-client',googleClientSecret:'generated-secret',googleRedirectUri:'http://127.0.0.1/oauth/google/callback'}}};
  const oauth=new OAuth2Client({clientId:'generated-client',redirectUri:ctx.config.connectors!.googleRedirectUri});
  oauth.getToken=(async()=>({tokens:{refresh_token:'generated-refresh-secret',access_token:'generated-access-secret',scope:gmailScope}})) as any;
  oauth.getAccessToken=(async()=>({token:'generated-access-secret'})) as any;
  const deps:GoogleDependencies={oauthFactory:()=>oauth,fetch:(async(input,init)=>{assert.equal(init?.method,'GET');assert.equal(new URL(String(input)).hostname,'gmail.googleapis.com');return handle(new URL(String(input)),init);}) as typeof fetch};
  let connector=new GmailConnector(ctx,deps);await connector.init();
  t.after(async()=>{await connector.close();store.close();await rm(directory,{recursive:true,force:true});});
  const authorize=async()=>{const url=new URL((await connector.start()).authorizationUrl);assert.equal(url.searchParams.get('scope'),gmailScope);assert.equal(url.searchParams.get('code_challenge_method'),'S256');const state=url.searchParams.get('state')!;await connector.callback(state,'generated-code');return state;};
  return {ctx,sources,store,directory,oauth,authorize,get connector(){return connector;},restart:async()=>{await connector.close();connector=new GmailConnector(ctx,deps);await connector.init();}};
}

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
