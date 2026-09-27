/** Bounded independent arrivals for the generated Material UI fixture, not a production queue. */
const {appendFileSync,writeFileSync}=require('node:fs');
const {performance}=require('node:perf_hooks');
const assert=require('node:assert/strict');
function startArrivals({records,ledgerPath,send,intervalMs=250,dispatchMs=2000,batchSize=20,deadlineMs=600000,maxPending=240}){
 assert.ok(records.length>0&&records.length<=maxPending);
 for(const n of [intervalMs,dispatchMs,batchSize,deadlineMs,maxPending])assert.ok(Number.isInteger(n)&&n>0);
 const start=performance.now(),wallStart=Date.now(),key=r=>JSON.stringify([r.sourceId,r.item.externalId,r.item.revision]);
 const schedule=records.map((r,i)=>({key:key(r),record:JSON.parse(JSON.stringify(r)),plannedMs:i*intervalMs}));
 assert.equal(new Set(schedule.map(x=>x.key)).size,schedule.length);
 writeFileSync(ledgerPath,'',{mode:0o600});
 let activeWork=Promise.resolve();
 let next=0,active=false,stopped=false,peakPending=0,resolve,reject;
 const pending=[],acknowledged=new Set(),attempts=new Map();
 const done=new Promise((yes,no)=>{resolve=yes;reject=no;});done.catch(()=>{});
 const log=(event,fields={})=>appendFileSync(ledgerPath,JSON.stringify({event,at:Date.now(),elapsedMs:performance.now()-start,...fields})+'\n');
 log('plan',{wallStart,schedule:schedule.map(({key,plannedMs,record})=>({key,plannedMs,sha256:record.sha256}))});
 function stop(error){if(stopped)return;stopped=true;clearInterval(arrivals);clearInterval(dispatcher);clearTimeout(deadline);if(error){log('failed',{message:error.message});reject(error);}else{log('complete',{uniqueAcknowledged:acknowledged.size,peakPending});resolve({wallStart,uniqueAcknowledged:acknowledged.size,peakPending,attempts:Object.fromEntries(attempts)});}}
 function enqueue(){try{const elapsed=performance.now()-start;while(next<schedule.length&&schedule[next].plannedMs<=elapsed){const entry=schedule[next++];pending.push(entry);peakPending=Math.max(peakPending,pending.length);assert.ok(pending.length<=maxPending,'Frozen pending bound exceeded');log('enqueued',{key:entry.key,plannedMs:entry.plannedMs,latenessMs:elapsed-entry.plannedMs,pending:pending.length});}}catch(e){stop(e);}}
 async function dispatch(){if(stopped||active||!pending.length)return;active=true;const selected=pending.slice(0,batchSize);
  try{for(const sourceId of [...new Set(selected.map(x=>x.record.sourceId))]){if(stopped)break;const entries=selected.filter(x=>x.record.sourceId===sourceId);for(const e of entries){attempts.set(e.key,(attempts.get(e.key)||0)+1);log('dispatched',{key:e.key,attempt:attempts.get(e.key)});}try{const result=await send(sourceId,entries.map(x=>x.record.item));if(stopped)return;assert.equal(result.receipts.length,entries.length,'Batch receipt count');assert.ok(result.receipts.every((x,i)=>x.receipt.state==='received'&&x.sourceId===sourceId&&x.externalId===entries[i].record.item.externalId&&x.revision===entries[i].record.item.revision),'Receipt identity or state mismatch');for(const e of entries){acknowledged.add(e.key);pending.splice(pending.indexOf(e),1);log('acknowledged',{key:e.key,attempt:attempts.get(e.key),pending:pending.length});}}catch(error){if(stopped)return;if(error.fatal||error.code==='ERR_ASSERTION')throw error;log('retry_pending',{keys:entries.map(e=>e.key),message:error.message});}}
  }catch(e){stop(e);}finally{active=false;if(!stopped&&next===schedule.length&&!pending.length)stop();}}
 const arrivals=setInterval(enqueue,Math.min(intervalMs,25)),dispatcher=setInterval(()=>{if(!active)activeWork=dispatch();},dispatchMs),deadline=setTimeout(()=>stop(Error('Independent arrival deadline exceeded')),deadlineMs);
 enqueue();
 return {done,settled:()=>activeWork,stop:()=>stop(Error('Independent arrivals stopped')),snapshot:()=>({planned:schedule.length,enqueued:next,pending:pending.length,active,uniqueAcknowledged:acknowledged.size,peakPending})};
}
module.exports={startArrivals};
