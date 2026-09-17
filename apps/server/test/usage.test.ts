import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.js';
import {UsageLedger,estimateCost} from '../src/usage.js';
const price={provider:'fixture',model:'fixture-model',currency:'USD' as const,input:2,output:8,cacheRead:0.5,cacheWrite:3};
const tokens={requests:2,reportedRequests:2,inputTokens:1000000,outputTokens:100000,cacheReadTokens:500000,cacheWriteTokens:100000,totalTokens:1100000,reasoningTokens:50000};
test('disjoint token buckets, incomplete costs, price snapshots and timezone days',t=>{
  assert.equal(estimateCost(tokens,price),2.15);
  assert.equal(estimateCost({...tokens,reportedRequests:1},price),null);
  assert.equal(estimateCost({...tokens,cacheReadTokens:undefined},price),null);
  const dir=mkdtempSync(join(tmpdir(),'mote-usage-')),store=new Store(dir),ledger=new UsageLedger(store);
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  ledger.setPrice(price);const meter=ledger.start('fixture','fixture-model','query');
  ledger.setPrice({...price,input:999});meter.update(tokens);const receipt=meter.finish('failed');assert.equal(receipt.estimatedCost,2.15);
  receipt.createdAt='2026-09-15T17:00:00.000Z';store.db.prepare('UPDATE model_usage SET created_at=?,json=? WHERE id=?').run(receipt.createdAt,JSON.stringify(receipt),receipt.id);
  const sh=ledger.summary('2026-09-16','2026-09-16','Asia/Shanghai');assert.equal(sh.total.runs,1);assert.equal(sh.total.failed,1);assert.equal(sh.total.cacheHitRate,.5);
  assert.equal(ledger.summary('2026-09-16','2026-09-16','UTC').total.runs,0);
  const pending=ledger.start('fixture','fixture-model','query');pending.update({...tokens,reportedRequests:1});new UsageLedger(store);
  const today=new Date().toISOString().slice(0,10);const interrupted=ledger.summary(today,today,'UTC').items[0];assert.equal(interrupted.status,'failed');assert.equal(interrupted.estimatedCost,null);
});

test('attribution dimensions preserve totals, intersect filters, distinguish legacy and no-skill, and aggregate beyond the detail limit',t=>{
  const dir=mkdtempSync(join(tmpdir(),'mote-usage-groups-')),store=new Store(dir),ledger=new UsageLedger(store);
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  ledger.setPrice(price);
  const contexts=[
    {agentId:'context-query',moduleId:'conversations',skillId:null},
    {agentId:'context-query',moduleId:'insights',skillId:'personal-insight'},
    {agentId:'file-analysis',moduleId:'files',skillId:null},
    {agentId:'document-import',moduleId:'imports',skillId:'document-import'},
    undefined,
  ];
  for(let i=0;i<105;i++){
    const m=ledger.start('fixture','fixture-model','query',contexts[i%5]);m.update(tokens);
    const r=m.finish(i%5===2?'failed':'completed');r.createdAt='2026-09-15T17:00:00.000Z';r.durationMs=(i+1)*100;
    if(i===0){r.status='running';r.durationMs=9999999;}
    if(i===1){r.currency='CNY';r.estimatedCost=3;}
    if(i===2){r.tokens=undefined;r.estimatedCost=null;}
    store.db.prepare('UPDATE model_usage SET created_at=?,json=? WHERE id=?').run(r.createdAt,JSON.stringify(r),r.id);
  }
  const all=ledger.summary('2026-09-16','2026-09-16','Asia/Shanghai');
  assert.equal(all.itemsTotal,105);assert.equal(all.items.length,20);assert.equal(all.total.running,1);assert.equal(all.total.failed,21);assert.equal(all.total.completed,83);
  assert.equal(all.total.successRate,83/104);assert.equal(all.total.requests,208);assert.equal(all.total.unknownUsage,1);assert.equal(all.total.unpriced,1);
  assert.equal(all.total.averageDurationMs,5350);assert.equal(all.total.p95DurationMs,10000);assert.equal(all.total.costs.CNY,3);
  assert.ok(all.facets.skillId.some(s=>s.id==='__none__'));assert.ok(all.facets.skillId.some(s=>s.id==='__unknown__'));
  for(const by of ['agent','module','skill','model'] as const){
    const view=ledger.summary('2026-09-16','2026-09-16','Asia/Shanghai',{},by);
    assert.equal(view.groups.reduce((n,g)=>n+g.totalTokens,0),all.total.totalTokens);
    assert.equal(view.groups.reduce((n,g)=>n+g.runs,0),105);
    assert.ok(Math.abs(view.groups.reduce((n,g)=>n+(g.costs.USD??0),0)-all.total.costs.USD!)<1e-9);
    for(const group of view.groups){const detail=ledger.summary('2026-09-16','2026-09-16','Asia/Shanghai',group.filter,by);assert.equal(detail.total.runs,group.runs);}
  }
  const selected=ledger.summary('2026-09-16','2026-09-16','Asia/Shanghai',{agentId:'context-query',moduleId:'conversations',skillId:'__none__',status:'completed'},'skill');
  assert.equal(selected.total.runs,20);assert.equal(selected.groups.length,1);assert.equal(selected.groups[0].label,'未指定 Skill');
  assert.equal(selected.facets.agentId.length,4,'facets are based on date range, not narrowed by current filters');
  assert.equal(ledger.summary('2026-09-16','2026-09-16','UTC').total.runs,0);
  assert.equal(ledger.summary('2026-09-16','2026-09-16','Asia/Shanghai',{moduleId:'does-not-exist'}).total.successRate,null);
  assert.equal(ledger.summary('2026-09-16','2026-09-16','Asia/Shanghai',{skillId:'__unknown__'}).total.runs,21);
});

test('detail pages cover all receipts without changing aggregates; providers drill down to models',t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-usage-pages-')),store=new Store(directory),ledger=new UsageLedger(store);
  t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  for(let i=0;i<45;i++)ledger.start(i%2?'provider-a':'provider-b','model-'+i%3,'query').finish('completed');
  const day=new Date().toISOString().slice(0,10);
  const pages=[1,2,3].map(page=>ledger.summary(day,day,'UTC',{},'provider',page,20));
  assert.deepEqual(pages.map(p=>p.items.length),[20,20,5]);
  assert.equal(new Set(pages.flatMap(p=>p.items.map(i=>i.id))).size,45);
  for(const page of pages){assert.equal(page.total.runs,45);assert.equal(page.groups.length,2);}
  const drill=ledger.summary(day,day,'UTC',pages[0].groups[0].filter,'model');
  assert.equal(drill.total.runs,pages[0].groups[0].runs);assert.equal(drill.groups.length,3);
});
