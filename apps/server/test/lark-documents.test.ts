import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.js';
import {SourceStore} from '../src/sources.js';
import {FileStore} from '../src/files.js';
import {LarkConnector,LARK_SCOPES} from '../src/connectors/lark.js';
import {larkArguments,type LarkCommand,type LarkRunner} from '../src/connectors/lark-cli.js';
import {ConnectorError,type ConnectorContext} from '../src/connectors/types.js';
import type {LarkSelection} from '@mote/shared';
const json=JSON.stringify;
const url=(id:string)=>`https://fixture.feishu.cn/docx/${id}`;
const selection:LarkSelection={documents:[],calendarIds:[],pastDays:30,futureDays:90,timeZone:'Asia/Shanghai',autoSync:true,documentDiscovery:{created:true,edited:true,opened:true,firstSyncDays:30}};
async function done(c:LarkConnector){for(let n=0;n<500;n++){if(!['running','waiting'].includes(c.status().job?.state??''))return c.status();await new Promise(r=>setTimeout(r,2));}throw Error('connector did not settle');}
async function fixture(t:any){
 const dir=await mkdtemp(join(tmpdir(),'mote-lark-docs-')),store=new Store(join(dir,'vault')),sources=new SourceStore(store),files=new FileStore(store,sources);
 const ctx:ConnectorContext={store,sources,files,config:{dataDir:dir,token:'fixture-owner-token-12345678901234567890',allowedOrigins:[]}},calls:LarkCommand[]=[];
 const state={account:'fixture-user',content:new Map([['DocumentDiary123','# Generated diary\nI prepared an outline and felt calmer.'],['DocumentMeeting123','# Generated meeting\nTeam agreed on read-only sync.']]),fail:new Set<string>(),searchPages:[] as Array<{results:Array<any>;has_more:boolean;page_token?:string}>,searchFailureToken:undefined as string|undefined,afterFetch:undefined as (()=>void)|undefined};
 const runner:LarkRunner=async command=>{
  calls.push(command);
  switch(command.kind){
   case 'version':return 'lark-cli version 1.0.85';
   case 'status':return json({appId:'cli_fixture',identities:{user:{available:true,openId:state.account,scope:[...LARK_SCOPES,'drive:drive:readonly','calendar:calendar:readonly'].join(' ')}}});
   case 'login':return json({verification_url:'https://accounts.feishu.cn/authorize?fixture',device_code:'fixture-private-code',expires_in:600});
   case 'complete':return '{}';
   case 'calendars':return json({data:{calendar_list:[{calendar_id:'GeneratedCalendar123',role:'owner'}],has_more:false}});
   case 'events':return json({data:{items:[]}});
   case 'documents-search':if(command.pageToken&&state.searchFailureToken===command.pageToken)throw new ConnectorError('lark_command_failed');return json(state.searchPages[command.pageToken?Number(command.pageToken):0]??{results:[],has_more:false});
   case 'document':{const id=command.document.split('/').at(-1)!;if(state.fail.has(id))throw new ConnectorError('lark_permission_required');state.afterFetch?.();return json({data:{document:{document_id:id,revision_id:1,title:id,content:state.content.get(id)??'Generated fixture body'}}});}
   case 'folder-list':return json({data:{files:[{token:'DocumentDiary123',type:'docx',name:'Generated diary'},{token:'OtherSheet123',type:'sheet',name:'Referenced sheet'}],has_more:false}});
   case 'wiki-node':return json({data:{node:{node_token:'WikiRootFixture123',obj_type:'docx',obj_token:'DocumentDiary123',space_id:'fixture-space',has_child:false}}});
   default:return '{}';
  }
 };
 const c=new LarkConnector(ctx,runner);await c.init();await c.refresh();c.login();assert.equal((await done(c)).job?.state,'completed');
 t.after(async()=>{await c.close();await files.close();store.close();await rm(dir,{recursive:true,force:true});});
 return {dir,store,sources,files,ctx,c,runner,calls,state};
}
function matches(...ids:string[]){return {results:ids.map(id=>({title:`Generated ${id}`,result_meta:{url:url(id)}})),has_more:false};}

