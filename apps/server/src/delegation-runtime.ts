import {createHash} from 'node:crypto';
import {ContextToolError,AgentYieldError,type AgentAnswer,type ContextRecord,type HostControlChannel,type HostControlDefinition,type HostControlResult,type QueryInput} from '@mote/agent';
import {ExecutionEngine,ExecutionFailure,type ExecutionGrant,type ExecutionLane,type ExecutionState,type ExecutionStep} from './execution-engine.js';
import {DelegationStore} from './delegation-store.js';
import {queryWorkspace,type QueryWorkspace} from './delegation-protocol.js';
import {StoreError,type Store} from './store.js';
export {originalEvidenceReceipt} from '@mote/agent';

export type DelegationScope=Pick<QueryInput,'after'|'before'|'deviceId'|'timeZone'|'contextTime'|'evidenceIds'|'evidenceRanges'|'processingEvidence'>;
export type DelegationUnit={id:string;workId:string;capabilityId:string;capabilityVersion:string;title:string;goal:string;input:Record<string,unknown>;scope:DelegationScope;dependencies:string[];stepId:string;status:ExecutionState;attempts:number;artifactId?:string;error?:string;external?:boolean};
export type DelegationEvent={id:number;type:string;message?:string;unitId?:string;at:string};
export type DelegationWork={id:string;operationId:string;profileId:string;goal:string;status:ExecutionState;createdAt:string;updatedAt:string;revision:number;requestHash:string;scope:DelegationScope;allowedCapabilities:string[];evidenceRevision:number;planningComplete?:boolean;plannedUnitIds?:string[];wait?:{unitIds:string[];mode:'any'|'all'};error?:string;units:DelegationUnit[];events:DelegationEvent[]};
export type DelegationProduct={value:unknown;summary?:string;coverage?:unknown;evidence?:readonly ContextRecord[];dependencies?:readonly ContextRecord[];dependencyIds?:readonly string[]};
export interface DelegationCapability {
 id:string;version:string;description:string;inputSchema?:Record<string,unknown>;maxInputCharacters?:number;
 /** A proposal is handed atomically to a product's existing durable executor. */
 proposal?:boolean;
 /** Host product hooks revoke/retry its own durable grants synchronously. */
 cancel?:(unit:Readonly<DelegationUnit>,work:Readonly<DelegationWork>)=>void;
 retry?:(unit:Readonly<DelegationUnit>,work:Readonly<DelegationWork>)=>void;
 validate?:(unit:Readonly<DelegationUnit>,work:Readonly<DelegationWork>)=>boolean;
 execute:(unit:Readonly<DelegationUnit>,context:{signal:AbortSignal;scope:DelegationScope;grant:ExecutionGrant;work:DelegationWork})=>Promise<DelegationProduct>;
}
export type DelegationCoordinatorContext={work:DelegationWork;input:unknown;signal:AbortSignal;grant:ExecutionGrant;controls:HostControlChannel};
export interface DelegationCoordinator {
 id:string;execute:(context:DelegationCoordinatorContext)=>Promise<unknown>;
 /** Host product entry owns this declaration; submitted units inherit it. */
 lane?:ExecutionLane;
 /** Metadata planning finishes before the product hands its units to existing jobs. */
 awaitExternal?:boolean;
 /** Pure input authority is checked on every resume and commit. */
 validate?:(work:DelegationWork,input:unknown)=>boolean;
 commit?:(work:DelegationWork,result:unknown)=>void|{acceptedUnitIds:readonly string[]};
}
export type DelegationStart={id:string;operationId?:string;profileId:string;goal:string;input:unknown;scope?:DelegationScope;allowedCapabilities:string[]};
const canonical=(value:unknown):unknown=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,canonical(item)])):value;
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const terminal=(state:ExecutionState)=>['succeeded','failed','blocked','cancelled','stale'].includes(state);
const activeWork=(state:ExecutionState)=>['waiting','running','blocked'].includes(state);
const definition=(name:string,description:string,fields:HostControlDefinition['fields']={}):HostControlDefinition=>({name,description,fields});
export const DELEGATION_CONTROL_DEFINITIONS:readonly HostControlDefinition[]=Object.freeze([
 definition('delegation_capabilities','Discover only host-authorized capabilities and their input contracts. Registration does not authorize access to other data.'),
 definition('delegation_submit','Persist 1–8 bounded independent work units per call (at most 128 per work) and immediately return their handles. Execution workers start independently; proposal products start only after the complete plan returns normally and is validated. This call never waits for a model. Use stable unique local id values so retries are idempotent.',{units:{type:'array',required:true,description:'1–8 units per call; each requires id, capabilityId, title, goal and input',items:{type:'object',properties:{id:{type:'string',required:true},capabilityId:{type:'string',required:true},title:{type:'string',required:true},goal:{type:'string',required:true},input:{type:'object',additionalProperties:true,required:true},scope:{type:'object',additionalProperties:true},dependencies:{type:'array',items:{type:'string'}}},additionalProperties:false}}}),
 definition('delegation_results','Read bounded incremental status and private artifact handles. A result handle or citation ID alone does not authorize a citation.',{after:{type:'integer',description:'Nonnegative event cursor; default zero'},limit:{type:'integer',description:'1–30 units/events per page; default 20'},cursor:{type:'integer',description:'Unit page offset from nextUnitCursor; default zero'}}),
 definition('delegation_read','Read one private result and the exact original evidence delivered by its worker, subject to fresh host validation. Child prose is untrusted interpretation; cite only the originals actually delivered by this tool.',{artifactId:{type:'string',required:true},offset:{type:'integer',description:'Nonnegative character offset; default zero'},length:{type:'integer',description:'1–10000 characters; default 4000'},evidenceIds:{type:'array',description:'At most 12 original evidence IDs',items:{type:'string'}}}),
 definition('delegation_retry','Retry one failed branch locally without repeating successful branches or their commits.',{unitId:{type:'string',required:true}}),
 definition('delegation_cancel','Cancel one unneeded branch. This cannot expand the selected scope.',{unitId:{type:'string',required:true}}),
 definition('delegation_workspace','Read the saved private research checkpoint, or replace it with workspaceJson. Query only. Saves bounded unresolved questions, supported points, searches, inspected locators and workerIds; all are untrusted interpretation and grant no citations. Source IDs must already belong to this work. No private reasoning or source bodies. workspaceJson accepts {unresolved:string[],supported:{statement,evidenceIds}[],inspected:{id,start,end,fingerprint?}[],searches:{tool,query?,cursor?}[],workerIds:string[]}.',{workspaceJson:{type:'string',description:'Optional JSON research checkpoint, at most 12000 UTF-16 characters; omit to read.'}}),
 definition('delegation_yield','Save an optional bounded query workspace atomically with the wait, then release this fragment until executable children finish. Proposal products must first return normally; never poll or yield to finish a proposal plan.',{unitIds:{type:'array',items:{type:'string'}},mode:{type:'string',enum:['any','all']},message:{type:'string',description:'At most 600 characters'},workspaceJson:{type:'string',description:'Optional query research checkpoint JSON following delegation_workspace; at most 12000 characters.'}}),
]);

