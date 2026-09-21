/** Opt-in existing-data benchmark. No model calls, original text output or remote traffic. */
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {resolve,join} from 'node:path';
import {writeFileSync} from 'node:fs';
import {Store} from '../apps/server/src/store.js';
import {MemoryStore} from '../apps/server/src/memory.js';
import {Conversations} from '../apps/server/src/conversations.js';
import {MemoryPipeline} from '../apps/server/src/memory-pipeline.js';
import {MaintenanceWorker} from '../apps/server/src/maintenance.js';
import type {Config} from '../apps/server/src/config.js';
const root=process.argv[2],out=process.argv[3];
if(!root||!out||!root.includes('local-copy'))throw Error('Usage: benchmark-local-archive.ts PRIVATE_LOCAL_COPY OUTPUT_JSON; use a copy, not the active archive');
const directory=resolve(root),db=new DatabaseSync(join(directory,'mote.sqlite'),{readOnly:true});
function digest(db:DatabaseSync){const h=createHash('sha256');let count=0;for(const row of db.prepare('SELECT id,json FROM captures ORDER BY id').iterate()){h.update(String(row.id));h.update(String(row.json));count++;}return {count,sha256:h.digest('hex')};}
const before=digest(db);db.close();
const started=performance.now(),store=new Store(directory),memories=new MemoryStore(store),conversations=new Conversations(store);
const pipeline=new MemoryPipeline({store,memories,configured:()=>false,model:()=>'',query:async()=>{throw Error('No model calls permitted in read benchmark');}});
const migrationMs=Math.round(performance.now()-started),after=digest(store.db);
if(JSON.stringify(before)!==JSON.stringify(after))throw Error('Migration changed original observations');
let rawReads=0;memories.readEvidence=()=>{rawReads++;throw Error('Overview attempted to read original evidence');};
const worker=new MaintenanceWorker({dataDir:directory,maxStorageBytes:0,embeddingModel:''} as Config);
const cases:Record<string,()=>unknown>={status:()=>store.stats(),captures:()=>store.list({limit:20}),memoryOverview:()=>memories.page({limit:20}),conversations:()=>conversations.list({limit:20}),jobs:()=>pipeline.list(30),segments:()=>store.archive.page({limit:20})};
const first=conversations.list({limit:1}).items[0];if(first)cases.conversationTurns=()=>conversations.page(first.id);
const results:Record<string,unknown>={};
try{
 for(const [name,run] of Object.entries(cases)){
  const ms:number[]=[],bytes:number[]=[];
  for(let i=0;i<30;i++){await new Promise(r=>setTimeout(r,15));const start=performance.now(),value=run();ms.push(performance.now()-start);bytes.push(Buffer.byteLength(JSON.stringify(value)));}
  ms.sort((a,b)=>a-b);results[name]={samples:ms.length,medianMs:+ms[Math.floor(ms.length/2)].toFixed(2),p95Ms:+ms[Math.ceil(ms.length*.95)-1].toFixed(2),maxMs:+ms.at(-1)!.toFixed(2),maxResponseBytes:Math.max(...bytes)};
 }
 const report={originalsUnchanged:true,captures:after.count,migrationMs,rawReads,results,worker:worker.snapshot(),scope:'Existing local archive copy; maintenance backfill concurrent; no new screenshots; no model calls; no original content in report'};
 writeFileSync(out,JSON.stringify(report,null,2)+'\n',{mode:0o600});console.info(JSON.stringify(report,null,2));
}finally{await worker.close();await pipeline.close();store.close();}