test('fixed native discovery operations are read-only and never request a calendar scope for documents',()=>{
 const command:LarkCommand={kind:'documents-search',action:'created',start:'2026-10-01T00:00:00.000Z',end:'2026-10-15T00:00:00.000Z',pageToken:'opaque; $(ignored)'};
 const args=larkArguments(command);assert.ok(args.includes('--created-by-me'));assert.ok(args.includes('--created-since'));assert.ok(args.includes('--created-until'));assert.equal(args[args.indexOf('--page-token')+1],command.pageToken);assert.ok(args.includes('user'));assert.ok(!args.includes('--mine'));
 for(const action of ['edited','opened'] as const){const a=larkArguments({...command,action});assert.ok(a.includes(`--${action}-since`));assert.ok(!a.includes('--created-by-me'));}
});

test('scope preview reads metadata only; first confirmation archives generated bodies and bounded activity independently',async t=>{
 const f=await fixture(t);assert.equal(f.sources.listSources().length,0);assert.ok(!f.calls.find(c=>c.kind==='login')!.scopes.includes('calendar:calendar:readonly'));
 f.c.startSync(undefined,true);await done(f.c);assert.equal(f.sources.listSources().length,0);assert.equal(f.calls.some(c=>c.kind==='documents-search'),false);
 f.state.searchPages=[matches('DocumentDiary123','DocumentMeeting123')];await f.c.select(selection);f.c.startSync(undefined,true);await done(f.c);assert.equal(f.calls.some(c=>c.kind==='document'),false);assert.equal(f.c.status().lastSyncAt,undefined);f.c.startPreview();let status=await done(f.c);assert.equal(status.documentSync?.previewTotal,2);assert.equal(f.calls.filter(c=>c.kind==='documents-search').length,3);
 assert.equal(f.calls.some(c=>c.kind==='document'),false);assert.equal(f.sources.listItems().items.length,0);
 f.state.fail.add('DocumentMeeting123');f.c.startSync();status=await done(f.c);assert.equal(status.job?.error,'lark_partial_failure');assert.equal(status.documentSync?.failed,1);assert.equal(status.documentSync?.pending,1);
 const source=f.sources.listSources()[0],items=f.sources.listItems({sourceId:source.id}).items;
 assert.equal(items.filter(i=>i.kind==='file').length,1);assert.ok(items.filter(i=>i.kind==='event').length===6);
 const opened=items.find(i=>i.document?.activity?.action==='opened')!;assert.equal(opened.document?.activity?.evidenceBasis,'search-predicate');assert.ok(opened.document?.activity?.limitations?.includes('provider-open-may-include-connector-access'));assert.equal(opened.document?.recordedAt,undefined);assert.ok(opened.text.includes('human reading is not established'));assert.equal(items.find(i=>i.kind==='file')?.document?.contentRole,'other');
 f.state.fail.clear();f.c.startSync(url('DocumentMeeting123'));status=await done(f.c);assert.equal(status.job?.state,'completed');assert.equal(status.documentSync?.failed,0);assert.equal(f.sources.listItems({kind:'file'}).items.length,2);
});

