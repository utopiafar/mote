const test=require('node:test');
const assert=require('node:assert/strict');
const {mkdtempSync,appendFileSync,readFileSync}=require('node:fs');
const {join}=require('node:path');
const {tmpdir}=require('node:os');
const {recoveryGuard}=require('./material-load-fixture.cjs');
test('recovery rejects a fresh budget, persists any forbidden query before failing, and never invokes a provider',()=>{
 assert.throws(()=>recoveryGuard({historicalUsageIds:[],expectedUsageIds:['old1','old2'],jobId:'existing'}),/exactly two/);
 assert.throws(()=>recoveryGuard({historicalUsageIds:['old1','changed'],expectedUsageIds:['old1','old2'],jobId:'existing'}),/history differs/);
 const root=mkdtempSync(join(tmpdir(),'mote-recovery-guard-')),log=join(root,'attempts.jsonl');let stopped=0;
 const guard=recoveryGuard({historicalUsageIds:['old1','old2'],expectedUsageIds:['old1','old2'],jobId:'existing',recordAttempt:e=>appendFileSync(log,JSON.stringify(e)+'\n',{mode:0o600}),onViolation:()=>{stopped++;assert.equal(JSON.parse(readFileSync(log,'utf8')).attempt,1);}});
 assert.deepEqual(guard.snapshot(),{historicalFake:2,newFake:0,queryAttempts:0,realModels:0});
 assert.throws(()=>guard.query({question:'generated-do-not-log-prompt'}),/forbids/);assert.equal(stopped,1);assert.equal(guard.snapshot().queryAttempts,1);assert.equal(guard.snapshot().newFake,0);assert.ok(!readFileSync(log,'utf8').includes('generated-do-not-log-prompt'));
});
test('recovery permits reads, existing drain and only the frozen job cancellation, never new input or retry',()=>{
 const guard=recoveryGuard({historicalUsageIds:['1','2'],expectedUsageIds:['1','2'],jobId:'frozen-job',recordAttempt:()=>{throw Error('unexpected query');}});
 for(const [method,path] of [['GET','/api/fixture/state'],['POST','/api/fixture/drain'],['POST','/api/memory-jobs/frozen-job/cancel']])assert.ok(guard.allows(method,path));
 for(const path of ['/api/fixture/configure','/api/fixture/transcript','/api/fixture/conversation','/api/sources/generated-load/items/batch','/api/notes','/api/memory-jobs','/api/memory-jobs/frozen-job/retry','/api/memory-jobs/frozen-job/resume','/api/memory-jobs/other/cancel'])assert.equal(guard.allows('POST',path),false,path);
 assert.equal(guard.allows('PUT','/api/source-pipelines/generated-load'),false);
 assert.deepEqual(guard.snapshot(),{historicalFake:2,newFake:0,queryAttempts:0,realModels:0});
});
