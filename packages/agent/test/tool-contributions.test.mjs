import test from 'node:test';
import assert from 'node:assert/strict';
import {ContextToolRegistry} from '../dist/tool-contributions.js';
import {startBridge} from '../dist/bridge.js';
const base={search:async()=>[],timeline:async()=>[],evidence:async()=>[],activity:async()=>({}),devices:async()=>[]};
async function call(b,tool,args={}){const r=await fetch(b.url+'/'+tool,{method:'POST',headers:{Authorization:'Bearer '+b.token,'Content-Type':'application/json'},body:JSON.stringify(args)});return {status:r.status,body:await r.json()};}
const tool=(name,read)=>({name,version:'1',description:'Generated metadata',fields:{},maxCharacters:1000,parse:args=>args,authorize:()=>true,read});
test('contributed schema and dispatch are pinned per run while revocation remains live',async t=>{
 const registry=new ContextToolRegistry(),seen=[];
 const remove=registry.register(tool('fixture_context',(_args,{scope})=>{seen.push(scope);return {message:'Untrusted generated metadata'};}));
 const reader={...base,contextTools:()=>registry.snapshot()},b=await startBridge(reader,{question:'Fixture',deviceId:'selected',after:'2026-01-02'},10);t.after(()=>b.close());
 registry.register(tool('later_context',()=>({})));
 assert.equal((await call(b,'later_context')).status,404);
 assert.equal((await call(b,'fixture_context',{deviceId:'other'})).status,400);assert.equal(seen.length,0);
 assert.equal((await call(b,'fixture_context',{after:'2025-01-01'})).status,200);assert.equal(seen[0].after,'2026-01-02T00:00:00.000Z');assert.equal(b.records.size,0);
 remove();assert.equal((await call(b,'fixture_context')).status,400);
 const next=await startBridge(reader,{question:'Next'},10);t.after(()=>next.close());assert.equal((await call(next,'later_context')).status,200);
});
test('contributions honor local and aggregate budgets and cannot enter bounded extraction',async t=>{
 const registry=new ContextToolRegistry();registry.register(tool('large_context',()=>({body:'x'.repeat(1200)})));
 const reader={...base,contextTools:()=>registry.snapshot()},b=await startBridge(reader,{question:'Fixture'},3);t.after(()=>b.close());assert.equal((await call(b,'large_context')).body.toolError.code,'evidence_budget_exceeded');
 const id='11111111-1111-4111-8111-111111111111';
 const bounded=await startBridge({...reader,evidence:async()=>[{id,capturedAt:'2026-01-01',appName:'Fixture',ocrText:'generated'}]},{question:'Fixture',evidenceIds:[id]},3);t.after(()=>bounded.close());assert.equal((await call(bounded,'large_context')).status,400);
});