for(const calendarState of ['idle','syncing'] as const)test(`retrying one document preserves source failure with calendar state ${calendarState} until every failed document is recovered`,async t=>{
 const f=await fixture(t),ids=['DocumentDiary123','DocumentMeeting123'];
 await f.c.select({...selection,documentDiscovery:undefined,documents:ids.map(url),calendarIds:['GeneratedCalendar123']});
 f.c.startSync();let status=await done(f.c);assert.equal(status.job?.state,'completed');
 const source=f.sources.listSources().find(source=>source.kind==='lark-docs')!,lastSyncAt=status.lastSyncAt;assert.ok(lastSyncAt);
 for(const id of ids)f.state.fail.add(id);
 f.c.startSync();status=await done(f.c);assert.equal(status.job?.error,'lark_partial_failure');assert.equal(status.documentSync?.failed,2);
 const calendar=f.sources.listSources().find(source=>source.kind==='lark-calendar')!;
 if(calendarState==='syncing')f.sources.reportStatus(calendar.id,{state:'syncing'});
 const calendarStatus=f.sources.getSource(calendar.id).status;
 f.state.fail.delete(ids[0]);f.c.startSync(url(ids[0]));status=await done(f.c);
 assert.equal(status.documentSync?.failed,1);assert.equal(status.documentSync?.pending,1);
 assert.equal(status.job?.state,'failed');assert.equal(status.job?.error,'lark_partial_failure');
 assert.equal(f.sources.getSource(source.id).status?.state,'error');assert.equal(f.sources.getSource(source.id).status?.code,'lark_partial_failure');
 assert.equal(f.sources.getSource(source.id).status?.lastSyncAt,undefined,'a successful individual retry is not a successful source sync');
 assert.equal(status.lastSyncAt,lastSyncAt,'remaining failed documents must not advance connector success time');
 assert.deepEqual(f.sources.getSource(calendar.id).status,calendarStatus,'a document retry does not sync or fail an unrelated calendar');
 f.state.fail.delete(ids[1]);f.c.startSync(url(ids[1]));status=await done(f.c);
 assert.equal(status.job?.state,'completed');assert.equal(status.documentSync?.failed,0);assert.equal(status.documentSync?.pending,0);
 assert.equal(f.sources.getSource(source.id).status?.state,'idle');assert.ok(f.sources.getSource(source.id).status?.lastSyncAt);assert.ok(status.lastSyncAt);
 assert.deepEqual(f.sources.getSource(calendar.id).status,calendarStatus,'recovering the last document does not leave an unrelated calendar syncing');
 for(const id of ids)assert.equal(f.sources.history(source.id,id).length,1,'retries preserve archived document revisions');
});

test('pagination resumes the exact fixed predicate after restart, including earlier successful discoveries',async t=>{
 const f=await fixture(t);await f.c.select({...selection,documentDiscovery:{created:false,edited:true,opened:false,firstSyncDays:30}});
 f.state.searchPages=[{...matches('DocumentDiary123'),has_more:true,page_token:'1'},matches('DocumentMeeting123')];f.state.searchFailureToken='1';f.c.startPreview();assert.equal((await done(f.c)).job?.state,'failed');
 const attempted=f.calls.filter(c=>c.kind==='documents-search');assert.equal(attempted.length,2);await f.c.close();f.state.searchFailureToken=undefined;
 const resumed=new LarkConnector(f.ctx,f.runner);await resumed.init();t.after(()=>resumed.close());resumed.startPreview();assert.equal((await done(resumed)).job?.state,'completed');
 const requests=f.calls.filter(c=>c.kind==='documents-search');assert.equal(requests[2].pageToken,'1');assert.equal(requests[2].start,requests[1].start);assert.equal(requests[2].end,requests[1].end);assert.equal(resumed.status().documentSync?.previewTotal,2);
 resumed.startSync();await done(resumed);assert.equal(f.sources.listItems({kind:'file'}).items.length,2);
});

test('settings and reauthorization preserve owner pause; a pause during fetch fences late publication',async t=>{
 const f=await fixture(t);await f.c.select({...selection,documentDiscovery:undefined,documents:[url('DocumentDiary123')]});const source=f.sources.listSources()[0];f.sources.update(source.id,{enabled:false});
 await f.c.select({...selection,documentDiscovery:undefined,documents:[url('DocumentDiary123'),'DocumentMeeting123']});assert.equal(f.sources.getSource(source.id).enabled,false);
 f.c.login();await done(f.c);assert.equal(f.sources.getSource(source.id).enabled,false);
 f.sources.update(source.id,{enabled:true});f.state.afterFetch=()=>f.sources.update(source.id,{enabled:false});f.c.startSync();assert.equal((await done(f.c)).job?.state,'failed');assert.equal(f.sources.listItems().items.length,0);
});