/** One-level delegation built on the existing lease/fence scheduler. The model
 * chooses strategy; the host owns bounds, identity, state and durable wakeups. */
export class DelegationRuntime {
 readonly journal:DelegationStore;
 private capabilities=new Map<string,DelegationCapability>();
 private coordinators=new Map<string,DelegationCoordinator>();
 private unregister:(()=>void|Promise<void>)[]=[];
 private timer?:ReturnType<typeof setInterval>;
 private closed=false;
 constructor(readonly store:Store,readonly engine:ExecutionEngine,private options:{concurrency?:()=>number;interactiveConcurrency?:()=>number;revalidateEvidence?:(records:readonly ContextRecord[],scope:DelegationScope)=>Promise<readonly ContextRecord[]>;validateDependencies?:(ids:readonly string[])=>void;autoPump?:boolean}={}){
  this.journal=new DelegationStore(store);
  engine.configurePool('delegated-agents',{concurrency:{background:options.concurrency??(()=>4),interactive:options.interactiveConcurrency??options.concurrency??(()=>2)},lane:step=>{
   // Existing work/profile identity is sufficient for restart. The model's
   // payload, capability arguments and captured content cannot elevate a lane.
   try{const workId=step.kind.startsWith('delegation.coordinator.')?String(step.input.workId):this.store.db.prepare('SELECT work_id FROM delegation_units WHERE id=?').get(String(step.input.unitId))?.work_id;
    const profileId=this.store.db.prepare("SELECT json_extract(json,'$.profileId') profile FROM delegation_works WHERE id=?").get(String(workId))?.profile;
    return this.coordinators.get(String(profileId))?.lane??'background';}
   catch{return 'background';}
  }});
  if(options.autoPump!==false){this.timer=setInterval(()=>{void this.tick().catch(()=>{});},500);this.timer.unref();}
 }
 register(capability:DelegationCapability){
  if(!/^[a-z][a-z0-9.-]{0,63}$/.test(capability.id)||!capability.version||this.capabilities.has(capability.id))throw Error('Invalid or duplicate delegation capability');
  const entry=Object.freeze({...capability});this.capabilities.set(entry.id,entry);
  if(!entry.proposal)this.unregister.push(this.engine.register({kind:`delegation.unit.${entry.id}`,pool:'delegated-agents',concurrency:this.options.concurrency??(()=>4),timeoutMs:2147483647,maxAttempts:4,
   validate:step=>this.currentUnit(step,entry),
   execute:(step,signal,grant)=>{const unit=this.unit(String(step.input.unitId));return entry.execute(unit,{signal,scope:unit.scope,grant,work:this.get(unit.workId)});},
   commit:(step,result)=>this.commitUnit(step,result as DelegationProduct),project:step=>this.projectUnit(step),
  }));
  return entry;
 }
 registerCoordinator(profile:DelegationCoordinator){
  if(!/^[a-z][a-z0-9.-]{0,63}$/.test(profile.id)||this.coordinators.has(profile.id))throw Error('Invalid or duplicate delegation coordinator');
  profile=Object.freeze({...profile});
  this.coordinators.set(profile.id,profile);
  this.unregister.push(this.engine.register({kind:`delegation.coordinator.${profile.id}`,pool:'delegated-agents',concurrency:this.options.concurrency??(()=>4),timeoutMs:2147483647,maxAttempts:4,
   validate:step=>this.currentWork(String(step.input.workId),profile),
   execute:async(step,signal,grant)=>{const work=this.get(String(step.input.workId)),controls=this.controlChannel(work.id,grant),input=this.journal.payload(work.id);
    try{const result=await profile.execute({work,input,signal,grant,controls});return {yielded:false,result};}
    catch(error){if(error instanceof AgentYieldError)return {yielded:true};throw error;}
   },
   commit:(step,value)=>{const work=this.raw(String(step.input.workId)),outcome=value as {yielded:boolean;result?:unknown};
    if(outcome.yielded){work.status='waiting';this.save(work);this.wake(work.id);return;}
    if(work.units.some(unit=>!terminal(unit.status)&&!unit.external))throw new ExecutionFailure('permanent','unfinished_delegation');
    const receipt=profile.commit?.(this.get(work.id),outcome.result);
    this.completePlan(work,profile,outcome.result,receipt);
   },project:step=>this.projectCoordinator(step),
  }));
  return profile;
 }
 private currentWork(id:string,profile?:DelegationCoordinator){
  try{const work=this.get(id);return activeWork(work.status)&&!this.engine.cancellationAliasRevoked(work.id)&&(!profile?.validate||profile.validate(work,this.journal.payload(id)));}catch{return false;}
 }
 private currentUnit(step:ExecutionStep,capability:DelegationCapability){try{const unit=this.unit(String(step.input.unitId)),work=this.get(unit.workId);return this.currentWork(work.id,this.coordinators.get(work.profileId))&&unit.capabilityVersion===capability.version&&unit.status!=='cancelled'&&(capability.validate?.(unit,work)??true);}catch{return false;}}
 private raw(id:string):DelegationWork {const row=this.store.db.prepare('SELECT json FROM delegation_works WHERE id=?').get(id);if(!row)throw new StoreError('Delegated work not found',404);const {private:encoded,...value}=JSON.parse(String(row.json));return {...value,...(encoded?this.journal.decodePrivate<{goal:string}>(encoded):{}),units:this.units(id),events:[]};}
 private units(workId:string):DelegationUnit[]{return this.store.db.prepare('SELECT json FROM delegation_units WHERE work_id=? ORDER BY rowid').all(workId).map(row=>this.decodeUnit(String(row.json)));}
 unit(id:string):DelegationUnit {const row=this.store.db.prepare('SELECT json FROM delegation_units WHERE id=?').get(id);if(!row)throw new StoreError('Delegated branch not found',404);return this.decodeUnit(String(row.json));}
 private decodeUnit(json:string):DelegationUnit {const {private:encoded,...value}=JSON.parse(json);return {...value,...(encoded?this.journal.decodePrivate<{title:string;goal:string;input:Record<string,unknown>}>(encoded):{})};}
 private serializeWork(work:DelegationWork){const {units:_units,events:_events,goal,...metadata}=work;return JSON.stringify({...metadata,goal:'',private:this.journal.encodePrivate({goal})});}
 private serializeUnit(unit:DelegationUnit){const {title,goal,input,...metadata}=unit;return JSON.stringify({...metadata,title:'',goal:'',input:{},private:this.journal.encodePrivate({title,goal,input})});}
 private save(work:DelegationWork){work.updatedAt=new Date().toISOString();this.store.db.prepare('UPDATE delegation_works SET json=? WHERE id=?').run(this.serializeWork(work),work.id);}
 private saveUnit(unit:DelegationUnit){this.store.db.prepare('UPDATE delegation_units SET json=? WHERE id=?').run(this.serializeUnit(unit),unit.id);}
 private event(workId:string,type:string,message?:string,unitId?:string){const types:Record<string,string>={started:'work.started',branch_started:'branch.started',branch_completed:'branch.completed',branch_attention:'branch.failed',waiting:'work.waiting',resumed:'work.resumed',completed:'work.completed',cancelled:'work.cancelled',branch_linked:'plan.updated',branch_cancelled:'branch.cancelled',branch_retried:'branch.retried'};this.store.reserveMetadata((message?.length??0)*4+256);this.store.db.prepare('INSERT INTO delegation_events(work_id,type,message,unit_id,at) VALUES(?,?,?,?,?)').run(workId,types[type]??type,message!==undefined?this.journal.encodePrivate(message):null,unitId??null,new Date().toISOString());}
 get(id:string):DelegationWork {const work=this.raw(id);if(activeWork(work.status)&&this.engine.cancellationAliasRevoked(id))work.status='cancelled';work.events=this.store.db.prepare('SELECT id,type,message,unit_id unitId,at FROM delegation_events WHERE work_id=? ORDER BY id DESC LIMIT 120').all(id).reverse().map(row=>({id:Number(row.id),type:String(row.type),at:String(row.at),...(row.message?{message:String(row.message).startsWith('aes:')||String(row.message).startsWith('json:')?this.journal.decodePrivate<string>(String(row.message)):String(row.message)}:{}),...(row.unitId?{unitId:String(row.unitId)}:{})}));return work;}
 page(args:{cursor?:number;limit?:number}={}){const limit=Math.max(1,Math.min(100,args.limit??100)),rows=this.store.db.prepare(`SELECT rowid sequence,id FROM delegation_works ${args.cursor===undefined?'':'WHERE rowid<?'} ORDER BY rowid DESC LIMIT ?`).all(...(args.cursor===undefined?[]:[args.cursor]),limit+1);return {items:rows.slice(0,limit).map(row=>this.get(String(row.id))),nextCursor:rows.length>limit?Number(rows[limit-1].sequence):null};}
 list():DelegationWork[]{return this.page().items;}
 /** Admission scans durable active identities independently from UI history. */
 private activeIds(){return this.store.db.prepare(`SELECT w.id FROM delegation_works w WHERE json_extract(w.json,'$.status') IN ('waiting','running','blocked') OR EXISTS(SELECT 1 FROM execution_operation_steps o JOIN execution_steps e ON e.id=o.step_id WHERE o.operation_id=json_extract(w.json,'$.operationId') AND e.state IN ('waiting','running','blocked')) OR EXISTS(SELECT 1 FROM delegation_units u JOIN execution_steps e ON e.id=json_extract(u.json,'$.stepId') WHERE u.work_id=w.id AND e.state IN ('waiting','running','blocked')) ORDER BY w.rowid`).all().map(row=>String(row.id));}
 result<T=unknown>(id:string):T|undefined {const work=this.get(id);if(work.status==='stale'||work.status==='cancelled')return;return this.journal.result<T>(id);}
 async waitForPlan(id:string,signal?:AbortSignal){for(;;){signal?.throwIfAborted();if(this.closed||this.engine.closed)throw new StoreError('Delegation execution is stopping',503);const work=this.get(id);if(work.planningComplete)return work;if(terminal(work.status))throw new StoreError(work.error??'Work planning did not complete',409);await new Promise<void>(resolve=>{const timer=setTimeout(resolve,100);timer.unref();});}}
 async wait(id:string,signal?:AbortSignal){for(;;){signal?.throwIfAborted();if(this.closed||this.engine.closed)throw new StoreError('Delegation execution is stopping',503);const work=this.get(id);if(terminal(work.status))return work;await new Promise<void>(resolve=>{const timer=setTimeout(resolve,100);timer.unref();});}}
 artifactMetadata(workId:string){return this.store.db.prepare('SELECT metadata FROM delegation_artifacts WHERE work_id=? ORDER BY rowid').all(workId).map(row=>(String(row.metadata).startsWith('aes:')||String(row.metadata).startsWith('json:')?this.journal.decodePrivate(String(row.metadata)):JSON.parse(String(row.metadata))) as {id:string;workId:string;unitId:string;summary?:string;coverage?:unknown});}
 start(request:DelegationStart){
  if(this.closed)throw new StoreError('Delegation runtime is closed',503);
  if(!request.id||request.id.length>150||!request.goal.trim()||request.goal.length>20000||!this.coordinators.has(request.profileId)||request.allowedCapabilities.some(id=>!this.capabilities.has(id)))throw new StoreError('Invalid delegated work',400);
  const hash=digest(request),prior=this.store.db.prepare('SELECT 1 FROM delegation_works WHERE id=?').get(request.id);
  if(prior){const work=this.get(request.id);if(work.requestHash!==hash)throw new StoreError('Work ID belongs to another request',409);return work;}
  const at=new Date().toISOString(),work:DelegationWork={id:request.id,operationId:request.operationId??request.id,profileId:request.profileId,goal:request.goal,status:'waiting',createdAt:at,updatedAt:at,revision:0,requestHash:hash,scope:structuredClone(request.scope??{}),allowedCapabilities:[...new Set(request.allowedCapabilities)],evidenceRevision:this.store.deletionRevision(),units:[],events:[]};
  this.transaction(()=>{this.store.reserveMetadata(4096);this.store.db.prepare('INSERT INTO delegation_works VALUES(?,?)').run(work.id,this.serializeWork(work));this.journal.savePayload(work.id,request.input);const input=request.input as QueryInput;this.recordEvidence(work.id,[...(input.evidenceIds??[]),...(input.derivedContextEvidenceIds??[]),...(input.contextEvidenceDependencies?.ids??[]),...(input.conversation?.evidenceDependencies?.ids??[]),...(input.directImages?.map(image=>image.id)??[])]);this.event(work.id,'started');this.enqueueCoordinator(work);});
  queueMicrotask(()=>{void this.tick().catch(()=>{});});return this.get(work.id);
 }
 private transaction<T>(write:()=>T):T {const db=this.store.db,own=!db.isTransaction;if(own)db.exec('BEGIN IMMEDIATE');try{const result=write();if(own)db.exec('COMMIT');return result;}catch(error){if(own&&db.isTransaction)db.exec('ROLLBACK');throw error;}}
 private enqueueCoordinator(work:DelegationWork){work.revision++;work.status='waiting';this.save(work);const stepId=this.engine.enqueue(work.operationId,`delegation.coordinator.${work.profileId}`,{workId:work.id,revision:work.revision},{id:`${work.id}:coordinator:${work.revision}`,generation:{slot:'coordinator',version:String(work.revision)}});this.engine.bindCancellationAlias(work.id,stepId);}
 private narrower(parent:DelegationScope,requested:unknown):DelegationScope{
  if(requested===undefined)return structuredClone(parent);
  if(!requested||typeof requested!=='object'||Array.isArray(requested)||Object.keys(requested).some(key=>!['after','before','deviceId','evidenceIds','evidenceRanges'].includes(key)))throw new ContextToolError('invalid_delegation_arguments','Invalid child scope','correct_arguments');
  const next={...parent,...requested} as DelegationScope;
  if(next.deviceId!==undefined&&(typeof next.deviceId!=='string'||!next.deviceId||next.deviceId.length>300))throw new ContextToolError('invalid_delegation_arguments','Invalid child device','correct_arguments');
  if(parent.evidenceIds&&!next.evidenceIds||parent.evidenceRanges&&!next.evidenceRanges)throw new StoreError('Child scope cannot remove parent evidence bounds',403);
  if(next.evidenceIds!==undefined&&(!Array.isArray(next.evidenceIds)||!next.evidenceIds.length))throw new ContextToolError('invalid_delegation_arguments','Invalid child evidence scope','correct_arguments');
  if(next.evidenceRanges!==undefined&&!Array.isArray(next.evidenceRanges))throw new ContextToolError('invalid_delegation_arguments','Invalid child evidence ranges','correct_arguments');
  if(parent.evidenceRanges&&!(requested as Record<string,unknown>).evidenceRanges&&next.evidenceIds)next.evidenceRanges=parent.evidenceRanges.filter(range=>next.evidenceIds!.includes(range.id));
  for(const field of ['after','before'] as const)if(next[field]!==undefined&&(typeof next[field]!=='string'||!Number.isFinite(Date.parse(next[field]!))))throw new ContextToolError('invalid_delegation_arguments','Invalid child time range','correct_arguments');
  if(parent.deviceId&&next.deviceId!==parent.deviceId||parent.after&&(!next.after||Date.parse(next.after)<Date.parse(parent.after))||parent.before&&(!next.before||Date.parse(next.before)>Date.parse(parent.before))||next.after&&next.before&&Date.parse(next.after)>=Date.parse(next.before))throw new StoreError('Child scope exceeds parent authorization',403);
  if(next.evidenceIds&&(!Array.isArray(next.evidenceIds)||next.evidenceIds.length>100||next.evidenceIds.some(id=>typeof id!=='string'||parent.evidenceIds&&!parent.evidenceIds.includes(id))))throw new StoreError('Child evidence exceeds parent authorization',403);
  if(next.evidenceRanges&&(!next.evidenceIds||!Array.isArray(next.evidenceRanges)||next.evidenceRanges.length>100||next.evidenceRanges.some(r=>!next.evidenceIds!.includes(r.id)||!Number.isSafeInteger(r.offset)||!Number.isSafeInteger(r.length)||r.offset<0||r.length<1||r.length>100000||parent.evidenceRanges&&!parent.evidenceRanges.some(p=>p.id===r.id&&r.offset>=p.offset&&r.offset+r.length<=p.offset+p.length))))throw new StoreError('Child evidence ranges exceed parent authorization',403);
  return structuredClone(next);
 }
 private submit(workId:string,args:Readonly<Record<string,unknown>>){
  const work=this.get(workId);if(!this.currentWork(workId,this.coordinators.get(work.profileId)))throw new StoreError('Work authority expired',409);
  if(!Array.isArray(args.units)||!args.units.length||args.units.length>8)throw new ContextToolError('invalid_delegation_arguments','Submit 1–8 bounded units; at most 128 per work','correct_arguments');
  const proposals=args.units as Record<string,unknown>[],ids=new Set<string>();
  if(proposals.some(proposal=>!proposal||typeof proposal!=='object'||Array.isArray(proposal)))throw new ContextToolError('invalid_delegation_arguments','Each unit must be an object with id, capabilityId, title, goal and input.','correct_arguments');
  const next=proposals.map(proposal=>{
   if(Object.keys(proposal).some(key=>!['id','capabilityId','title','goal','input','scope','dependencies'].includes(key))||typeof proposal.id!=='string'||!/^[a-zA-Z0-9_-]{1,64}$/.test(proposal.id)||ids.has(proposal.id))throw new ContextToolError('invalid_delegation_arguments','Invalid or duplicate unit identity','correct_arguments');ids.add(proposal.id);
   const capability=typeof proposal.capabilityId==='string'?this.capabilities.get(proposal.capabilityId):undefined;
   if(!capability||!work.allowedCapabilities.includes(capability.id)||typeof proposal.title!=='string'||!proposal.title.trim()||proposal.title.length>180||typeof proposal.goal!=='string'||!proposal.goal.trim()||proposal.goal.length>4000||!proposal.input||typeof proposal.input!=='object'||Array.isArray(proposal.input)||JSON.stringify(proposal.input).length>(capability.maxInputCharacters??16000))throw new ContextToolError('invalid_delegation_arguments','Each unit requires an allowed capabilityId, nonempty title (at most 180), goal (at most 4000), and input matching the discovered capability contract','correct_arguments');
   const id=`${workId}:unit:${proposal.id}`,dependencies=proposal.dependencies??[];
   if(!Array.isArray(dependencies)||dependencies.length>16||dependencies.some(dep=>typeof dep!=='string'))throw new ContextToolError('invalid_delegation_arguments','Invalid unit dependencies','correct_arguments');
   const unit:DelegationUnit={id,workId,capabilityId:capability.id,capabilityVersion:capability.version,title:proposal.title,goal:proposal.goal,input:structuredClone(proposal.input as Record<string,unknown>),scope:this.narrower(work.scope,proposal.scope),dependencies:dependencies.map(dep=>String(dep).startsWith(`${workId}:unit:`)?String(dep):`${workId}:unit:${dep}`),stepId:id,status:'waiting',attempts:0,...(capability.proposal?{external:true}:{})};
   if(capability.validate&&!capability.validate(unit,work))throw new ContextToolError('invalid_delegation_arguments','Unit input contract rejected','correct_arguments');return unit;
  });
  if(work.units.length+next.filter(unit=>!work.units.some(prior=>prior.id===unit.id)).length>128)throw new ContextToolError('invalid_delegation_arguments','At most 128 branches per work','correct_arguments');
  const graph=new Map([...work.units,...next].map(unit=>[unit.id,unit.dependencies])),visiting=new Set<string>(),visited=new Set<string>();
  const visit=(id:string)=>{if(visiting.has(id)||!graph.has(id))throw new ContextToolError('invalid_delegation_arguments','Dependencies must be an acyclic graph within this work','correct_arguments');if(visited.has(id))return;visiting.add(id);for(const dep of graph.get(id)!)visit(dep);visiting.delete(id);visited.add(id);};for(const id of graph.keys())visit(id);
  for(const unit of next){const prior=work.units.find(old=>old.id===unit.id);if(prior){const {status:_,attempts:__,artifactId:___,error:____,...a}=prior,{status:_s,attempts:_a,...b}=unit;if(digest(a)!==digest(b))throw new StoreError('Unit ID belongs to another package',409);continue;}const encoded=this.serializeUnit(unit);this.store.reserveMetadata(Buffer.byteLength(encoded)+1024);this.store.db.prepare('INSERT INTO delegation_units VALUES(?,?,?)').run(unit.id,workId,encoded);this.event(workId,'branch_started',unit.title,unit.id);}
  // Every metadata row exists before dependencies are inserted (including forward refs).
  for(const unit of next)if(!unit.external)this.engine.enqueue(work.operationId,`delegation.unit.${unit.capabilityId}`,{unitId:unit.id},{id:unit.stepId});
  for(const unit of next)if(!unit.external)this.engine.enqueue(work.operationId,`delegation.unit.${unit.capabilityId}`,{unitId:unit.id},{id:unit.stepId,dependencies:unit.dependencies.map(id=>this.unit(id).stepId)});
  return next.map(unit=>({id:unit.id,title:unit.title,status:this.unit(unit.id).status}));
 }
 controlChannel(workId:string,grant?:ExecutionGrant):HostControlChannel {
  const authorize=()=>{grant?.assert();const work=this.get(workId);if(!this.currentWork(workId,this.coordinators.get(work.profileId)))throw new StoreError('Work authority expired',409);return work;};
  const write=<T>(callback:()=>T)=>grant?grant.commit(callback):this.transaction(callback);
  const owner=this.get(workId),phase=this.coordinators.get(owner.profileId)?.awaitExternal&&!owner.planningComplete?'proposal':'execution';
  return {phase,definitions:owner.profileId==='query'?DELEGATION_CONTROL_DEFINITIONS:DELEGATION_CONTROL_DEFINITIONS.filter(tool=>tool.name!=='delegation_workspace'),execute:async(name,args):Promise<HostControlResult>=>{
   let work=authorize();
   const keys:Record<string,readonly string[]>={delegation_capabilities:[],delegation_submit:['units'],delegation_results:['after','limit','cursor'],delegation_read:['artifactId','offset','length','evidenceIds'],delegation_retry:['unitId'],delegation_cancel:['unitId'],delegation_workspace:['workspaceJson'],delegation_yield:['unitIds','mode','message','workspaceJson']};
   if(!keys[name]||Object.keys(args).some(key=>!keys[name].includes(key)))throw new ContextToolError('invalid_delegation_arguments','Invalid host control arguments','correct_arguments');
   if(name==='delegation_capabilities')return {data:{capabilities:work.allowedCapabilities.map(id=>this.capabilities.get(id)!).filter(Boolean).map(({id,version,description,inputSchema})=>({id,version,description,inputSchema,maxDepth:1}))}};
   if(name==='delegation_submit')return {data:{units:write(()=>{authorize();return this.submit(workId,args);})}};
   if(name==='delegation_results'){const after=args.after??0,cursor=args.cursor??0,limit=args.limit??20;if(!Number.isSafeInteger(after)||Number(after)<0||!Number.isSafeInteger(cursor)||Number(cursor)<0||!Number.isSafeInteger(limit)||Number(limit)<1||Number(limit)>30)throw new ContextToolError('invalid_delegation_arguments','after and cursor must be nonnegative integers; limit must be 1–30 (default 20)','correct_arguments');const units=work.units.slice(Number(cursor),Number(cursor)+Number(limit)),events=work.events.filter(event=>event.id>Number(after)).slice(0,Number(limit)),selected=new Set(units.map(unit=>unit.id));return {data:{units:units.map(({id,title,status,attempts,artifactId,error})=>({id,title,status,attempts,artifactId,error})),events,artifacts:this.artifactMetadata(workId).filter(artifact=>selected.has(artifact.unitId)).map(({id,workId,unitId})=>({id,workId,unitId})),next:events.at(-1)?.id??after,nextUnitCursor:Number(cursor)+units.length<work.units.length?Number(cursor)+units.length:null}};}
   if(name==='delegation_read'){if(typeof args.artifactId!=='string')throw new ContextToolError('invalid_delegation_arguments','Artifact handle required','correct_arguments');const unit=work.units.find(item=>item.artifactId===args.artifactId);if(!unit||unit.status!=='succeeded')throw new StoreError('Artifact is outside this work or no longer valid',403);const product=this.journal.artifact<DelegationProduct>(args.artifactId),offset=args.offset??0,length=args.length??4000;
    if(!Number.isSafeInteger(offset)||Number(offset)<0||!Number.isSafeInteger(length)||Number(length)<1||Number(length)>10000||args.evidenceIds!==undefined&&(!Array.isArray(args.evidenceIds)||args.evidenceIds.length>12||args.evidenceIds.some(id=>typeof id!=='string')))throw new ContextToolError('invalid_delegation_arguments','Invalid artifact page','correct_arguments');
    const text=JSON.stringify(product.value),selected=(product.evidence??[]).filter(record=>args.evidenceIds===undefined||(args.evidenceIds as string[]).includes(record.id)),dependencies=product.dependencies??product.evidence??[];
    this.options.validateDependencies?.(product.dependencyIds??dependencies.map(record=>record.id));
    const authorizedOriginals=this.options.revalidateEvidence?await this.options.revalidateEvidence(dependencies,unit.scope):undefined;authorize();
    return {data:{artifactId:args.artifactId,summary:product.summary,coverage:product.coverage,text:text.slice(Number(offset),Number(offset)+Number(length)),textRange:{offset,total:text.length,nextOffset:Number(offset)+Number(length)<text.length?Number(offset)+Number(length):null},evidenceIds:(product.evidence??[]).map(record=>record.id)},evidence:[...selected],dependencies,...(authorizedOriginals?{authorizedOriginals}:{})};
   }
   if(name==='delegation_retry'||name==='delegation_cancel'){if(typeof args.unitId!=='string'||!work.units.some(unit=>unit.id===args.unitId))throw new StoreError('Branch handle is outside this work',403);write(()=>{authorize();if(name==='delegation_retry')this.retryUnit(String(args.unitId));else this.cancelUnit(String(args.unitId));});return {data:{unitId:args.unitId,status:this.unit(args.unitId).status}};}
   const saveWorkspace=()=>{
    if(work.profileId!=='query'||typeof args.workspaceJson!=='string'||args.workspaceJson.length>12000)throw new ContextToolError('invalid_delegation_arguments','Research workspaces belong only to queries and must be bounded JSON.','correct_arguments');
    const payload=this.journal.payload<Record<string,unknown>>(workId),prior=payload.queryWorkspace as QueryWorkspace|undefined;
    try{payload.queryWorkspace=queryWorkspace(JSON.parse(args.workspaceJson),{revision:prior?.revision??0,evidenceIds:this.dependencyIds(workId),workerIds:work.units.map(unit=>unit.id)});}catch{throw new ContextToolError('invalid_delegation_arguments','Workspace must match its declared schema and existing work identities.','correct_arguments');}
    this.journal.savePayload(workId,payload);
   };
   if(name==='delegation_workspace'){
    if(work.profileId!=='query')throw new ContextToolError('invalid_delegation_arguments','Research workspaces are available only to queries.','correct_arguments');
    if(args.workspaceJson!==undefined)write(()=>{authorize();saveWorkspace();});
    return {data:{workspace:this.journal.payload<{queryWorkspace?:QueryWorkspace}>(workId).queryWorkspace??null,citationAuthority:false}};
   }
   if(name==='delegation_yield'){
    const ids=args.unitIds??work.units.filter(unit=>!terminal(unit.status)).map(unit=>unit.id),mode=args.mode??'all';
    if(!Array.isArray(ids)||!ids.length||ids.some(id=>typeof id!=='string'||!work.units.some(unit=>unit.id===id))||!['any','all'].includes(String(mode))||args.message!==undefined&&(typeof args.message!=='string'||args.message.length>600))throw new ContextToolError('invalid_delegation_arguments','Invalid wait condition','correct_arguments');
    if(ids.some(id=>{const unit=work.units.find(unit=>unit.id===id)!;return unit.external&&!terminal(unit.status)&&!this.engine.get(unit.stepId);}))throw new ContextToolError('proposal_not_executable','These proposal products cannot start until planning finishes. Submit all catalog members exactly once, then return the requested final JSON normally; do not yield on proposals.','correct_arguments');
    write(()=>{authorize();if(args.workspaceJson!==undefined)saveWorkspace();work=this.raw(workId);work.wait={unitIds:ids as string[],mode:mode as 'any'|'all'};this.save(work);this.event(workId,'waiting',typeof args.message==='string'?args.message:undefined);});return {data:{saved:true,waitingFor:ids,mode},yield:true};
   }
   throw new StoreError('Unknown host control tool',404);
  }};
 }
 private commitUnit(step:ExecutionStep,product:DelegationProduct){const unit=this.unit(String(step.input.unitId)),id=`${unit.id}:artifact`;if(!product||!('value' in product)||product.summary!==undefined&&(typeof product.summary!=='string'||product.summary.length>1000))throw new ExecutionFailure('permanent','invalid_artifact');
  const evidence=(product.evidence??[]).filter(record=>record.contentLayer!=='L2_model_interpretation');
  this.journal.saveArtifact(id,unit.workId,unit.id,{...product,evidence},{id,workId:unit.workId,unitId:unit.id,summary:product.summary,coverage:product.coverage});unit.artifactId=id;this.saveUnit(unit);
 }
 private projectUnit(step:ExecutionStep){let unit:DelegationUnit;try{unit=this.unit(String(step.input.unitId));}catch{return;}const before=unit.status;unit.status=step.state;unit.attempts=step.attempts;unit.error=step.error;this.saveUnit(unit);if(terminal(step.state)&&before!==step.state){this.event(unit.workId,step.state==='succeeded'?'branch_completed':'branch_attention',undefined,unit.id);this.wake(unit.workId);}}
 private projectCoordinator(step:ExecutionStep){let work:DelegationWork;try{work=this.raw(String(step.input.workId));}catch{return;}if(terminal(work.status)||Number(step.input.revision)!==work.revision)return;
  if(step.state==='running')work.status='running';else if(step.state==='waiting')work.status='waiting';else if(['failed','blocked','stale','cancelled'].includes(step.state)){work.status=step.state;work.error=step.error;}this.save(work);
  if(work.status==='failed'||work.status==='blocked')this.failUnfinishedChildren(work);
 }
 /** A terminal coordinator cannot leave normal worker models holding slots.
  * Preserve completed products and retryable branch identities; product-owned
  * external jobs have their own independent grants and lifecycle. */
 private failUnfinishedChildren(work:DelegationWork){for(const unit of work.units){if(unit.external)continue;const step=this.engine.get(unit.stepId);if(step&&activeWork(step.state))this.engine.fail(unit.stepId,'parent_failed');}}
 private externalCompletionState(work:DelegationWork):ExecutionState {const selected=work.plannedUnitIds??work.units.filter(unit=>unit.external).map(unit=>unit.id),units=selected.map(id=>work.units.find(unit=>unit.id===id));if(units.some(unit=>!unit))return 'failed';if(units.some(unit=>!terminal(unit!.status)))return 'waiting';return units.some(unit=>unit!.status!=='succeeded')?'failed':'succeeded';}
 private completePlan(work:DelegationWork,profile:DelegationCoordinator,result:unknown,receipt:void|{acceptedUnitIds:readonly string[]}){
  if(work.units.some(unit=>!terminal(unit.status)&&!unit.external))throw new ExecutionFailure('permanent','unfinished_delegation');
  if(profile.awaitExternal){const accepted=receipt?.acceptedUnitIds??work.units.filter(unit=>unit.external&&unit.status!=='cancelled').map(unit=>unit.id);
   if(!Array.isArray(accepted)||accepted.length>128||new Set(accepted).size!==accepted.length||accepted.some(id=>typeof id!=='string'||!work.units.some(unit=>unit.id===id&&unit.external&&unit.status!=='cancelled')))throw new ExecutionFailure('permanent','invalid_delegation_plan');
   work.plannedUnitIds=[...accepted];
  }
  this.journal.saveResult(work.id,result??null);work.planningComplete=true;work.status=profile.awaitExternal?this.externalCompletionState(work):'succeeded';delete work.wait;delete work.error;if(work.status==='failed')work.error='delegated_product_failed';this.save(work);this.event(work.id,work.status==='waiting'?'plan.updated':work.status==='succeeded'?'completed':'work.failed');
 }
 private wake(workId:string){const work=this.raw(workId);if(work.status!=='waiting'||!work.wait||!this.currentWork(workId,this.coordinators.get(work.profileId)))return;const states=work.wait.unitIds.map(id=>this.unit(id).status),ready=work.wait.mode==='all'?states.every(terminal):states.some(terminal);if(ready){delete work.wait;this.enqueueCoordinator(work);this.event(workId,'resumed');}}
 cancelUnit(id:string){const unit=this.unit(id);if(unit.status==='succeeded'||unit.status==='cancelled')return;this.capabilities.get(unit.capabilityId)?.cancel?.(unit,this.get(unit.workId));this.engine.cancel(unit.stepId);unit.status='cancelled';this.saveUnit(unit);this.event(unit.workId,'branch_cancelled',undefined,id);}
 retryUnit(id:string){const unit=this.unit(id);if(!['failed','blocked','stale'].includes(unit.status))throw new StoreError('Only a failed branch can be retried',409);this.capabilities.get(unit.capabilityId)?.retry?.(unit,this.get(unit.workId));if(unit.artifactId)this.store.db.prepare('DELETE FROM delegation_artifacts WHERE id=?').run(unit.artifactId);delete unit.artifactId;delete unit.error;unit.status='waiting';this.saveUnit(unit);this.engine.retry(unit.stepId);this.event(unit.workId,'branch_retried',undefined,id);}
 cancel(id:string){this.transaction(()=>{const work=this.raw(id);if(terminal(work.status))return;work.status='cancelled';delete work.wait;this.save(work);for(const unit of work.units)if(!terminal(unit.status))this.cancelUnit(unit.id);this.engine.cancel(work.id);for(const stepId of this.activeExecutionIds(work.operationId))this.engine.cancel(stepId);this.event(id,'cancelled');});return this.get(id);}
 retry(id:string){this.transaction(()=>{const work=this.raw(id);if(!['failed','blocked'].includes(work.status))throw new StoreError('Only failed work can be retried',409);delete work.error;this.enqueueCoordinator(work);});void this.tick().catch(()=>{});return this.get(id);}
 /** Rejoin an independently retried product without rerunning its coordinator. */
 resumeExternalUnit(workId:string,unitId:string){this.transaction(()=>{
  const work=this.raw(workId),unit=this.unit(unitId),profile=this.coordinators.get(work.profileId);
  if(unit.workId!==workId||!unit.external||!work.planningComplete||!profile?.awaitExternal||['stale','cancelled','succeeded'].includes(work.status)||this.engine.cancellationAliasRevoked(workId)||profile.validate&&!profile.validate(work,this.journal.payload(workId)))throw new StoreError('External retry authority expired',409);
  if(!['failed','blocked','stale'].includes(unit.status))return;
  if(unit.artifactId)this.store.db.prepare('DELETE FROM delegation_artifacts WHERE id=?').run(unit.artifactId);delete unit.artifactId;delete unit.error;unit.status='waiting';this.saveUnit(unit);work.status='waiting';delete work.error;this.save(work);this.engine.retry(unit.stepId);this.event(workId,'branch_retried',undefined,unit.id);
 });return this.unit(unitId);}
 /** A Memory proposal uses its product's existing execution step and commit fence. */
 linkExternalUnit(workId:string,unitId:string,stepId:string){this.transaction(()=>{const unit=this.unit(unitId.startsWith(`${workId}:unit:`)?unitId:`${workId}:unit:${unitId}`);if(unit.workId!==workId||!unit.external||!this.engine.get(stepId)||!this.currentWork(workId,this.coordinators.get(this.raw(workId).profileId)))throw new StoreError('Invalid external execution link',409);unit.stepId=stepId;this.saveUnit(unit);this.event(workId,'branch_linked',unit.title,unit.id);});}
 recordExternalArtifact(workId:string,unitId:string,product:DelegationProduct){if(!this.store.db.isTransaction)throw new StoreError('External artifact needs its product execution commit fence',409);const unit=this.unit(unitId.startsWith(`${workId}:unit:`)?unitId:`${workId}:unit:${unitId}`);if(unit.workId!==workId||!unit.external||!this.currentWork(workId,this.coordinators.get(this.raw(workId).profileId)))throw new StoreError('Invalid external artifact owner',403);this.commitUnit({...this.engine.get(unit.stepId)!,input:{unitId:unit.id}},product);}
 private activeExecutionIds(operationId:string){return this.store.db.prepare("SELECT e.id FROM execution_steps e WHERE e.operation_id=? AND e.state IN ('waiting','running','blocked')").all(operationId).map(row=>String(row.id));}
 dependencyIds(workId:string){return this.store.db.prepare('SELECT evidence_id FROM delegation_dependencies WHERE work_id=?').all(workId).map(row=>String(row.evidence_id));}
 recordEvidence(workId:string,ids:readonly string[]){for(const id of new Set(ids)){if(this.store.db.prepare('SELECT 1 FROM delegation_dependencies WHERE work_id=? AND evidence_id=?').get(workId,id))continue;this.store.reserveMetadata(Buffer.byteLength(workId)+Buffer.byteLength(id)+128);this.store.db.prepare('INSERT INTO delegation_dependencies VALUES(?,?)').run(workId,id);}}
 async tick(){if(this.closed)return;for(const id of this.activeIds()){const work=this.get(id);if(this.engine.cancellationAliasRevoked(work.id)&&activeWork(this.raw(work.id).status))this.cancel(work.id);if(work.status==='stale'||work.status==='cancelled'){this.engine.cancel(work.id);for(const stepId of this.activeExecutionIds(work.operationId))this.engine.cancel(stepId);for(const unit of work.units)if(this.engine.get(unit.stepId)&&activeWork(this.engine.get(unit.stepId)!.state)){this.capabilities.get(unit.capabilityId)?.cancel?.(unit,work);this.engine.cancel(unit.stepId);}continue;}if(work.status==='failed'||work.status==='blocked')this.failUnfinishedChildren(work);for(const unit of work.units)if(unit.external){const step=this.engine.get(unit.stepId);if(step&&unit.status!==step.state)this.projectUnit({...step,input:{...step.input,unitId:unit.id}});}const current=this.raw(work.id);if(current.status==='waiting'&&current.planningComplete&&!current.wait){const state=this.externalCompletionState(current);if(state!=='waiting'){current.status=state;if(state==='failed')current.error='delegated_product_failed';this.save(current);this.event(current.id,current.status==='succeeded'?'completed':'work.failed');}}else {this.wake(work.id);}}await this.engine.tick();}
 async close(){this.closed=true;clearInterval(this.timer);await Promise.all(this.unregister.map(unregister=>unregister()));}
}

