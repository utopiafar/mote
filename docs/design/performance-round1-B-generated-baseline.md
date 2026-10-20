# Round 1 B: generated selection baseline and SQLite observations

This is newly executed diagnostic evidence for the
[approved scheduling plan](performance-round1-B-scheduling-review.md). It is
not an optimized implementation, production tick measurement, application
startup/claim/lifecycle test, or final module/integration acceptance.

## Exact inputs and method

- Frozen product base: `af11ab7c3e9fb5f38deaea4e4bae11462a7306b4`.
- Documentation head at execution: `00decc5f2b3a965079215082b85d8d532c0db03c`.
- `apps/server/src/execution-engine.ts` was asserted byte-identical to the
  frozen base. Source SHA-256:
  `d7c31ec82b71b124265f2520a212d2b55579413efba341547a8388fefc26c0b9`.
- Exact source-extracted `view`, lane/limit/capacity predicates, candidate SQL
  and scan loop executed against generated native in-memory SQLite. This does
  **not** instantiate ExecutionEngine or scoped TaskExecution.
- Source snippet hashes: view
  `4ea831d1983d0e1c99a7ff86e799f71322dd18aca6f49c74e830269bcb16e9d0`;
  methods `30b8c0b4a466b9297eb59888a5280544060270e3ae3281b76132580e7f1b8c80`;
  candidate SQL/scan
  `6893d574b61b8cde3e436c28642acedceab17db1fe69f5312eab703295b3f47c`.
- Each generated input has 1,024 bytes of ASCII padding plus unit identity and
  JSON structure. Four generated users; distinct queued operation ids; no
  dependencies/resources/fairness history, no local active promises; fixed time.
  Six saturated unpartitioned scales and one cross-pool shared-unit tail case.
- Each case uses one warmup and five measured synchronous scans. Counters and
  byte counting add overhead. All five samples have identical work counts;
  this is not a production latency distribution. No clone strategy, optimized
  path, event-loop delay, RSS, live provider or physical device was measured.
- Runtime: Node `v26.11.1`, SQLite `3.53.4`, macOS arm64, Apple M5 Max,
  18 logical CPUs, 64 GiB memory; Node binary
  `/opt/homebrew/Cellar/node/26.11.1/bin/node`. The measurement command has no
  concurrent heavy/light campaign command by construction; other host load was
  not controlled. `stripTypeScriptTypes` emitted its normal experimental warning.

## Baseline results

Counts are for one scan, excluding warmup and other samples. “Running rows”
counts repeated returned rows, not distinct work. All rows remain waiting and no
claim is attempted in saturated cases. Each case executes one candidate SQL.

| Waiting | Running | Pool shape | Running queries | Running rows returned | JSON decodes | JSON bytes decoded | Median ms | Min–max ms |
| ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 100 | 4 | Saturated | 100 | 400 | 600 | 634,380 | 3.970 | 3.696–5.740 |
| 1,000 | 4 | Saturated | 1,000 | 4,000 | 6,000 | 6,345,780 | 35.998 | 33.902–42.690 |
| 5,000 | 4 | Saturated | 5,000 | 20,000 | 30,000 | 31,737,780 | 133.767 | 130.862–137.038 |
| 100 | 32 | Saturated | 100 | 3,200 | 3,400 | 3,593,380 | 9.507 | 8.847–10.030 |
| 1,000 | 32 | Saturated | 1,000 | 32,000 | 34,000 | 35,935,780 | 79.573 | 79.157–79.929 |
| 5,000 | 32 | Saturated | 5,000 | 160,000 | 170,000 | 179,687,780 | 400.068 | 390.510–404.106 |
| 1,000 + tail | 4 | Cross-pool same unit | 1,001 | 4,004 | 6,007 | 6,353,172 | 27.490 | 25.888–29.057 |

For saturated cases, measured counts are `W` running queries and `W*(R+2)`
JSON decodes. The tail case still selects `same-unit` after the saturated prefix:
it has 1,001 available-callback evaluations and 5,005 partition evaluations.
The selected tail adds one extra decode for static resource arbitration. Its
resource-turn fixture returns true only for this resource-free tail; it is not
a test of resource arbitration, claim or cross-process correctness. This case
illustrates why stopping a pool at its first capacity refusal is invalid.

