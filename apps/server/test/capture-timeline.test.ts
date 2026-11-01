import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import sharp from 'sharp';
import {buildApp} from '../src/app.js';
import {Store} from '../src/store.js';
import {CaptureTimeline} from '../src/capture-timeline.js';
import type {CaptureTimelineGroup,CaptureTimelinePage,CaptureTimelineMembers} from '@mote/shared';

const owner='generated-timeline-owner-token-123456789';
const headers=(token=owner)=>({authorization:'Bearer '+token,'x-mote-ingress-version':'2'});
const scope={after:'2026-10-29T00:00:00.000Z',before:'2026-10-30T00:00:00.000Z',timeZone:'UTC'};
async function fixture(t:TestContext){
 const dir=await mkdtemp(join(tmpdir(),'mote-capture-timeline-'));
 const node=await buildApp({dataDir:dir,token:owner,tokenPath:join(dir,'token'),host:'127.0.0.1',port:0,maxStorageBytes:50_000_000,maxExportBytes:10_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:''},{backgroundWorker:false,agent:{configured:false,query:async()=>{throw Error('No inference in read-only browsing');},close:async()=>{}}});
 t.after(async()=>{await node.app.close();await rm(dir,{recursive:true,force:true});});
 const request=async(path:string,query:Record<string,string|number>={},token=owner,status=200)=>{const response=await node.app.inject({url:path+'?'+new URLSearchParams(Object.entries(query).map(([key,value])=>[key,String(value)])),headers:headers(token)});assert.equal(response.statusCode,status,response.body);return response.json();};
 const add=async(payload:unknown)=>{const response=await node.app.inject({method:'POST',url:'/api/captures',headers:headers(),payload});assert.ok([200,201].includes(response.statusCode),response.body);};
 const activity=(at:string,deviceId='generated-a',series?:{at:string;durationMs:number}[])=>({id:randomUUID(),deviceId,deviceName:'Generated device',platform:'android',capturedAt:at,durationMs:1000,appId:'generated.app',appName:'Generated app',windowTitle:'',source:'activity',ocrText:'',metadata:{version:1,observedAt:at},privacy:{collection:'activity',mode:'none'},...(series?{stateSeries:{version:1,samples:series}}:{})});
 const note=async(at:string)=>{const id=randomUUID(),response=await node.app.inject({method:'POST',url:'/api/notes',headers:headers(),payload:{id,deviceId:'generated-note',deviceName:'Generated notes',platform:'import',capturedAt:at,text:'Generated independent saved original '+id}});assert.equal(response.statusCode,201,response.body);return id;};
 return {...node,request,add,activity,note};
}

test('mixed time browsing counts all originals and paginates both groups and exact members without missing rows',async t=>{
 const node=await fixture(t),ids:string[]=[];
 for(let i=0;i<71;i++){const event=node.activity(new Date(Date.parse(scope.after)+i*1000).toISOString());ids.push(event.id);await node.add(event);}
 for(let i=0;i<5;i++)await node.note(new Date(Date.parse(scope.after)+3600000+i*1000).toISOString());
 const all:CaptureTimelinePage['items']=[];let cursor:string|undefined;
 do{const page=await node.request('/api/capture-browser/timeline',{...scope,limit:2,...(cursor?{cursor}:{})}) as CaptureTimelinePage;all.push(...page.items);cursor=page.nextCursor??undefined;}while(cursor);
 assert.equal(all.length,6);assert.equal(new Set(all.map(item=>item.id)).size,6);
 const group=all.find((item):item is CaptureTimelineGroup=>item.type==='group')!;assert.equal(group.recordCount,71);assert.equal(group.sampleCount,null,'Absent series does not become a fabricated sample total');assert.equal(group.appName,undefined,'A source group never claims a shared document/app');
 const members:string[]=[];cursor=undefined;
 do{const page=await node.request('/api/capture-browser/timeline/members',{...scope,group:group.id,limit:17,...(cursor?{cursor}:{})}) as CaptureTimelineMembers;assert.equal(page.group.recordCount,71);members.push(...page.items.map(item=>item.record.id));cursor=page.nextCursor??undefined;}while(cursor);
 assert.deepEqual(new Set(members),new Set(ids));assert.equal(members.length,71);
 const body=await node.request('/api/capture-browser/'+ids[0]);assert.equal(body.id,ids[0]);assert.equal(node.store.list().totalCount,76,'Read projections do not write originals');
});

