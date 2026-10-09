import type {ImportMemoryProgress} from '@mote/shared';
import type {Store} from './store.js';
import type {MemoryWorkMember} from './memory-work-contract.js';

type State=Exclude<keyof ImportMemoryProgress,'total'|'receipts'|'jobIds'>;
const priority:State[]=['unavailable','failed','waitingForModel','running','pending','paused','cancelled','disabled','completed'];
type Chunk={id:string;key:string;offset:number;length:number;fingerprint:string};
type Job={status:string;workPackage?:{inputs?:{ref:string;sourceId:string;inputKey:string;scope:string}[]};authorizedChunks?:Chunk[];materialRefs?:Record<string,string>};
type Batch={status:string;errorCode?:string;supersededBy?:string[];chunks:Chunk[];coverage?:MemoryWorkMember[];materialRefs?:Record<string,string>};

function memberProgress(job:Job,batches:Batch[],checkpoints:Set<string>,sourceId:string,inputKey:string,scope:string):State|undefined {
  if(!job.workPackage)return;
  const input=job.workPackage.inputs?.find(input=>input.sourceId===sourceId&&input.inputKey===inputKey&&input.scope===scope);
  if(!input)return;
  const targets=(job.authorizedChunks??[]).filter(chunk=>job.materialRefs?.[chunk.id]===input.ref);
  if(!targets.length)return job.status==='completed'?'completed':undefined;
  const leaves=batches.filter(batch=>!batch.supersededBy?.length&&batch.chunks.some(chunk=>batch.materialRefs?.[chunk.id]===input.ref&&targets.some(target=>target.id===chunk.id&&target.fingerprint===chunk.fingerprint)));
  const committed=leaves.filter(batch=>batch.status==='completed').flatMap(batch=>batch.chunks.filter(chunk=>checkpoints.has(chunk.key)&&batch.coverage?.some(member=>member.id===chunk.id&&member.offset===chunk.offset&&member.length===chunk.length&&member.fingerprint===chunk.fingerprint&&member.inputKey===inputKey&&member.scope===scope&&(member.state==='checked'||member.state==='no_candidates'))));
  const complete=targets.every(target=>{
    if(checkpoints.has(target.key))return true;
    // A saturated source range can be split repeatedly. Require its complete
    // interval, never merely a successful sibling or a superseded parent.
    let end=target.offset;
    for(const chunk of committed.filter(chunk=>chunk.id===target.id&&chunk.fingerprint===target.fingerprint).sort((a,b)=>a.offset-b.offset)){
      if(chunk.offset>end)break;
      end=Math.max(end,chunk.offset+chunk.length);
    }
    return end>=target.offset+target.length;
  });
  if(complete)return 'completed';
  if(['cancelled','paused','pausing','waiting_for_model'].includes(job.status))return;
  if(leaves.some(batch=>['failed','invalidated'].includes(batch.status)&&batch.errorCode!=='memory_context_required'))return 'failed';
  if(leaves.some(batch=>batch.status==='running'))return 'running';
  if(leaves.some(batch=>batch.status==='pending'||batch.errorCode==='memory_context_required'))return 'pending';
}

/** Read-only projection of the original receipt queue. Never authorizes or creates work. */
export function importMemoryProgress(store:Store,captureIds:readonly string[]):ImportMemoryProgress|undefined {
  if(!captureIds.length||!store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='memory_input_authorizations'").get())return;
  const progress:ImportMemoryProgress={total:new Set(captureIds).size,receipts:0,completed:0,pending:0,running:0,failed:0,waitingForModel:0,paused:0,cancelled:0,disabled:0,unavailable:0,jobIds:[]};
  const records=new Map<string,State[]>(),jobs=new Set<string>(),receipts=new Set<string>(),jobValues=new Map<string,Job>();
  // json_each keeps large imports within SQLite's bound-parameter limit.
  const rows=store.db.prepare(`SELECT DISTINCT original.value AS id,c.id AS present,h.capture_id AS current_id,
    a.source_id,a.input_key,a.scope,a.authorized,a.revoked_at,a.job_id,j.json,r.error
    FROM json_each(?) original LEFT JOIN captures c ON c.id=original.value
    LEFT JOIN source_versions v ON v.capture_id=c.id
    LEFT JOIN source_heads h ON h.source_id=v.source_id AND h.external_id=v.external_id
    LEFT JOIN memory_input_authorizations a ON a.capture_id=c.id
    LEFT JOIN memory_jobs j ON j.id=a.job_id
    LEFT JOIN material_memory_requests r ON r.input_key=a.input_key AND r.scope=a.scope
      AND r.material_id IN (SELECT id FROM material_heads WHERE source_id=a.source_id)`)
    .all(JSON.stringify([...new Set(captureIds)]));
  for(const row of rows)if(row.job_id&&row.json&&!jobValues.has(String(row.job_id)))jobValues.set(String(row.job_id),JSON.parse(String(row.json)) as Job);
  const packageIds=[...jobValues].filter(([,job])=>job.workPackage).map(([id])=>id),batches=new Map<string,Batch[]>(),checkpointKeys=new Set<string>();
  for(const row of store.db.prepare('SELECT job_id,json FROM memory_batches WHERE job_id IN (SELECT value FROM json_each(?))').all(JSON.stringify(packageIds))){
    const id=String(row.job_id),batch=JSON.parse(String(row.json)) as Batch,list=batches.get(id)??[];list.push(batch);batches.set(id,list);
    for(const chunk of batch.chunks??[])checkpointKeys.add(chunk.key);
  }
  for(const id of packageIds)for(const chunk of jobValues.get(id)!.authorizedChunks??[])checkpointKeys.add(chunk.key);
  const checkpoints=new Set(store.db.prepare('SELECT key FROM memory_checkpoints WHERE key IN (SELECT value FROM json_each(?))').all(JSON.stringify([...checkpointKeys])).map(row=>String(row.key)));
  for(const row of rows){
    const id=String(row.id),states=records.get(id)??[];records.set(id,states);
    if(row.scope)receipts.add(JSON.stringify([row.source_id,row.input_key,row.scope]));
    if(row.job_id)jobs.add(String(row.job_id));
    let state:State;
    if(!row.present||row.current_id&&row.current_id!==row.id)state='unavailable';
    else {
      const job=row.job_id?jobValues.get(String(row.job_id)):undefined,status=job?.status;
      const member=job?memberProgress(job,batches.get(String(row.job_id))??[],checkpoints,String(row.source_id),String(row.input_key),String(row.scope)):undefined;
      if(member==='completed'||status==='completed'&&!job?.workPackage)state='completed';
      else if(!row.authorized||row.revoked_at!==null&&row.revoked_at!==undefined)state='disabled';
      else if(member)state=member;
      else if(status==='failed')state='failed';
      else if(status==='waiting_for_model')state='waitingForModel';
      else if(status==='running'||status==='pausing')state='running';
      else if(status==='paused')state='paused';
      else if(status==='cancelled')state='cancelled';
      else if(row.error)state='failed';
      else state='pending';
    }
    states.push(state);
  }
  progress.receipts=receipts.size;
  for(const states of records.values())progress[priority.find(state=>states.includes(state))??'unavailable']++;
  progress.jobIds=[...jobs];return progress;
}