These measurements establish repeated work in the extracted current algorithm.
They do not establish how much an approved implementation will save, or how
long production waits. Production callbacks can read configuration, reap flights
and access other tables; those costs and real lifecycle states need the plan's
future actual-engine/consumer checks. No old failed-child timing was used.

## Native SQLite observation characterization

A second, tiny generated experiment uses native SQLite directly, not extracted
or real engine code. It opens two connections and an active waiting-row iterator,
compares the reader's repeated running query and invalidation token, commits
through the other connection, then closes the iterator. Requested and actual
journal modes are asserted for both connections; SQLite is `3.53.4` in both.

| Journal mode | External update/insert while reader iterates | Reader during iterator | After iterator closes and writer commits |
| --- | --- | --- | --- |
| WAL | Commit succeeds | Old running id `r`; token stays `3:2` | New running id `new`; token becomes `3:3` |
| DELETE | Commit is blocked by the reader and rolled back | Old running id `r`; token stays `3:1` | Retried commit succeeds; id `new`, token `3:2` |

Both modes also demonstrate: an uncommitted/rolled-back external write changes
no reader token; a local rolled-back write changes `total_changes`; a lease with
`lease_until=300` is present at time 299, absent at 300 and present again if time
moves back to 299. These cases support conservative invalidation requirements.
They do not prove every product callback/iterator/transaction combination. The
approved original-vs-optimized engine barrier tests remain unrun.

## Execution, cleanup and evidence identity

Newly executed command, from the B worktree:

```sh
python3 /Users/utopiafar/.codex/orchestration/mote-performance-20261020-l33r5sf0/run-resource.py --owner B --kind heavy --wait-seconds 180 -- node --input-type=module -e "await import('file:///Users/utopiafar/.codex/orchestration/mote-performance-20261020-l33r5sf0/B/artifacts/selection-baseline.mjs'); await import('file:///Users/utopiafar/.codex/orchestration/mote-performance-20261020-l33r5sf0/B/artifacts/sqlite-selection-observation.mjs');"
```

Heavy lease `e4472c0d-e954-4030-90a5-9a469139ecdc`, process group `16741`:
command exit 0, `commandFinished:true`, `cleanupConfirmed:true`, lease released.
Acquired at 2026-10-20 20:37:01.653 and released at 20:37:06.001 Asia/Shanghai
(the 4.348 seconds include process startup and both diagnostics, not queue wait).
Seven in-memory fixture databases and the version database closed; both native
experiment connections closed for each mode and its B-owned temporary directory
was removed. No listener/server, provider, device, application UI, credential,
personal content, dependency tree or build output was used/created.

Two earlier zero-wait attempts and one earlier 180-second wait returned
`UNRUN`/exit 75 because the campaign resource was occupied; they performed no
test work and are not failed product checks. The successful attempt waited on
the same resource gate without preempting another owner. A read-only review
corrected the tail's extra-decode assertion before first execution and added
actual journal-mode/version observations; no failed test was relaxed.

Original local evidence, all under the B campaign `artifacts` directory:

| File | SHA-256 |
| --- | --- |
| `selection-baseline.mjs` | `8c6c42233d69fdb65bef9cd76aac49bf9dca402b794b23c3f8bef99a7dcfce20` |
| `selection-baseline.json` | `06fb6ec5192446b7b54780b8ac6349936bded33c2c460028880c972af468341d` |
| `sqlite-selection-observation.mjs` | `39c931bda2890bc4fd6e0bb5b54ecb6ccee5e41317d9b1c47cbc2014fca9684e` |
| `sqlite-selection-observation.json` | `eef7939f204cd2f519a600d8d0d84de1766b3e656b6c8c4c76d553ca245533ef` |

The two executed scripts are reproduced below verbatim for review/reproduction.
They are documentation, not a newly installed product test/entry point. Run
only through the campaign gate in this environment. On a different machine,
adapt the explicitly owned diagnostic output/temp directory and record the new
script identity; do not point them at a product profile.

No application check receipt is `REUSED`. Existing source/tests/ADRs were read
as design evidence only. Full `check:affected`, `check:local`, application builds,
real-engine tests, consumer suites, UI, device and live-model checks were not
run. The only source changes in this branch are documentation. Scheduling plan
approval is complete; Evidence/organizer remain separate bounded plans, and
round 2/final integrated acceptance remain with the controller.

## Executed selection diagnostic source