test('screen app and OCR filtering cannot join an observed A to another A across B or a real session gap',async t=>{
 const node=await fixture(t),image=(await sharp({create:{width:8,height:8,channels:3,background:'#806b96'}}).png().toBuffer()).toString('base64');
 for(const [minute,app,pending] of [[0,'a',false],[1,'b',true],[2,'a',false],[9,'a',false]] as const){const at=`2026-10-29T10:${String(minute).padStart(2,'0')}:00.000Z`;await node.add({id:randomUUID(),deviceId:'generated-screen',deviceName:'Generated screen',platform:'android',capturedAt:at,durationMs:0,appId:app,appName:app,windowTitle:'Generated window',source:'screen',imageMime:'image/png',imageBase64:image,ocrText:pending?'':'Generated recognized text',ocr:{status:pending?'pending':'completed'},privacy:{collection:'content',mode:'none'}});}
 const page=await node.request('/api/capture-browser/timeline',{...scope,appId:'a',source:'screen',ocrStatus:'completed'}) as CaptureTimelinePage;
 assert.equal(page.items.length,3);assert.ok(page.items.every(item=>item.type==='group'&&item.kind==='screen-session'&&item.recordCount===1&&item.imageCount===1));
 const old=node.store.sessions({...scope,deviceId:'generated-screen',limit:30});assert.equal(old.items.length,4,'The existing session endpoint retains its exact segmentation');assert.equal(old.totalCount,4);
});

test('date grouping uses exact observations across midnight, offsets and the repeated DST hour',async t=>{
 const node=await fixture(t),at='2025-11-02T03:59:00.000Z',event=node.activity(at,'generated-a',[{at,durationMs:1000},{at:'2025-11-02T04:00:00.000Z',durationMs:1000}]);await node.add(event);
 for(const when of ['2025-11-02T05:30:00.000Z','2025-11-02T06:30:00.000Z','2025-11-03T04:59:00.000Z','2025-11-03T05:00:00.000Z'])await node.add(node.activity(when,'generated-a',[{at:when,durationMs:1000}]));
 const range={after:'2025-11-02T00:00:00.000Z',before:'2025-11-04T00:00:00.000Z',timeZone:'America/New_York'},page=await node.request('/api/capture-browser/timeline',range) as CaptureTimelinePage;
 const groups=page.items as CaptureTimelineGroup[];assert.deepEqual(groups.map(item=>[item.day,item.recordCount,item.sampleCount]),[['2025-11-03',1,1],['2025-11-02',4,4],['2025-11-01',1,1]]);
 const midnight=await node.request('/api/capture-browser/timeline/members',{...range,group:groups[1].id}) as CaptureTimelineMembers;
 const projected=midnight.items.find(item=>item.record.id===event.id)!;assert.equal(projected.record.capturedAt,at);assert.equal(projected.firstAt,'2025-11-02T04:00:00.000Z');assert.equal(projected.lastAt,projected.firstAt);assert.equal(projected.sampleCount,1);
 const onlyAfter=await node.request('/api/capture-browser/timeline',{after:'2025-11-02T04:00:00.000Z',before:'2025-11-02T04:01:00.000Z',timeZone:'America/New_York'}) as CaptureTimelinePage;assert.equal((onlyAfter.items[0] as CaptureTimelineGroup).sampleCount,1,'A midnight member survives even when its original began before the range');
 const offset='2026-10-29T08:00:00+08:00';await node.add(node.activity(offset,'generated-offset',[{at:offset,durationMs:1000},{at:'2026-10-29T08:01:00+08:00',durationMs:1000}]));const exact=await node.request('/api/capture-browser/timeline',{...scope,deviceId:'generated-offset'}) as CaptureTimelinePage;assert.equal((exact.items[0] as CaptureTimelineGroup).sampleCount,2);
});

