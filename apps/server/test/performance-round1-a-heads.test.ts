import test from 'node:test';
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {PrivateData,PRIVATE_DATA_DOMAIN} from '../src/scope/private-data.js';
import {installPrivateData} from '../src/scope/private-data-schema.js';
import {captureBrowserRecord,scopedCaptureFixture} from './fixtures/scoped-capture-host.js';

const index='pd_source_heads_capture';
const createIndex=`CREATE INDEX ${index} ON pd_source_heads(user_id,capture_id)`;
const at=(n:number)=>new Date(Date.UTC(2026,8,13)+Math.floor(n/3)*1000).toISOString();
const item=(n:number,owner:string,revision='current',extra={})=>({externalId:'generated-'+n,revision,observedAt:at(n),title:'Generated '+n,text:owner+' generated '+n,kind:n%2?'file':'event',layer:'original',...extra});

// These are functional scale fixtures, not an absolute speed gate. Run timing
// under the campaign heavy lease; all heads are real source-revision intake.
for(const size of [1000,10000])test(`${size} current heads preserve scoped HTTP pages with historical revisions and the reverse index`,{timeout:180000},async t=>{
 const f=await scopedCaptureFixture(t),db=f.host.execution!.engine.store.db;
 const users=await Promise.all([f.a,f.b].map(async account=>({account,data:f.host.services.forUser(await f.host.authority.authenticate(account.token)).get<PrivateData>(PRIVATE_DATA_DOMAIN)})));
 const current=new Set<string>();
 for(const {account,data} of users){
  for(let offset=0;offset<size;offset+=500){
   const rows=Array.from({length:Math.min(500,size-offset)},(_,i)=>item(offset+i,account.userId));
   const receipts=data.receiveSourceItems('same-source',rows).receipts;
   if(account===f.a)receipts.forEach(receipt=>current.add(receipt.id));
  }
  // Deliberately arrive after current revision, but with older observed times.
  for(let offset=0;offset<size;offset+=500)data.receiveSourceItems('same-source',Array.from({length:Math.min(500,size-offset)},(_,i)=>item(offset+i,account.userId,'old',{observedAt:'2026-09-12T00:00:00Z'})));
 }
 assert.equal(Number(db.prepare('SELECT count(*) n FROM pd_source_heads WHERE user_id=?').get(f.a.userId)!.n),size);
 assert.equal(Number(db.prepare('SELECT count(*) n FROM pd_captures WHERE user_id=?').get(f.a.userId)!.n),size*2);
 // A deleted head stays a head but is not a visible browser candidate.
 const deleted=users[0].data.receiveSourceItems('same-source',[item(size,f.a.userId,'deleted',{deleted:true,text:''})]).receipts[0];
 await f.receive(f.a,[captureBrowserRecord(4000000,'raw')]);
 const capturedSql:string[]=[],prepare=db.prepare.bind(db);
 const spy=t.mock.method(db,'prepare',(sql:string)=>{capturedSql.push(sql);return prepare(sql);});
 const read=async(account:typeof f.a,query:Record<string,string>={})=>{const response=await f.request(account.token,'/api/capture-browser?'+new URLSearchParams({limit:'60',...query}));assert.equal(response.statusCode,200,response.body);return response.json();};
 const first=await read(f.a);spy.mock.restore();
 assert.equal(first.totalCount,size+1);assert.ok(first.items.every((row:any)=>row.id!==deleted.id));
 const countSql=capturedSql.find(sql=>sql.startsWith('WITH extraction')&&sql.includes('SELECT count(*) n FROM browser'));
 assert.ok(countSql,'capture the actual production count SQL');
 const explain=()=>prepare('EXPLAIN QUERY PLAN '+countSql).all({$user:f.a.userId}).map(row=>String(row.detail));
 const withIndex=explain();assert.ok(withIndex.some(line=>line.includes(index)&&line.includes('user_id=? AND capture_id=?')),JSON.stringify(withIndex));
 // Traverse via real signed cursors once, then compare first/middle/tail pages
 // under the exact same cursor and frozen data with the index absent/present.
 const pages:{query:Record<string,string>;value:any}[]=[{query:{},value:first}];
 let cursor=first.nextCursor;
 while(cursor){const query={cursor},value=await read(f.a,query);pages.push({query,value});cursor=value.nextCursor;}
 const all=pages.flatMap(page=>page.value.items);
 assert.equal(all.length,size+1);assert.equal(new Set(all.map(row=>row.id)).size,size+1);
 assert.deepEqual(new Set(all.filter(row=>row.source!=='screen').map(row=>row.id)),current);
 const ordered=all.map(row=>[row.capturedAt,row.id].join('|'));
 assert.deepEqual(ordered,[...ordered].sort().reverse(),'timestamp ties keep the original descending ID order');
 const queries=[{},pages[Math.floor(pages.length/2)].query,pages.at(-1)!.query,
  {source:'file',deviceId:'same-device',appId:'mote.source.local-files',collection:'content',ocrStatus:'not_applicable'},
  {after:at(Math.floor(size/3)),before:at(Math.floor(size*2/3))},
  {collection:'activity'}, {appId:'missing'}, {ocrStatus:'completed'}];
 const expected=[];for(const query of queries)expected.push(await read(f.a,query));
 const bExpected=await read(f.b);assert.equal(bExpected.totalCount,size);
 assert.ok(bExpected.items.every((row:any)=>row.textPreview.startsWith(f.b.userId)));
 db.exec(`DROP INDEX ${index}`);
 const withoutIndex=explain();assert.ok(withoutIndex.some(line=>line.includes('SEARCH h USING INDEX sqlite_autoindex_pd_source_heads_1 (user_id=?)')),JSON.stringify(withoutIndex));
 const beforeMs:number[]=[],afterMs:number[]=[];
 try{
  for(let i=0;i<queries.length;i++){const start=performance.now();assert.deepEqual(await read(f.a,queries[i]),expected[i]);beforeMs.push(performance.now()-start);}
  assert.deepEqual(await read(f.b),bExpected);
 }finally{db.exec(createIndex);}
 for(let i=0;i<queries.length;i++){const start=performance.now();assert.deepEqual(await read(f.a,queries[i]),expected[i]);afterMs.push(performance.now()-start);}
 for(const token of [f.b.token])assert.equal((await f.request(token,'/api/capture-browser?limit=60&cursor='+encodeURIComponent(first.nextCursor))).statusCode,400);
 assert.equal((await f.request(f.a.token,'/api/capture-browser?source=file&cursor='+encodeURIComponent(first.nextCursor))).statusCode,400);
 // Existing current schema can be initialized again without a version change.
 const key=installPrivateData(db);assert.equal(installPrivateData(db),key);
 const replacement=users[0].data.receiveSourceItems('same-source',[item(0,f.a.userId,'replacement',{observedAt:'2026-09-14T00:00:00Z'})]).receipts[0];
 assert.equal((await read(f.a,{source:'event'})).items[0].id,replacement.id);
 const frozen=await read(f.a);db.exec('BEGIN');users[0].data.receiveSourceItems('same-source',[item(0,f.a.userId,'rollback',{observedAt:'2026-09-15T00:00:00Z'})]);db.exec('ROLLBACK');assert.deepEqual(await read(f.a),frozen);
 const removed=await f.request(f.a.token,'/api/captures/'+replacement.id,'DELETE');assert.equal(removed.statusCode,200,removed.body);
 assert.equal((await read(f.a)).totalCount,size);
 assert.equal((await read(f.b)).totalCount,size);
 assert.deepEqual(prepare('PRAGMA foreign_key_check').all(),[]);
 t.diagnostic(JSON.stringify({size,currentHeadsPerAccount:size,historicalRevisionsPerAccount:size,queryCount:queries.length,beforeMs,afterMs,withoutIndex,withIndex}));
});
