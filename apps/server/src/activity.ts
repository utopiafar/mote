import {decodeMemoryJob,decodeMemoryBatch} from './memory-private-storage.js';
import {queryWorkProgress,type WorkActivity,type WorkActivityPage,type WorkArtifact,type WorkBranch,type WorkEvent,type WorkProgress,type WorkState,type WorkQueryEvent,type OperationSummary} from '@mote/shared';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import {z} from 'zod';
import {moteText} from './i18n.js';
import {StoreError,type Store} from './store.js';
import type {Operations} from './operations.js';
import type {MemoryJob,MemoryBatch} from './memory-pipeline.js';
import type {ImportJob} from '@mote/shared';
import {ActivityMemoryIndex} from './activity-memory-index.js';

/** Only public metadata crosses this adapter. The runtime retains private values and evidence receipts. */
export type ActivityDelegationReader={list():{id:string}[];get(id:string):{id:string;operationId:string;goal:string;status:string;createdAt:string;updatedAt:string;units:{id:string;title:string;status:string;artifactId?:string;stepId:string;error?:string}[];events:{id?:number;type:string;at:string;message?:string;unitId?:string}[]};artifactMetadata(workId:string):{id:string;summary?:string;unitId:string}[]};
type ActivityBatch=MemoryBatch;
type ActivityJob=MemoryJob;
const state=(value:string):WorkState=>({succeeded:'completed',completed:'completed',running:'running',importing:'running',preparing:'running',pausing:'running',waiting:'waiting',queued:'waiting',pending:'waiting',waiting_for_model:'needs_input',waiting_for_input:'needs_input',awaiting_confirmation:'needs_input',needs_configuration:'needs_input',blocked:'needs_input',paused:'needs_input',invalidated:'stale',stale:'stale',failed:'failed',unsupported:'failed',cancelled:'cancelled',skipped:'excluded'} as Record<string,WorkState>)[value]??'waiting';
const terminal=new Set<WorkState>(['completed','excluded','cancelled']);
const stateRank=(value:string)=>({running:6,needs_input:5,stale:4,failed:3,waiting:2,completed:0,cancelled:-1,excluded:-2} as Record<string,number>)[state(value)]??2;
const rankSql=(value:string)=>`CASE ${value} WHEN 'running' THEN 6 WHEN 'pausing' THEN 6 WHEN 'waiting_for_model' THEN 5 WHEN 'waiting_for_input' THEN 5 WHEN 'blocked' THEN 5 WHEN 'paused' THEN 5 WHEN 'invalidated' THEN 4 WHEN 'stale' THEN 4 WHEN 'failed' THEN 3 WHEN 'succeeded' THEN 0 WHEN 'completed' THEN 0 WHEN 'cancelled' THEN -1 WHEN 'skipped' THEN -2 ELSE 2 END`;
function aggregate(values:WorkState[]):WorkState {if(!values.length)return 'waiting';for(const candidate of ['running','needs_input','stale','failed','waiting'] as const)if(values.includes(candidate))return candidate;return values.every(value=>value==='cancelled')?'cancelled':values.every(value=>value==='excluded')?'excluded':'completed';}
const goalKeys:Record<string,string>={image:'理解图片',file:'整理文件',capture:'理解采集内容',memory:'整理记忆',workflow:'整理上下文',import:'导入资料',query:'回答问题',insight:'生成生活回顾',embedding:'准备检索资料','material-index':'建立资料索引'};
const destinations:Record<string,string>={image:'library',file:'files',capture:'timeline',memory:'memories',workflow:'timeline',import:'imports',query:'ask',insight:'insights',embedding:'ask','material-index':'library'};
function lifecycleEvents(id:string,value:WorkState,createdAt:string,updatedAt:string):WorkEvent[]{return [{id:id+':started',type:'work.started',at:createdAt},...(terminal.has(value)||value==='failed'? [{id:id+':ended',type:value==='completed'||value==='excluded'?'work.completed':value==='failed'?'work.failed':'work.cancelled',at:updatedAt} as WorkEvent]:value==='needs_input'?[{id:id+':needs-input',type:'work.needs_input',at:updatedAt} as WorkEvent]:[])];}