test('account changes while a body is read cannot publish a late snapshot',async t=>{
 const f=await fixture(t);await f.c.select({...selection,documentDiscovery:undefined,documents:[url('DocumentDiary123')]});f.state.afterFetch=()=>{f.state.account='other-account';};f.c.startSync();assert.equal((await done(f.c)).job?.error,'lark_account_changed');assert.equal(f.sources.listItems().items.length,0);
});

test('explicit folder and wiki roots share canonical document identity; exact exclusions are enforced',async t=>{
 const f=await fixture(t);const pins={...selection,documentDiscovery:undefined,documents:[url('DocumentDiary123')],folders:['FolderFixture123'],wikiRoots:['https://fixture.feishu.cn/wiki/WikiRootFixture123']};await f.c.select(pins);f.c.startSync();assert.equal((await done(f.c)).job?.state,'completed');const source=f.sources.listSources()[0];assert.equal(f.sources.listItems({kind:'file'}).items.length,1);assert.equal(f.sources.history(source.id,'DocumentDiary123').length,1);
 await f.c.select({...pins,excludedDocuments:['https://fixture.feishu.cn/wiki/WikiRootFixture123']});const before=f.calls.filter(c=>c.kind==='document').length;f.c.startSync();await done(f.c);assert.equal(f.calls.filter(c=>c.kind==='document').length,before);
});

test('large generated Markdown uses the existing original-file upload lifecycle with its complete bytes',async t=>{
 const f=await fixture(t),body='# Generated long document\n\n'+('cell | value\n'.repeat(12000));f.state.content.set('DocumentDiary123',body);await f.c.select({...selection,documentDiscovery:undefined,documents:[url('DocumentDiary123')]});f.c.startSync();assert.equal((await done(f.c)).job?.state,'completed');
 const source=f.sources.listSources()[0],item=f.sources.getItem(source.id,'DocumentDiary123')!;assert.equal(item.layer,'original');assert.equal(item.text,'');const row=f.store.db.prepare('SELECT object_hash,manifest FROM file_versions WHERE capture_id=?').get(item.captureId) as {object_hash:string;manifest:string};assert.equal(JSON.parse(row.manifest).sizeBytes,Buffer.byteLength(body));assert.equal(f.store.assets.read(row.object_hash).toString(),body);
 f.c.startSync();assert.equal((await done(f.c)).job?.result?.duplicates,1);assert.equal(f.sources.history(source.id,'DocumentDiary123').length,1);
});

test('overlapping polls across hour boundaries do not turn one provider signal into multiple activities',async t=>{
 const f=await fixture(t);f.state.searchPages=[matches('DocumentDiary123')];await f.c.select({...selection,documentDiscovery:{created:false,edited:false,opened:true,firstSyncDays:30}});
 // Keep new Date() observations and Date.now() validation on the same fixture clock.
 let clock=Date.parse('2026-10-15T10:13:00.000Z');t.mock.timers.enable({apis:['Date'],now:clock});
 f.c.startSync();await done(f.c);assert.equal(f.sources.listItems({kind:'event'}).items.length,1);
 clock+=20*60000;t.mock.timers.setTime(clock);f.c.startSync();await done(f.c);assert.equal(f.sources.listItems({kind:'event'}).items.length,1);
 clock+=40*60000;t.mock.timers.setTime(clock);f.c.startSync();await done(f.c);assert.equal(f.sources.listItems({kind:'event'}).items.length,1);
 assert.equal(f.sources.listItems({kind:'file'}).items.length,1);
 // Polls still fetch current body, without keeping a once-opened document pinned forever.
 assert.equal(f.calls.filter(c=>c.kind==='document').length,3);
});