test('sample totals stay unknown for mixed series and all cursors stay attached to their own group and scope',async t=>{
 const node=await fixture(t);for(const device of ['generated-a','generated-b'])for(let i=0;i<3;i++){const at=`2026-10-29T01:0${i}:00.000Z`;await node.add(node.activity(at,device,i===0?[{at,durationMs:1000}]:undefined));}
 const page=await node.request('/api/capture-browser/timeline',scope) as CaptureTimelinePage,groups=page.items as CaptureTimelineGroup[];assert.equal(groups.length,2);assert.ok(groups.every(item=>item.recordCount===3&&item.sampleCount===null));
 const first=await node.request('/api/capture-browser/timeline/members',{...scope,group:groups[0].id,limit:1}) as CaptureTimelineMembers;assert.ok(first.nextCursor);
 await node.request('/api/capture-browser/timeline/members',{...scope,group:groups[1].id,cursor:first.nextCursor!},owner,409);
 await node.request('/api/capture-browser/timeline/members',{...scope,timeZone:'Asia/Shanghai',group:groups[0].id},owner,409);
 await node.request('/api/capture-browser/timeline/members',{...scope,source:'notification',group:groups[0].id},owner,409);
 const [sealedBody,sealedSignature]=groups[0].id.split('.');const tamperedSignature=(sealedSignature[0]==='A'?'B':'A')+sealedSignature.slice(1);assert.notDeepEqual(Buffer.from(tamperedSignature,'base64url'),Buffer.from(sealedSignature,'base64url'),'Tampering a fully significant signature character must change the decoded bytes');
 await node.request('/api/capture-browser/timeline/members',{...scope,group:sealedBody+'.'+tamperedSignature},owner,400);
 const denied=await node.app.inject({url:'/api/capture-browser/timeline?'+new URLSearchParams(scope)});assert.equal(denied.statusCode,401);
});

test('deleting an unloaded member or changing OCR invalidates a previous group and page instead of retargeting it',async t=>{
 const node=await fixture(t);for(let i=0;i<3;i++)await node.add(node.activity(`2026-10-29T01:0${i}:00.000Z`));
 await node.note('2026-10-29T02:00:00.000Z');const page=await node.request('/api/capture-browser/timeline',{...scope,limit:1}) as CaptureTimelinePage;assert.ok(page.nextCursor);
 const all=await node.request('/api/capture-browser/timeline',scope) as CaptureTimelinePage,group=all.items.find((item):item is CaptureTimelineGroup=>item.type==='group')!,member=await node.request('/api/capture-browser/timeline/members',{...scope,group:group.id,limit:1}) as CaptureTimelineMembers;assert.ok(member.nextCursor);
 const ids=node.store.list({source:'activity'}).items.map(item=>item.id),unloaded=ids.find(id=>id!==member.items[0].record.id)!;const deleted=await node.app.inject({method:'DELETE',url:'/api/captures/'+unloaded,headers:headers()});assert.equal(deleted.statusCode,200,deleted.body);
 await node.request('/api/capture-browser/timeline',{...scope,cursor:page.nextCursor!},owner,409);await node.request('/api/capture-browser/timeline/members',{...scope,group:group.id,cursor:member.nextCursor!},owner,409);
 const image=(await sharp({create:{width:8,height:8,channels:3,background:'#698373'}}).png().toBuffer()).toString('base64'),id=randomUUID();await node.add({id,deviceId:'generated-screen',deviceName:'Generated screen',platform:'android',capturedAt:'2026-10-29T10:00:00.000Z',durationMs:0,appId:'generated',appName:'Generated',windowTitle:'',source:'screen',imageMime:'image/png',imageBase64:image,ocrText:'',ocr:{status:'pending'},privacy:{collection:'content',mode:'none'}});
 const before=await node.request('/api/capture-browser/timeline',{...scope,limit:1}) as CaptureTimelinePage;assert.ok(before.nextCursor);const response=await node.app.inject({method:'POST',url:'/api/capture-browser/'+id+'/ocr',headers:headers(),payload:{status:'completed',ocrText:'Generated OCR result'}});assert.equal(response.statusCode,200,response.body);
 await node.request('/api/capture-browser/timeline',{...scope,limit:1,cursor:before.nextCursor!},owner,409);
});