```js
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {stripTypeScriptTypes} from 'node:module';
import {DatabaseSync} from 'node:sqlite';
import {performance} from 'node:perf_hooks';
import os from 'node:os';
import {execFileSync} from 'node:child_process';

// Diagnostic extraction only. No product file, dependency tree, server, or profile is changed.
const base='af11ab7c3e9fb5f38deaea4e4bae11462a7306b4';
const path='apps/server/src/execution-engine.ts',source=readFileSync(path,'utf8');
const documentationHead=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
assert.equal(source,execFileSync('git',['show',base+':'+path],{encoding:'utf8'}),'product source must match the frozen base exactly; documentation-only commits may advance HEAD');
const sha=value=>createHash('sha256').update(value).digest('hex');
const view=source.split('\n').find(line=>line.startsWith('const view='));
const methods=source.slice(source.indexOf(' private lane('),source.indexOf(' /** Safe resource projection:'));
const scan=source.slice(source.indexOf('     const candidates='),source.indexOf('     if(!row)break;'));
assert.ok(view&&methods.includes('private capacityAvailable(')&&scan.includes('this.staticResourceTurn'));
const code=stripTypeScriptTypes(`function load(){${view}\nclass ExtractedSelection {${methods}\n scan(pool,handlers,lane){const unclaimed=new Set();${scan}return row;}\n}\nreturn ExtractedSelection;}`,{mode:'strip'})+'\nreturn load();';
const inputBytes=1024,now=2000000000000,rows=[];
function fixture(waiting,running,partitioned=false){
 const db=new DatabaseSync(':memory:');
 db.exec(`CREATE TABLE execution_steps(id TEXT PRIMARY KEY,operation_id TEXT NOT NULL,kind TEXT NOT NULL,pool TEXT NOT NULL,input TEXT NOT NULL,state TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,available_at INTEGER NOT NULL DEFAULT 0,lease_until INTEGER NOT NULL DEFAULT 0,fence TEXT,error TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,recovery_deadline INTEGER NOT NULL DEFAULT 0,user_id TEXT NOT NULL DEFAULT '',user_position INTEGER NOT NULL DEFAULT 0,authorization_epoch INTEGER,grant_id TEXT);
 CREATE INDEX execution_ready ON execution_steps(pool,state,available_at,created_at);
 CREATE TABLE execution_dependencies(step_id TEXT,dependency_id TEXT,PRIMARY KEY(step_id,dependency_id));
 CREATE TABLE execution_resources(step_id TEXT,resource_key TEXT,PRIMARY KEY(step_id,resource_key));
 CREATE TABLE execution_dynamic_resources(step_id TEXT,resource_key TEXT,fence TEXT,PRIMARY KEY(step_id,resource_key));
 CREATE TABLE execution_resource_releases(step_id TEXT,resource_key TEXT,fence TEXT,PRIMARY KEY(step_id,resource_key));
 CREATE TABLE execution_user_fairness(pool TEXT,user_id TEXT,last_started INTEGER,PRIMARY KEY(pool,user_id));
 CREATE TABLE execution_stage_groups(step_id TEXT PRIMARY KEY,group_key TEXT);
 CREATE TABLE execution_stage_fairness(pool TEXT,user_id TEXT,group_key TEXT,last_started INTEGER,PRIMARY KEY(pool,user_id,group_key));
 CREATE TABLE execution_fairness(pool TEXT,operation_id TEXT,last_started INTEGER,PRIMARY KEY(pool,operation_id));`);
 const insert=db.prepare('INSERT INTO execution_steps(id,operation_id,kind,pool,input,state,lease_until,created_at,updated_at,user_id,authorization_epoch) VALUES(?,?,?,?,?,?,?,?,?,?,?)');
 const payload=unit=>JSON.stringify({unit,generated:'x'.repeat(inputBytes)});
 db.exec('BEGIN');
 for(let i=0;i<running;i++)insert.run('r'+i,'running:'+i,'generated',partitioned?'physical':'generated',payload('unit:'+i),'running',now+30000,now,now,'generated-user-'+i%4,1);
 for(let i=0;i<waiting;i++)insert.run('w'+i,'waiting:'+i,'generated','generated',payload('waiting:'+i),'waiting',0,now+i,now,'generated-user-'+i%4,1);
 if(partitioned)insert.run('same-unit','same-unit','generated','generated',payload('unit:0'),'waiting',0,now+waiting,now,'generated-user-0',1);
 db.exec('COMMIT');
 let metrics;
 const reset=()=>metrics={parses:0,decodedBytes:0,runningQueries:0,runningRows:0,candidateQueries:0,capacityCallbacks:0,availableCallbacks:0};
 reset();
 const CountedJSON={stringify:JSON.stringify,parse:json=>{metrics.parses++;metrics.decodedBytes+=Buffer.byteLength(json);return JSON.parse(json);}};
 const Class=new Function('JSON',code)(CountedJSON),engine=new Class();
 engine.now=()=>now;engine.active=new Map();engine.handlers=new Map([['generated',{kind:'generated',pool:'generated',concurrency:()=>running}]]);
 engine.admissions=new Map();
 if(partitioned)for(const pool of ['generated','physical'])engine.admissions.set(pool,{lane:()=> 'background',concurrency:{background:()=>running,interactive:()=>1},available:()=>{metrics.availableCallbacks++;return true;},partition:step=>{metrics.capacityCallbacks++;return {key:'generated-shared',unit:step.input.unit,concurrency:running};}});
 engine.store={db:{prepare:sql=>{const statement=db.prepare(sql),isRunning=sql.startsWith('SELECT * FROM execution_steps WHERE state=');if(isRunning)metrics.runningQueries++;if(sql.startsWith('SELECT e.* FROM execution_steps e LEFT JOIN'))metrics.candidateQueries++;return {iterate:(...args)=>statement.iterate(...args),all:(...args)=>{const result=statement.all(...args);if(isRunning)metrics.runningRows+=result.length;return result;}};}}};
 // Saturated rows must never reach resource arbitration; the admitted same-unit tail has no resources.
 engine.staticResourceTurn=step=>{assert.equal(step.id,'same-unit');return true;};
 return {db,engine,reset,metrics:()=>({...metrics})};
}
for(const [waiting,running,partitioned] of [[100,4,false],[1000,4,false],[5000,4,false],[100,32,false],[1000,32,false],[5000,32,false],[1000,4,true]]){
 const f=fixture(waiting,running,partitioned);
 try{
  const run=()=>{f.reset();const start=performance.now(),row=f.engine.scan('generated',[{kind:'generated'}],'background'),elapsedMs=performance.now()-start;assert.equal(row?.id,partitioned?'same-unit':undefined);return {elapsedMs,...f.metrics()};};
  run();const samples=Array.from({length:5},run),sorted=samples.map(x=>x.elapsedMs).sort((a,b)=>a-b),counts=samples.map(({elapsedMs,...counts})=>counts);assert.ok(counts.every(x=>JSON.stringify(x)===JSON.stringify(counts[0])));
  assert.equal(counts[0].runningQueries,waiting+(partitioned?1:0));assert.equal(counts[0].parses,(waiting+(partitioned?1:0))*(running+2)+(partitioned?1:0),'the admitted same-unit tail also materializes a view for static resource arbitration');
  rows.push({waiting,running,partitioned,inputPayloadPaddingBytes:inputBytes,warmups:1,samples:5,medianMs:sorted[2],minMs:sorted[0],maxMs:sorted[4],sampleMs:samples.map(x=>x.elapsedMs),counts:counts[0],selectedId:partitioned?'same-unit':null});
 }finally{f.db.close();}
}
const versionDb=new DatabaseSync(':memory:');let sqliteVersion;try{sqliteVersion=versionDb.prepare('SELECT sqlite_version() version').get().version;}finally{versionDb.close();}
const result={base,documentationHead,source:path,sourceSha256:sha(source),method:'Extracted exact view, lane, limit, capacity, capacityAvailable and candidate SQL/scan from frozen source; native in-memory SQLite; no claim/recover/lease renewal/host startup. Resource tail is a fixed no-resource fixture. Instrumentation adds counter and byte-count overhead. Baseline only; no optimized implementation measured.',snippets:{view:sha(view),methods:sha(methods),scan:sha(scan)},environment:{node:process.version,sqlite:sqliteVersion,platform:process.platform,arch:process.arch,cpu:os.cpus()[0].model,logicalCpus:os.cpus().length,memoryBytes:os.totalmem(),execPath:process.execPath},rows,cleanup:{fixtureDatabases:'all seven fixture DBs and version DB closed in finally; in-memory, no files or child processes',serverStarted:false,dependenciesInstalled:false,personalDataUsed:false}};
writeFileSync(new URL('selection-baseline.json',import.meta.url),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result,null,2));
```