test('a changed CLI account cannot contaminate durable metadata discoveries under the old actor',async t=>{
 const f=await fixture(t);await f.c.select({...selection,documentDiscovery:{created:false,edited:true,opened:false,firstSyncDays:30}});f.state.searchPages=[matches('DocumentDiary123')];
 const runner:LarkRunner=async(command,options)=>{const output=await f.runner(command,options);if(command.kind==='documents-search')f.state.account='wrong-fixture-account';return output;};
 await f.c.close();const changed=new LarkConnector(f.ctx,runner);await changed.init();t.after(()=>changed.close());changed.startPreview();assert.equal((await done(changed)).job?.error,'lark_account_changed');assert.equal(changed.status().documentSync?.previewTotal,undefined);assert.equal(changed.status().documentSync?.documents,0);
 f.state.account='fixture-user';changed.startSync();await done(changed);assert.equal(f.sources.listItems({kind:'event'}).items.length,0);
});

test('more than thirty explicit documents are accepted without a lifetime discovery quota',async t=>{
 const f=await fixture(t);await f.c.select({...selection,documentDiscovery:undefined,documents:Array.from({length:35},(_,i)=>url(`DocumentFixture${String(i).padStart(3,'0')}`))});f.c.startSync();assert.equal((await done(f.c)).job?.state,'completed');assert.equal(f.sources.listItems({kind:'file',limit:100}).items.length,35);
});

test('existing snapshot retention is preserved and a long body can be retried after explicit archive consent',async t=>{
 const f=await fixture(t);await f.c.select({...selection,documentDiscovery:undefined,documents:[url('DocumentDiary123')]});const source=f.sources.listSources()[0];f.sources.update(source.id,{retention:'snapshot'});f.state.content.set('DocumentDiary123','Generated long fixture. '.repeat(6000));f.c.startSync();assert.equal((await done(f.c)).documentSync?.errors[0]?.code,'lark_document_archive_required');assert.equal(f.sources.getSource(source.id).retention,'snapshot');assert.equal(f.sources.listItems({kind:'file'}).items.length,0);
 f.sources.update(source.id,{retention:'archive'});f.c.startSync(url('DocumentDiary123'));assert.equal((await done(f.c)).job?.state,'completed');assert.equal(f.sources.listItems({kind:'file'}).items.length,1);
});

test('forgetting a generated long document also blocks later short versions and activity until explicit allow-again',async t=>{
 const f=await fixture(t);f.state.content.set('DocumentDiary123','Generated long fixture. '.repeat(6000));await f.c.select({...selection,documentDiscovery:undefined,documents:[url('DocumentDiary123')]});f.c.startSync();await done(f.c);const source=f.sources.listSources()[0],item=f.sources.getItem(source.id,'DocumentDiary123')!;f.files.forget(item.captureId);
 f.state.content.set('DocumentDiary123','Generated short replacement must stay forgotten.');f.state.searchPages=[matches('DocumentDiary123')];await f.c.select({...selection,documentDiscovery:{created:true,edited:true,opened:true,firstSyncDays:30},documents:[url('DocumentDiary123')]});f.c.startPreview();let status=await done(f.c);assert.equal(status.documentSync?.previewTotal,0);f.c.startSync();await done(f.c);assert.equal(f.sources.listItems().items.length,0);
 f.store.db.prepare('DELETE FROM file_forgotten WHERE source_id=? AND external_id=?').run(source.id,'DocumentDiary123');f.c.startSync();status=await done(f.c);assert.equal(status.job?.state,'completed');assert.equal(f.sources.listItems({kind:'file'}).items[0]?.text,'Generated short replacement must stay forgotten.');
});