test('existing owner and collector authority also applies to the new read projection',async t=>{
 const node=await fixture(t);await node.add(node.activity('2026-10-29T01:00:00.000Z'));
 const issue=async(path:string)=>{const invite=await node.app.inject({method:'POST',url:path,headers:headers(),payload:{serverUrl:'https://generated.invalid',label:'Generated device'}});assert.equal(invite.statusCode,200,invite.body);const redeemed=await node.app.inject({method:'POST',url:'/api/connections/redeem',payload:{code:invite.json().invitation.code,deviceId:randomUUID(),deviceName:'Generated device',platform:'android'}});assert.equal(redeemed.statusCode,200,redeemed.body);return redeemed.json();};
 const paired=await issue('/api/connections/invitations');assert.equal(paired.scope,'owner');await node.request('/api/capture-browser/timeline',scope,paired.token);
 const collector=await issue('/api/connections/collector-invitations');assert.equal(collector.scope,'collector');await node.request('/api/capture-browser/timeline',scope,collector.token,403);
 const revoked=await node.app.inject({method:'DELETE',url:'/api/connections/'+paired.credentialId,headers:headers()});assert.equal(revoked.statusCode,200,revoked.body);await node.request('/api/capture-browser/timeline',scope,paired.token,401);
 for(const query of [{...scope,timeZone:'invalid/zone'},{...scope,before:'2027-01-01T00:00:00.000Z'}])await node.request('/api/capture-browser/timeline',query,owner,400);
});

test('an unloaded source-head replacement invalidates locators and never presents an older version as current',async t=>{
 const node=await fixture(t);await node.add(node.activity('2026-10-29T01:00:00.000Z'));
 node.sources.register({id:'generated-versioned',name:'Generated versions',kind:'custom',deviceId:'generated-version-device',platform:'import'});
 const input={externalId:'same-head',revision:'1',observedAt:'2026-10-29T02:00:00.000Z',title:'Generated same title',kind:'message' as const,layer:'snapshot' as const,text:'Generated first version',deleted:false};
 const old=await node.sources.upsert('generated-versioned',input),first=await node.request('/api/capture-browser/timeline',{...scope,limit:1}) as CaptureTimelinePage;assert.ok(first.nextCursor);
 const all=await node.request('/api/capture-browser/timeline',scope) as CaptureTimelinePage,group=all.items.find((item):item is CaptureTimelineGroup=>item.type==='group')!;
 const current=await node.sources.upsert('generated-versioned',{...input,revision:'2',observedAt:'2026-10-29T03:00:00.000Z',text:'Generated replacement version'});
 await node.request('/api/capture-browser/timeline',{...scope,cursor:first.nextCursor!},owner,409);
 await node.request('/api/capture-browser/timeline/members',{...scope,group:group.id},owner,409);
 const after=await node.request('/api/capture-browser/timeline',scope) as CaptureTimelinePage,recordIds=after.items.flatMap(item=>item.type==='record'?[item.record.id]:[]);assert.ok(recordIds.includes(current.id));assert.ok(!recordIds.includes(old.id));assert.notEqual(current.id,old.id);
});