## Executed native observation source

```js
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';

// Native SQLite observation characterization. This is not ExecutionEngine or a product regression.
const ownedRoot='/Users/utopiafar/.codex/orchestration/mote-performance-20261020-l33r5sf0/B/tmp';
const directory=mkdtempSync(join(ownedRoot,'sqlite-observation-')),results=[];
const token=db=>{const own=db.prepare('SELECT total_changes() n');own.setReadBigInts(true);return String(own.get().n)+':'+String(db.prepare('PRAGMA data_version').get().data_version);};
const running=(db,now=100)=>db.prepare("SELECT id FROM execution_steps WHERE state='running' AND lease_until>? ORDER BY id").all(now).map(r=>r.id);
try{
 for(const mode of ['WAL','DELETE']){
  const path=join(directory,mode+'.sqlite'),db=new DatabaseSync(path),other=new DatabaseSync(path);let iterator;
  try{
   db.exec('PRAGMA journal_mode='+mode+'; PRAGMA busy_timeout=0; CREATE TABLE execution_steps(id TEXT PRIMARY KEY,state TEXT,lease_until INTEGER); INSERT INTO execution_steps VALUES (\'r\',\'running\',200),(\'w1\',\'waiting\',0),(\'w2\',\'waiting\',0)');other.exec('PRAGMA busy_timeout=0');
   const actualModes=[db,other].map(connection=>connection.prepare('PRAGMA journal_mode').get().journal_mode);assert.deepEqual(actualModes,[mode.toLowerCase(),mode.toLowerCase()]);const sqliteVersion=db.prepare('SELECT sqlite_version() version').get().version;
   const before=token(db);other.exec('BEGIN; UPDATE execution_steps SET state=\'cancelled\' WHERE id=\'r\'');assert.equal(token(db),before);other.exec('ROLLBACK');assert.equal(token(db),before);
   iterator=db.prepare("SELECT * FROM execution_steps WHERE state='waiting' ORDER BY id").iterate();assert.equal(iterator.next().value.id,'w1');
   const duringBefore=token(db),rowsBefore=running(db);let externalCommit;
   try{other.exec("BEGIN; UPDATE execution_steps SET state='cancelled' WHERE id='r'; INSERT INTO execution_steps VALUES('new','running',300); COMMIT");externalCommit='committed';}catch(error){if(other.isTransaction)other.exec('ROLLBACK');assert.match(error.message,/locked/);externalCommit='blocked_by_reader';}
   const duringAfter=token(db),rowsAfter=running(db);assert.deepEqual(rowsAfter,rowsBefore,'an active reader must not observe a hybrid snapshot');assert.equal(duringAfter,duringBefore);
   iterator.return();iterator=undefined;
   if(externalCommit==='blocked_by_reader')other.exec("BEGIN; UPDATE execution_steps SET state='cancelled' WHERE id='r'; INSERT INTO execution_steps VALUES('new','running',300); COMMIT");
   const after=token(db);assert.notEqual(after,duringBefore);assert.deepEqual(running(db),['new']);
   const beforeLocal=token(db);db.exec("BEGIN; UPDATE execution_steps SET lease_until=400 WHERE id='new'; ROLLBACK");assert.notEqual(token(db),beforeLocal);assert.deepEqual(running(db,299),['new']);assert.deepEqual(running(db,300),[]);assert.deepEqual(running(db,299),['new'],'backwards clocks can resurrect an omitted lease');
   results.push({mode,actualModes,sqliteVersion,externalCommit,duringBefore,duringAfter,rowsBefore,rowsAfter,after,afterRows:running(db),localRollbackInvalidated:true,exactLeaseBoundary:true,backwardsClock:true});
  }finally{iterator?.return();if(other.isTransaction)other.exec('ROLLBACK');if(db.isTransaction)db.exec('ROLLBACK');other.close();db.close();}
 }
}finally{rmSync(directory,{recursive:true,force:true});}
const result={method:'Native SQLite two connections, generated tiny rows and active waiting-row iterator; journal/snapshot and invalidation characterization only, not real engine/startup/claim validation',node:process.version,results,cleanup:{allConnectionsClosed:true,temporaryDirectoryRemoved:true,personalDataUsed:false}};
writeFileSync(new URL('sqlite-selection-observation.json',import.meta.url),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
```