test('replaying an accepted immutable activity repairs the overlap ledger after an interrupted checkpoint',async t=>{
 const f=await fixture(t);f.state.searchPages=[matches('DocumentDiary123')];await f.c.select({...selection,documentDiscovery:{created:false,edited:false,opened:true,firstSyncDays:30}});f.c.startSync();await done(f.c);const activity=f.sources.listItems({kind:'event'}).items[0].document!.activity!;
 const key=f.store.db.prepare("SELECT account,scope FROM lark_document_sync WHERE key='confirmed'").get() as {account:string;scope:string};f.store.db.prepare("DELETE FROM lark_document_sync WHERE key LIKE 'signal:%'").run();f.store.db.prepare('INSERT OR REPLACE INTO lark_document_sync VALUES(?,?,?,?)').run(key.account,key.scope,'pending:DocumentDiary123',JSON.stringify({reference:url('DocumentDiary123'),activities:[{action:'opened',start:activity.time.start,end:activity.time.end,observedAt:activity.observedAt}]}));
 f.c.startSync(url('DocumentDiary123'));await done(f.c);assert.ok(f.store.db.prepare("SELECT 1 FROM lark_document_sync WHERE key LIKE 'signal:%'").get());f.c.startSync();await done(f.c);assert.equal(f.sources.listItems({kind:'event'}).items.length,1);
});

test('a generated long Feishu Markdown becomes complete readable Material and eligible automatic personal Memory through real processing',async t=>{
 const {buildApp}=await import('../src/app.js'),{materialId}=await import('../src/materials.js');
 const f=await fixture(t),directory=await mkdtemp(join(tmpdir(),'mote-lark-long-material-')),owner='generated-long-document-owner-token';
 const body='# Generated long Feishu document\n\n| Milestone | Status |\n| --- | --- |\n| Intake | Verified |\n\n'+Array.from({length:6500},(_,i)=>`Generated paragraph ${i}: this is synthetic evidence.\n`).join('')+'\nTAIL_GENERATED_ACCEPTANCE_MARKER: the end is preserved.\n';
 f.state.content.set('DocumentDiary123',body);let modelCalls=0;
 const config:import('../src/config.js').Config={dataDir:directory,token:owner,tokenPath:join(directory,'token'),host:'127.0.0.1',port:0,maxStorageBytes:50_000_000,maxExportBytes:2_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'generated-disabled',modelProvider:'custom',modelProtocol:'openai-completions',modelBaseUrl:'http://127.0.0.1:1234/v1',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false};
 const node=await buildApp(config,{backgroundWorker:false,connectorTesting:{lark:f.runner},agent:{configured:false,query:async()=>{modelCalls++;throw Error('No semantic model belongs in this deterministic long-document test');},close:async()=>{}}});await node.app.ready();
 t.after(async()=>{await node.app.close();await rm(directory,{recursive:true,force:true});});
 const request=async(method:'GET'|'POST'|'PUT',path:string,payload?:unknown)=>{const response=await node.app.inject({method,url:path,headers:{authorization:'Bearer '+owner},...(payload===undefined?{}:{payload:payload as any})});assert.equal(response.statusCode,200,response.body);return response.json();};
 const settle=async()=>{for(let i=0;i<500;i++){const status=await request('GET','/api/connectors/lark');if(!['running','waiting'].includes(status.job?.state??'')){assert.equal(status.job?.state,'completed',JSON.stringify(status));return;}await new Promise(resolve=>setTimeout(resolve,2));}throw Error('Generated connector did not settle');};
 await request('POST','/api/connectors/lark/check');await request('POST','/api/connectors/lark/login');await settle();await request('PUT','/api/connectors/lark/selection',{...selection,documentDiscovery:undefined,documents:[url('DocumentDiary123')],autoSync:false});await request('POST','/api/connectors/lark/preview');await settle();await request('POST','/api/connectors/lark/sync');await settle();
 const source=node.sources.listSources().find(item=>item.kind==='lark-docs')!,original=node.sources.getItem(source.id,'DocumentDiary123')!;assert.equal(original.text,'');assert.equal(original.layer,'original');assert.ok(body.length>100000);
 // Use the same text processor and organizer scheduling as the background worker.
 await node.materialOrganizer.tick(100);await node.processing.tick();
 for(let i=0;i<20;i++){await node.materialOrganizer.tick(100);if(!node.materialOrganizer.status().pendingChanges&&!node.materialOrganizer.status().pendingSteps)break;await new Promise(resolve=>setImmediate(resolve));}
 const id=materialId(source.id,'DocumentDiary123'),material=await request('GET',`/api/materials/${id}`);assert.equal(material.coverage.state,'complete',JSON.stringify(material.coverage));assert.equal(material.memorySource.status,'ready');assert.equal(node.files.detail(original.captureId).job.state,'succeeded');
 let text='',offset:number|null=0;while(offset!==null){const page=await request('GET',`/api/materials/${id}/read?offset=${offset}&length=12000`);text+=page.text;offset=page.textRange.nextOffset;}
 assert.ok(text.includes('| Intake | Verified |'),'native table Markdown must remain readable');assert.ok(text.includes('Generated paragraph 0:'));assert.ok(text.includes('Generated paragraph 6499:'));assert.ok(text.includes('TAIL_GENERATED_ACCEPTANCE_MARKER: the end is preserved.'));
 const input=node.materials.input(material.ref,['extracted-text'])!;assert.equal(input.ready,true);assert.ok(input.evidenceIds.length>1);const evidence=node.materials.evidence(input.evidenceIds).map(item=>item.ocrText).join('\n');assert.ok(evidence.includes('TAIL_GENERATED_ACCEPTANCE_MARKER'));
 const rows=node.store.db.prepare('SELECT binding_json,required_json,auto_authorized,input_key FROM material_memory_requests WHERE material_id=?').all(id);assert.equal(rows.length,1);assert.equal(JSON.parse(String(rows[0].binding_json)).recipe.id,'mote.personal-memory');assert.deepEqual(JSON.parse(String(rows[0].required_json)),['extracted-text']);assert.equal(rows[0].auto_authorized,1);assert.equal(rows[0].input_key,original.captureId);assert.equal(modelCalls,0);
});

