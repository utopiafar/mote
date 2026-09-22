import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {scanVectors} from '../src/vector-work.js';
import {Store} from '../src/store.js';

test('read-only vector worker covers older evidence, bounds IPC, preserves scope and skips corrupt vectors',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-vector-worker-')),store=new Store(directory);
 try{
  const records=Array.from({length:4200},(_,n)=>({id:randomUUID(),deviceId:n===4199?'outside':'persona',deviceName:'Generated',platform:'import',capturedAt:new Date(Date.parse('2026-07-01')+Math.floor(n/100)*86400000+n%100*60000).toISOString(),durationMs:0,source:'note',ocrText:`Generated vector fixture ${n}`}));
  for(let offset=0;offset<records.length;offset+=100)await store.ingestBatch(records.slice(offset,offset+100));
  store.db.exec("UPDATE captures SET embedding='[0,1]',embedding_model='fixture'");
  store.db.prepare("UPDATE captures SET embedding='[1,0]' WHERE id IN (?,?)").run(records[0].id,records[4199].id);
  store.db.prepare("UPDATE captures SET embedding='invalid' WHERE id=?").run(records[1].id);
  const scan=(await scanVectors({path:join(directory,'mote.sqlite'),queries:[store.vectorQuery('fixture',{deviceId:'persona'})],vector:[1,0],limit:3},AbortSignal.timeout(5000)))[0];
  assert.equal(scan.candidates[0].id,records[0].id);assert.equal(scan.candidates.length,3);assert.equal(scan.coverage.scanned,4199);assert.equal(scan.coverage.invalid,1);assert.equal(scan.coverage.bounded,false);
  assert.ok(scan.candidates.every(c=>c.id!==records[4199].id));assert.ok(JSON.stringify(scan).length<1000,'only Top-K identities cross IPC');
 }finally{store.close();rmSync(directory,{recursive:true,force:true});}
});

test('cancellation terminates an in-flight vector worker and leaves the API thread responsive',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-vector-cancel-')),store=new Store(directory);
 try{
  const controller=new AbortController(),started=performance.now();
  const task=scanVectors({path:join(directory,'mote.sqlite'),queries:[{sql:'WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<1000000000) SELECT x id,\'[1,0]\' embedding FROM n',values:[]}],vector:[1,0],limit:1},controller.signal);
  const rejected=assert.rejects(task);setTimeout(()=>controller.abort(new Error('generated cancellation')),100);await rejected;
  assert.ok(performance.now()-started<1000,'CPU work blocked cancellation on the host');
 }finally{store.close();rmSync(directory,{recursive:true,force:true});}
});