/** Reads execution and product receipts. It neither reads original content nor makes semantic decisions. */
export class ActivityProjection {
 private memoryIndex:ActivityMemoryIndex;
 constructor(private store:Store,private operations:Operations,private options:{delegation?:ActivityDelegationReader}={}){this.memoryIndex=new ActivityMemoryIndex(store);if(this.has('delegation_works'))this.store.db.exec("CREATE INDEX IF NOT EXISTS activity_delegation_recent ON delegation_works(json_extract(json,'$.updatedAt') DESC,id)");}
 private has(table:string){return Boolean(this.store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));}
 private json<T>(table:string,id:string):T|undefined {if(!this.has(table))return;const row=this.store.db.prepare(`SELECT json FROM ${table} WHERE id=?`).get(id);return row?JSON.parse(String(row.json)) as T:undefined;}
 private sourceName(sourceId:string){const source=this.json<{name?:string}>('source_connections',sourceId);return source?.name??moteText('历史资料');}
 private memorySources(job:ActivityJob){return [...new Set((job.automaticGrants??(job.automaticGrant?[job.automaticGrant]:[])).map(grant=>grant.sourceId))].sort();}
 private memoryGroupData(id:string,known?:{id:string;sources:string[]}){
  const summary=known??this.memoryIndex.summary(id);if(!summary)return;
  const ids=this.memoryIndex.jobIds(id,summary.sources),jobs=this.store.db.prepare('SELECT json FROM memory_jobs WHERE id IN (SELECT value FROM json_each(?)) ORDER BY created_at,id').all(JSON.stringify(ids)).map(row=>decodeMemoryJob(this.store,String(row.json)));
  return {jobs,sources:summary.sources};
 }
 private memoryGroup(id:string,jobs:ActivityJob[],sources:string[]):WorkActivity {
  const importId=id.startsWith('memory-import:')?id.slice('memory-import:'.length):undefined,imported=importId?this.json<ImportJob>('import_jobs',importId):undefined;
  const items=new Map<string,WorkState[]>(),branches:WorkBranch[]=[],memories=new Set<string>(),evidence=new Set<string>(),operations:string[]=[],pending=new Set<string>();
  const receiptKey=(sourceId:string,inputKey:string)=>JSON.stringify([sourceId,inputKey]);
  const requests=this.has('material_memory_requests')&&this.has('material_heads')?this.store.db.prepare('SELECT r.material_id,r.input_key,r.scope,r.job_id,r.auto_authorized,h.source_id FROM material_memory_requests r JOIN material_heads h ON h.id=r.material_id WHERE r.job_id IN (SELECT value FROM json_each(?)) OR h.source_id IN (SELECT value FROM json_each(?))').all(JSON.stringify(jobs.map(job=>job.id)),JSON.stringify(importId?[]:sources)):[];
  const grantCaptures=new Map<string,string>();
  // Authorizations are the input manifest, so inputs not yet assigned to jobs remain visible.
  if(!importId&&this.has('memory_input_authorizations'))for(const sourceId of sources)for(const row of this.store.db.prepare('SELECT input_key,scope,job_id,capture_id FROM memory_input_authorizations WHERE source_id=? AND authorized=1 AND revoked_at IS NULL').all(sourceId)){const key=receiptKey(sourceId,String(row.input_key));items.set(key,[]);if(!row.job_id&&!requests.some(request=>request.source_id===sourceId&&request.input_key===row.input_key&&request.scope===row.scope&&request.job_id))pending.add(key);if(row.capture_id)grantCaptures.set(String(row.capture_id),key);}
  for(const row of requests)if(sources.includes(String(row.source_id))&&row.auto_authorized)items.set(receiptKey(String(row.source_id),String(row.input_key)),[]);
  for(const job of jobs){
   const batches=this.has('memory_batches')?this.store.db.prepare('SELECT json FROM memory_batches WHERE job_id=? ORDER BY idx').all(job.id).map(row=>decodeMemoryBatch(this.store,String(row.json))).filter(batch=>!batch.supersededBy?.length):[];
   operations.push('memory:'+job.id);job.evidenceIds.forEach(ref=>evidence.add(ref));job.memoryIds.forEach(ref=>memories.add(ref));
   const grants=job.automaticGrants??(job.automaticGrant?[job.automaticGrant]:[]);
   const pinByEvidence=new Map((job.materialInputs??[]).flatMap(pin=>pin.evidenceIds.map(ref=>[ref,pin] as const)));
   const identity=(ref:string,inputKey?:string)=>{
    const pin=pinByEvidence.get(ref),input=job.workPackage?.inputs?.find(input=>input.materialId===pin?.materialId||input.ref===job.materialRefs?.[ref]);
    if(input)return receiptKey(input.sourceId,input.inputKey);
    if(job.continuationOf&&pin){
     const seen=new Set<string>();let parent=jobs.find(value=>value.id===job.continuationOf);
     while(parent&&!seen.has(parent.id)){
      seen.add(parent.id);const original=parent.workPackage?.inputs?.find(value=>value.materialId===pin.materialId);if(original)return receiptKey(original.sourceId,original.inputKey);
      const selected=parent.materialInputs?.find(value=>value.materialId===pin.materialId);if(selected)return selected.materialId+':'+selected.fingerprint;
      parent=jobs.find(value=>value.id===parent!.continuationOf);
     }
    }
    const request=requests.find(row=>row.job_id===job.id&&row.material_id===pin?.materialId);
    if(request)return receiptKey(String(request.source_id),String(request.input_key));
    const raw=grantCaptures.get(ref);if(raw)return raw;
    const grant=grants.length===1?grants[0]:inputKey?grants.find(grant=>grant.inputKey===inputKey):undefined;
    if(grant)return receiptKey(grant.sourceId,grant.inputKey);
    return pin?pin.materialId+':'+pin.fingerprint:ref;
   };
   for(const ref of job.evidenceIds)if(!items.has(identity(ref)))items.set(identity(ref),[]);
   for(const batch of batches){
    batch.memoryIds.forEach(id=>memories.add(id));
    const coverage=batch.coverage?.length?batch.coverage.map(entry=>({ref:entry.id,inputKey:entry.inputKey,state:batch.status==='invalidated'?'stale' as WorkState:entry.state==='checked'||entry.state==='no_candidates'?'completed' as WorkState:entry.state==='needs_context'||entry.state==='needs_owner_input'?'needs_input' as WorkState:state(entry.state)})):batch.evidenceRanges.map(range=>({ref:range.id,inputKey:undefined,state:state(batch.status)}));
    for(const entry of coverage){const key=identity(entry.ref,entry.inputKey),values=items.get(key)??[];values.push(entry.state);items.set(key,values);}
    const unique=[...new Set(coverage.map(entry=>identity(entry.ref,entry.inputKey)))],resolved=unique.map(key=>aggregate(coverage.filter(entry=>identity(entry.ref,entry.inputKey)===key).map(entry=>entry.state)));
    branches.push({id:batch.id,title:batch.workerGoal??job.workPackage?.goal??moteText('整理第 {0} 组资料',batch.index+1),state:state(batch.status)==='completed'&&resolved.includes('needs_input')?'needs_input':state(batch.status),progress:{mode:'determinate',unit:'records',total:unique.length,completed:resolved.filter(value=>value==='completed').length,failed:resolved.filter(value=>value==='failed'||value==='stale').length,needsInput:resolved.filter(value=>value==='needs_input').length,excluded:resolved.filter(value=>value==='excluded').length},artifactIds:batch.memoryIds.filter(memoryId=>Boolean(this.store.db.prepare('SELECT 1 FROM memories WHERE id=?').get(memoryId))),operationId:'memory:'+job.id});
   }
   // A queued input plan or an input without ranges must not count as completed.
   if(!batches.length)for(const ref of job.evidenceIds)items.get(identity(ref))!.push(state(job.status)==='completed'?'waiting':state(job.status));
   if(!sources.length&&this.has('memory_input_plans'))for(const row of this.store.db.prepare('SELECT json FROM memory_input_plans WHERE job_id=?').all(job.id)){
    const plan=JSON.parse(String(row.json)) as {materialId:string;resolvedInput?:{fingerprint:string;evidenceIds:string[]};batchIds?:string[];coveredByBatchId?:string};
    if(!plan.resolvedInput?.evidenceIds.length)items.set(plan.materialId+':pending',[]);
   }
  }
  // Import scope is the owner's saved manifest. Source-wide receipts and
  // source connections established by another import never enlarge this goal.
  if(imported?.captureIds?.length&&this.has('memory_input_authorizations')){
   const refs=[...evidence],lineage=this.has('material_evidence_dependencies')?this.store.db.prepare('SELECT DISTINCT evidence_id FROM material_evidence_dependencies WHERE anchor_id IN (SELECT value FROM json_each(?))').all(JSON.stringify(refs)).map(row=>String(row.evidence_id)):[];
   const selected=new Set([...refs,...lineage]);
   for(const row of this.store.db.prepare('SELECT source_id,input_key,capture_id FROM memory_input_authorizations WHERE authorized=1 AND revoked_at IS NULL AND job_id IS NULL AND capture_id IN (SELECT value FROM json_each(?))').all(JSON.stringify(imported.captureIds)))if(!selected.has(String(row.capture_id))){const key=receiptKey(String(row.source_id),String(row.input_key));items.set(key,['waiting']);}
  }
  for(const key of pending){const values=items.get(key)??[];values.push('waiting');items.set(key,values);}
  const resolved=[...items.values()].map(values=>aggregate(values)),completed=resolved.filter(value=>value==='completed').length;
  const progress:WorkProgress={mode:'determinate',unit:'records',total:items.size,completed,failed:resolved.filter(value=>value==='failed'||value==='stale').length,needsInput:resolved.filter(value=>value==='needs_input').length,excluded:resolved.filter(value=>value==='excluded').length};
  const status=aggregate([...resolved,...jobs.filter(job=>state(job.status)!=='completed').map(job=>state(job.status))]),createdAt=jobs[0].createdAt,updatedAt=jobs.reduce((latest,job)=>latest>job.updatedAt?latest:job.updatedAt,createdAt);
  for(const memoryId of memories)if(!this.store.db.prepare('SELECT 1 FROM memories WHERE id=?').get(memoryId))memories.delete(memoryId);
  const artifacts:WorkArtifact[]=memories.size?[{id:id+':memories',kind:'memory',title:moteText('已保存 {0} 条记忆',memories.size),count:memories.size,ref:'memories'}]:[];
  return {id,kind:'memory',goal:imported?moteText('整理 {0} 的记忆',imported.name):sources.length?moteText('整理 {0} 的记忆',sources.map(source=>this.sourceName(source)).join(' · ')):jobs[0].workPackage?.goal??moteText('整理所选资料的记忆'),state:status,createdAt,updatedAt,progress,branches,artifacts,evidence:{count:evidence.size,refs:[...evidence].slice(0,50)},events:lifecycleEvents(id,status,createdAt,updatedAt),destination:'memories',technical:{operationIds:operations.slice(0,100)}};
 }
 private memoryList(id:string,sources:string[]):WorkActivity {
  const imported=id.startsWith('memory-import:')?this.json<ImportJob>('import_jobs',id.slice('memory-import:'.length)):undefined;
  const summary=this.memoryIndex.cardStats(id,sources,imported?.captureIds),status=({6:'running',5:'needs_input',4:'stale',3:'failed',2:'waiting',0:'completed','-1':'cancelled','-2':'excluded'} as Record<string,WorkState>)[summary.rank]??'waiting';
  return {id,kind:'memory',goal:imported?moteText('整理 {0} 的记忆',imported.name):sources.length?moteText('整理 {0} 的记忆',sources.map(source=>this.sourceName(source)).join(' · ')):moteText('整理所选资料的记忆'),state:status,createdAt:summary.createdAt,updatedAt:summary.updatedAt,
   progress:{mode:'determinate',unit:'records',total:summary.total,completed:summary.completed,failed:summary.failed,needsInput:summary.needsInput,excluded:summary.excluded},branches:[],branchCounts:{total:summary.branches,running:summary.runningBranches,completed:summary.completedBranches},
   artifacts:summary.memories?[{id:id+':memories',kind:'memory',title:moteText('已保存 {0} 条记忆',summary.memories),count:summary.memories,ref:'memories'}]:[],evidence:{count:summary.evidence,refs:[]},events:[],destination:'memories',technical:{operationIds:summary.operations}};
 }
 private operation(operation:OperationSummary):WorkActivity {
  const id=operation.id,rawId=id.slice(id.indexOf(':')+1),createdAt=new Date(operation.createdAt).toISOString(),updatedAt=new Date(operation.updatedAt).toISOString();
  let status=state(operation.state),goal=moteText(goalKeys[operation.kind]??'整理上下文'),progress:WorkProgress={mode:'semantic',stage:status==='completed'?'finished':status==='running'?'organizing':'preparing'},artifacts:WorkArtifact[]=[],events=lifecycleEvents(id,status,createdAt,updatedAt),refs:string[]=[],runId:string|undefined;
  if(operation.kind==='import'){
   const job=this.json<ImportJob>('import_jobs',rawId);if(job){goal=moteText('导入 {0}',job.name);status=state(job.status);progress=job.progress.total>0?{mode:'determinate',unit:'records',total:job.progress.total,completed:job.progress.processed,failed:job.status==='failed'?Math.max(0,job.progress.total-job.progress.processed):0,needsInput:job.status==='awaiting_confirmation'?Math.max(0,job.progress.total-job.progress.processed):0,excluded:0}:{mode:'semantic',stage:job.status==='preparing'?'planning':job.status==='completed'?'finished':'preparing'};refs=job.captureIds;artifacts=job.progress.imported?[{id:id+':records',kind:'import',title:moteText('已归档 {0} 条资料',job.progress.imported),count:job.progress.imported,ref:'imports'}]:[];}
  }
  if(operation.kind==='query'||operation.kind==='insight'){
   const run=this.json<{id:string;status:string;events:WorkQueryEvent[];turnId?:string;conversationId?:string;resultRunId?:string}> (operation.kind==='query'?'query_runs':'insight_runs',rawId);
   if(run){let resultSaved=false;runId=run.resultRunId??run.id;status=state(run.status);progress=queryWorkProgress(run.events,status==='completed');
    if(run.turnId){const turn=this.json<{question:string;result?:{citations:{id:string}[];runId:string};evidenceDeleted?:boolean}>('conversation_turns',run.turnId);if(turn&&!turn.evidenceDeleted){goal=turn.question;resultSaved=Boolean(turn.result);refs=turn.result?.citations.map(citation=>citation.id)??[];runId=turn.result?.runId??runId;}}
    if(operation.kind==='insight'&&run.resultRunId)resultSaved=Boolean(this.json('insights',run.resultRunId));
    if(status==='completed'&&resultSaved)artifacts=[{id:run.turnId??run.resultRunId??run.id,kind:operation.kind==='query'?'answer':'insight',title:moteText(operation.kind==='query'?'回答已归档':'生活回顾已保存'),ref:run.turnId??run.resultRunId,...(run.conversationId?{href:'#/ask?conversation='+encodeURIComponent(run.conversationId)}:{})}];
    events=[...events,...run.events.filter(event=>event.message).map((event,index)=>({id:id+':public:'+index,type:'plan.updated' as const,at:event.at,summary:event.message}))];
   }
  }
  return {id,kind:operation.kind,goal,state:status,createdAt,updatedAt,progress,branches:[],artifacts,evidence:{count:refs.length,refs:refs.slice(0,50),...(runId?{runId}:{})},events,destination:id.startsWith('workflow:actions:')?'actions':destinations[operation.kind]??'timeline',technical:{operationIds:[id],...(runId?{runId}:{})}};
 }
 private delegated(id:string):WorkActivity {
  const reader=this.options.delegation!,work=reader.get(id),artifacts=reader.artifactMetadata(id),status=state(work.status),branches:WorkBranch[]=work.units.map(unit=>({id:unit.id,title:unit.title,state:state(unit.status),artifactIds:unit.artifactId?[unit.artifactId]:[]}));
  const eventTypes:Record<string,WorkEvent['type']>={started:'work.started',branch_started:'branch.started',branch_completed:'branch.completed',branch_attention:'work.needs_input',waiting:'plan.updated',resumed:'plan.updated',completed:'work.completed',cancelled:'work.cancelled',branch_linked:'plan.updated',branch_retried:'branch.replanned',branch_cancelled:'plan.updated','work.started':'work.started','branch.started':'branch.started','branch.completed':'branch.completed','branch.failed':'work.needs_input','work.waiting':'plan.updated','work.resumed':'plan.updated','work.completed':'work.completed','work.cancelled':'work.cancelled','plan.updated':'plan.updated','branch.retried':'branch.replanned','branch.cancelled':'plan.updated'};
  let base:WorkActivity|undefined;try{base=this.operation(this.operations.detail(work.operationId,0,1).operation);}catch(error){if(!(error instanceof StoreError&&error.statusCode===404))throw error;}
  const progress:WorkProgress={...(base?.progress.mode==='semantic'?base.progress:{mode:'semantic',stage:status==='completed'?'finished':branches.some(branch=>branch.state==='running')?'searching':'planning'}),completedBranches:branches.filter(branch=>branch.state==='completed').length,totalBranches:branches.length};
  return {id:work.operationId,kind:base?.kind??'work',goal:work.goal,state:status,createdAt:work.createdAt,updatedAt:work.updatedAt,progress,branches,artifacts:[...(base?.artifacts??[]),...artifacts.map(artifact=>({id:artifact.id,kind:'result' as const,title:moteText('工作成果'),summary:artifact.summary}))],evidence:base?.evidence??{count:0,refs:[]},events:work.events.filter(event=>eventTypes[event.type]).map((event,index)=>({id:String(event.id??index),type:eventTypes[event.type],at:event.at,...(event.unitId?{branchId:event.unitId}:{}),...(event.message?{summary:event.message}:{})})),destination:base?.destination??'ask',technical:{operationIds:[work.operationId],...(base?.technical.runId?{runId:base.technical.runId}:{})}};
 }
 page(args:{state?:'active'|'attention'|'completed';cursor?:number;limit?:number}={}):WorkActivityPage {
  const groups=this.memoryIndex.metadataSql(),persisted=Boolean(this.options.delegation&&this.has('delegation_works'));
  const fallback=!persisted?this.options.delegation?.list().map(({id})=>{const work=this.options.delegation!.get(id);return {id:work.operationId,lookupId:id,updatedAt:work.updatedAt,rank:stateRank(work.status)};})??[]:[];
  const delegated=persisted?`SELECT json_extract(json,'$.operationId') id,id lookup_id,'delegation' category,json_extract(json,'$.updatedAt') updated_at,${rankSql("json_extract(json,'$.status')")} rank FROM delegation_works`:`SELECT json_extract(value,'$.id'),json_extract(value,'$.lookupId'),'delegation',json_extract(value,'$.updatedAt'),json_extract(value,'$.rank') FROM json_each(?)`;
  const filter=args.state==='active'?'rank IN (2,6)':args.state==='attention'?'rank IN (3,4,5)':args.state==='completed'?'rank<=0':'1=1',start=args.cursor??0,limit=args.limit??20;
  const rows=this.store.db.prepare(`WITH memory AS (SELECT id,id lookup_id,'memory' category,updated_at,rank FROM (${groups.sql})), delegated(id,lookup_id,category,updated_at,rank) AS (${delegated}), candidates AS (
    SELECT * FROM memory UNION ALL SELECT * FROM delegated UNION ALL
    SELECT p.id,p.id,'operation',strftime('%Y-%m-%dT%H:%M:%fZ',p.updated_at/1000.0,'unixepoch'),${rankSql('p.state')} FROM operation_progress p WHERE p.total>0 AND p.kind!='memory' AND NOT EXISTS(SELECT 1 FROM delegated d WHERE d.id=p.id))
    SELECT id,lookup_id,category FROM candidates WHERE ${filter} ORDER BY updated_at DESC,id LIMIT ? OFFSET ?`).all(...groups.parameters,...(persisted?[]:[JSON.stringify(fallback)]),limit+1,start);
  const items=rows.slice(0,limit).map(row=>{
   let work:WorkActivity;if(row.category==='memory')return this.memoryList(String(row.id),groups.sources.get(String(row.id))??[]);else if(row.category==='delegation')work=this.delegated(String(row.lookup_id));else work=this.operation(this.operations.detail(String(row.id),0,1).operation);
   return {...work,branchCounts:{total:work.branches.length,running:work.branches.filter(branch=>branch.state==='running').length,completed:work.branches.filter(branch=>branch.state==='completed').length},branches:[],evidence:{...work.evidence,refs:[]},events:[]};
  });
  return {items,nextCursor:rows.length>limit?start+limit:null};
 }
 detail(id:string,cursor=0,limit=50):WorkActivity {let work:WorkActivity;const delegated=this.options.delegation?(this.has('delegation_works')?this.store.db.prepare("SELECT id FROM delegation_works WHERE json_extract(json,'$.operationId')=? OR id=? LIMIT 1").get(id,id.startsWith('work:')?id.slice(5):id):this.options.delegation.list().find(value=>this.options.delegation!.get(value.id).operationId===id||'work:'+value.id===id)):undefined;if(delegated)work=this.delegated(String(delegated.id));else {const group=this.memoryGroupData(id);work=group?this.memoryGroup(id,group.jobs,group.sources):this.operation(this.operations.detail(id,0,1).operation);}return {...work,branchCounts:{total:work.branches.length,running:work.branches.filter(branch=>branch.state==='running').length,completed:work.branches.filter(branch=>branch.state==='completed').length},branches:work.branches.slice(cursor,cursor+limit),branchesNextCursor:cursor+limit<work.branches.length?cursor+limit:null,events:work.events.slice(-30)};}
}
export function registerActivity(app:FastifyInstance,activity:ActivityProjection,isCollector:(request:FastifyRequest)=>boolean){
 const owner=(request:FastifyRequest)=>{if(isCollector(request))throw new StoreError('Owner access required',403);};
 app.get('/api/work-activity',async request=>{owner(request);return activity.page(z.object({state:z.enum(['active','attention','completed']).optional(),cursor:z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),limit:z.coerce.number().int().min(1).max(100).optional()}).strict().parse(request.query));});
 app.get('/api/work-activity/:id',async request=>{owner(request);const {cursor,limit}=z.object({cursor:z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),limit:z.coerce.number().int().min(1).max(100).default(50)}).strict().parse(request.query);return activity.detail(z.object({id:z.string().min(1).max(512)}).parse(request.params).id,cursor,limit);});
}