test('a retained metadata-only screen series has distinct date rows when its original precedes the selected range',async t=>{
 const node=await fixture(t),id=randomUUID(),at='2026-10-28T23:59:00.000Z';
 await node.add({id,deviceId:'generated-screen-series',deviceName:'Generated screen',platform:'android',capturedAt:at,durationMs:0,appId:'generated.app',appName:'Generated app',windowTitle:'',source:'screen',ocrText:'',ocr:{status:'disabled'},metadata:{version:1,observedAt:at,capture:{deduplication:{mode:'exact',duplicate:true}}},privacy:{collection:'content',mode:'none'},stateSeries:{version:1,samples:[{at,durationMs:0},{at:'2026-10-28T23:59:40.000Z',durationMs:0},{at:'2026-10-29T00:00:10.000Z',durationMs:0}]}});
 const range={after:'2026-10-28T23:59:30.000Z',before:'2026-10-29T00:01:00.000Z',timeZone:'UTC'};
 const page=await node.request('/api/capture-browser/timeline',range) as CaptureTimelinePage;
 assert.equal(page.items.length,2,'The two observed dates cannot collapse into an arbitrary date');
 assert.equal(new Set(page.items.map(item=>item.id)).size,2,'Projection identities stay distinct while original identity stays exact');
 for(const [index,day] of ['2026-10-29','2026-10-28'].entries()){const item=page.items[index];assert.equal(item.type,'record');if(item.type!=='record')assert.fail('Expected one original row per observed date');assert.equal(item.record.id,id);assert.equal(item.day,day);assert.equal(item.sampleCount,1);assert.equal(item.firstAt,item.lastAt);assert.ok(item.firstAt.startsWith(day));}
 const first=await node.request('/api/capture-browser/timeline',{...range,limit:1}) as CaptureTimelinePage;assert.ok(first.nextCursor);const next=await node.request('/api/capture-browser/timeline',{...range,limit:1,cursor:first.nextCursor!}) as CaptureTimelinePage;assert.equal(next.items[0].day,'2026-10-28');assert.equal(next.nextCursor,null);
});

async function groupedFixture(t:TestContext,groups:number){
 const dir=await mkdtemp(join(tmpdir(),'mote-timeline-group-reuse-')),store=new Store(dir,{maxStorageBytes:50_000_000,maintenance:false});
 t.after(async()=>{store.close();await rm(dir,{recursive:true,force:true});});
 const records=Array.from({length:groups*2},(_,index)=>{const group=Math.floor(index/2),day=group%3,at=new Date(Date.parse(scope.after)+day*86400000+3600000+(index%2)*1000).toISOString();return {id:randomUUID(),deviceId:'generated-group-'+group,deviceName:'Generated device',platform:'android',capturedAt:at,durationMs:1000,appId:'generated.app',appName:'Generated app',windowTitle:'',source:'activity',ocrText:'',metadata:{version:1,observedAt:at},privacy:{collection:'activity',mode:'none'}};});
 for(let index=0;index<records.length;index+=500)await store.ingestBatch(records.slice(index,index+500));
 const range={...scope,before:'2026-11-01T00:00:00.000Z',limit:100};
 const reads={grouped:0,ctes:0},prepare=store.db.prepare.bind(store.db);
 store.db.prepare=sql=>new Proxy(prepare(sql),{get(target,key){const value=Reflect.get(target,key,target);if(typeof value!=='function')return value;return (...args:unknown[])=>{if(key==='all'||key==='get'){if(/SELECT \* FROM grouped\b/.test(sql))reads.grouped++;if(sql.includes('member_rows AS'))reads.ctes++;}return value.apply(target,args);};}});
 return {store,range,reads,records,timeline:new CaptureTimeline(store)};
}
const comparablePage=(page:CaptureTimelinePage)=>({...page,items:page.items.map(item=>({...item,id:item.id.split('.')[0]})),nextCursor:page.nextCursor?.split('.')[0]??null});