test('explicit calendar authorization bootstraps native calendar discovery without adding scope to document-only login',async t=>{
 const f=await fixture(t);await f.c.close();let granted=[...LARK_SCOPES],requested=[...granted];
 const runner:LarkRunner=async(command,options)=>{
  if(command.kind==='status')return json({appId:'cli_fixture',identities:{user:{available:true,openId:f.state.account,scope:granted.join(' ')}}});
  if(command.kind==='login')requested=command.scopes;
  if(command.kind==='complete')granted=[...requested];
  if(command.kind==='calendars'){if(!granted.includes('calendar:calendar:readonly'))throw new ConnectorError('lark_permission_required',403);return json({data:{calendar_list:[{calendar_id:'generated-calendar',summary:'Generated calendar',role:'reader'}],has_more:false}});}
  return f.runner(command,options);
 };
 const c=new LarkConnector(f.ctx,runner);await c.init();t.after(()=>c.close());c.login();assert.equal((await done(c)).job?.state,'completed');assert.ok(!requested.includes('calendar:calendar:readonly'));await assert.rejects(()=>c.calendars(),/lark_permission_required/);assert.equal(c.status().selection.calendarIds.length,0);
 c.login(true);assert.equal((await done(c)).job?.state,'completed');assert.ok(requested.includes('calendar:calendar:readonly'));assert.equal((await c.calendars()).calendars[0].id,'generated-calendar');assert.equal(c.status().selection.calendarIds.length,0);assert.equal(f.sources.listSources().length,0,'granting calendar read never selects or collects a calendar');
});