/** Existing model adapters receive this exact host channel. A child only receives
 * its immutable selected scope; native multi-agent tools remain disabled. */
export function registerQueryDelegation<T extends Pick<AgentAnswer,'answer'|'citations'> & Partial<Pick<AgentAnswer,'evidenceDependencies'>>>(runtime:DelegationRuntime,options:{query:(input:QueryInput)=>Promise<T>;prepare?:(work:DelegationWork,input:QueryInput,signal:AbortSignal)=>Promise<QueryInput>;commit?:(work:DelegationWork,result:T)=>void;validate?:(work:DelegationWork,input:QueryInput)=>boolean;onProgress?:QueryInput['onProgress'];onTrace?:QueryInput['onTrace']}){
 runtime.register({id:'context.research',version:'1',description:'Research one model-selected evidential question in the authorized archive scope. Return a grounded answer, original receipts and narrow remaining gaps.',inputSchema:{type:'object',properties:{question:{type:'string'}},required:['question'],additionalProperties:false},validate:unit=>Object.keys(unit.input).every(key=>key==='question')&&typeof unit.input.question==='string'&&unit.input.question.length>0&&unit.input.question.length<=12000,
  execute:async(unit,{signal,work,grant})=>{const saved=runtime.journal.payload<QueryInput>(work.id),parent=options.prepare?await options.prepare(work,saved,signal):saved;let evidence:readonly ContextRecord[]=[];const result=await options.query({...parent,...unit.scope,question:String(unit.input.question),contextCapabilitySnapshot:runtime.journal.payload<{queryCapabilitySnapshot?:QueryInput['contextCapabilitySnapshot']}>(work.id).queryCapabilitySnapshot,onContextCapabilities:undefined,hostControlChannel:undefined,conversation:undefined,taskContext:undefined,openingMemories:undefined,contextEvidenceDependencies:undefined,derivedContextEvidenceIds:undefined,directImages:undefined,signal,onProgress:options.onProgress??parent.onProgress,onTrace:options.onTrace??parent.onTrace,onEvidence:records=>{evidence=records;grant.commit(()=>runtime.recordEvidence(work.id,records.map(record=>record.id)));}});grant.commit(()=>runtime.recordEvidence(work.id,result.evidenceDependencies?.ids??[]));return {value:{answer:result.answer,citations:result.citations},summary:result.answer.slice(0,600),dependencies:evidence.filter(record=>record.contentLayer!=='L2_model_interpretation'),dependencyIds:result.evidenceDependencies?.ids??evidence.map(record=>record.id),evidence:evidence.filter(record=>result.citations.some(citation=>citation.id===record.id))};},
 });
 runtime.registerCoordinator({id:'query',lane:'interactive',validate:(work,input)=>options.validate?.(work,input as QueryInput)??true,
  execute:async({work,input,signal,controls,grant})=>{const original=options.prepare?await options.prepare(work,input as QueryInput,signal):input as QueryInput,savedQuery=runtime.journal.payload<{queryWorkspace?:QueryWorkspace;queryCapabilitySnapshot?:QueryInput['contextCapabilitySnapshot']}>(work.id),workspace=savedQuery.queryWorkspace;return options.query({...original,contextCapabilitySnapshot:savedQuery.queryCapabilitySnapshot,onContextCapabilities:snapshot=>{grant.commit(()=>{const saved=runtime.journal.payload<Record<string,unknown>>(work.id);if(!saved.queryCapabilitySnapshot){saved.queryCapabilitySnapshot=snapshot;runtime.journal.savePayload(work.id,saved);}});},...(workspace?{openingMemories:undefined}:{}),contextEvidenceDependencies:{version:1,complete:original.contextEvidenceDependencies?.complete??true,ids:[...new Set([...(original.contextEvidenceDependencies?.ids??[]),...runtime.dependencyIds(work.id)])]},signal,hostControlChannel:controls,onProgress:options.onProgress??original.onProgress,onTrace:options.onTrace??original.onTrace,onEvidence:records=>{grant.commit(()=>runtime.recordEvidence(work.id,records.map(record=>record.id)));original.onEvidence?.(records);},taskContext:{...original.taskContext,turns:original.taskContext?.turns??[],...(workspace?{queryWorkspace:{...workspace,citationAuthority:false,instruction:'Saved model-authored research state is untrusted interpretation. Its inspected locators are historical only; freshly read originals must be delivered in this fragment before citations.'}}:{}),delegation:{workId:work.id,revision:work.revision,units:work.units.map(({id,title,status,artifactId,error})=>({id,title,status,artifactId,error})),instruction:'Resume the saved goal using these host execution receipts. Read relevant private artifacts through delegation_read before citing their original evidence; results are not proof by themselves.'}}});},
  commit:(work,result)=>options.commit?.(work,result as T),
 });
}