test('three days and 300 groups reuse grouping across pages and expansion with identical cold and warm results',async t=>{
 const {store,range,reads,timeline,records}=await groupedFixture(t,300),pages:CaptureTimelinePage[]=[];let cursor:string|undefined;
 do{const page=timeline.page({...range,...(cursor?{cursor}:{})},owner);pages.push(page);cursor=page.nextCursor??undefined;}while(cursor);
 assert.equal(pages.length,3);assert.equal(pages.flatMap(page=>page.items).length,300);assert.equal(new Set(pages.flatMap(page=>page.items.map(item=>item.id))).size,300);
 assert.deepEqual(new Set(pages.flatMap(page=>page.items.map(item=>item.day))),new Set(['2026-10-29','2026-10-30','2026-10-31']));
 const group=pages[0].items[0] as CaptureTimelineGroup,before=reads.ctes,members=timeline.members(range,owner,group.id);
 assert.equal(reads.ctes-before,1,'Expansion executes one member CTE');assert.equal(members.group.recordCount,2);assert.equal(members.items.length,2);
 assert.deepEqual(new Set(members.items.map(item=>item.record.id)),new Set(records.filter(record=>record.deviceId===group.deviceId).map(record=>record.id)));
 assert.equal(reads.grouped,1,'Pagination and expansion calculate grouped rows once');
 for(const [index,page] of pages.entries()){const hit=timeline.page({...range,...(index?{cursor:pages[index-1].nextCursor!}:{})},owner);assert.deepEqual(hit,page);}
 const cold=new CaptureTimeline(store);cursor=undefined;
 for(const expected of pages){const page=cold.page({...range,...(cursor?{cursor}:{})},owner);assert.deepEqual(comparablePage(page),comparablePage(expected));cursor=page.nextCursor??undefined;}
});

test('LRU eviction preserves group expansion with one CTE and keeps recently used scopes',async t=>{
 const {range,reads,timeline}=await groupedFixture(t,9),first=timeline.page(range,owner),group=first.items[0] as CaptureTimelineGroup;
 for(let i=0;i<7;i++)timeline.page({...range,deviceId:'generated-group-'+i},owner);
 const beforeHit=reads.grouped;timeline.page(range,owner);assert.equal(reads.grouped,beforeHit,'Touch the full range before adding a ninth scope');
 timeline.page({...range,deviceId:'generated-group-7'},owner);
 const beforeRecent=reads.grouped;timeline.page(range,owner);assert.equal(reads.grouped,beforeRecent,'Recent range survives eviction');
 const beforeEvicted=reads.grouped;timeline.page({...range,deviceId:'generated-group-0'},owner);assert.equal(reads.grouped,beforeEvicted+1,'Least recent scope must be recomputed');
 for(let i=0;i<9;i++)timeline.page({...range,deviceId:'generated-group-'+i},owner);
 const before=reads.ctes,members=timeline.members({...range,limit:1},owner,group.id);
 assert.equal(reads.ctes-before,1,'An evicted summary and its member page use one CTE');assert.equal(members.group.recordCount,2);assert.equal(members.items.length,1);assert.ok(members.nextCursor);
 const nextBefore=reads.ctes,last=timeline.members({...range,limit:1,cursor:members.nextCursor!},owner,group.id);assert.equal(reads.ctes-nextBefore,1);assert.equal(last.items.length,1);assert.equal(last.nextCursor,null);
});

test('cached group cursors preserve SQLite byte ordering for tied timestamps',async t=>{
 const {range,store,records,timeline}=await groupedFixture(t,3);
 await store.ingestBatch(['generated-Z','generated_a'].map(deviceId=>({...records[1],id:randomUUID(),deviceId})));
 const expected=timeline.page(range,owner).items,seen:CaptureTimelinePage['items']=[];let cursor:string|undefined;
 do{const page=timeline.page({...range,limit:1,...(cursor?{cursor}:{})},owner);seen.push(...page.items);cursor=page.nextCursor??undefined;}while(cursor);
 assert.equal(expected.length,5);assert.deepEqual(seen,expected);
});

test('a range above 5000 groups never enters the cache or evicts a reusable small scope',async t=>{
 const {range,reads,timeline}=await groupedFixture(t,5001),small={...range,deviceId:'generated-group-0'};
 timeline.page(small,owner);const first=timeline.page(range,owner),before=reads.grouped;assert.ok(first.nextCursor);
 timeline.page(range,owner);assert.equal(reads.grouped,before+1,'Oversized grouping is recomputed');
 const beforeSmall=reads.grouped;timeline.page(small,owner);assert.equal(reads.grouped,beforeSmall,'Oversized range does not displace a cached scope');
 const group=first.items[0] as CaptureTimelineGroup,cteBefore=reads.ctes,members=timeline.members(range,owner,group.id);assert.equal(reads.ctes-cteBefore,1,'Uncached expansion uses one CTE');assert.equal(members.items.length,2);assert.equal(members.group.recordCount,2);
});
