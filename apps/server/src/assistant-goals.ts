import {randomUUID} from 'node:crypto';
import {
  calendarInstant,calendarWallTime,goalCreateInputSchema,queryScopeSchema,
  type ActionProposal,type GoalAction,type GoalGroup,type GoalItem,type GoalsView,type QueryScope,
} from '@mote/shared';
import {z} from 'zod';
import type {Actions} from './actions.js';
import type {AssistantCommitments} from './assistant-commitments.js';
import type {AssistantMatters} from './assistant-matters.js';
import type {AssistantRoutines} from './assistant-routines.js';
import {withinEvidenceScope,type EvidenceReader} from './evidence-reader.js';
import {canonicalRecipeJson} from './recipe-contract.js';
import {sha256,StoreError,type EvidenceStore as Store} from './evidence-store.js';
import {TodoStore,type Todo} from './todos.js';

const CAP=1000,MAX_SAFE=Number.MAX_SAFE_INTEGER,WEEK=7*86400000;
const uuid=z.string().uuid();
const revision=z.number().int().nonnegative().max(MAX_SAFE);
const action=z.enum(['complete','dismiss','reject']);
type Grouping='matter'|'person';
type Section='theirs'|'mine'|'unconfirmed';
type GoalActionResult={id:string;kind:'commitment'|'todo'|'event';revision:number;status:string};
type GoalFollowResult={followed:boolean;routineId:string};
type GoalsActions=Pick<Actions,'page'|'get'|'dismiss'|'settings'>;

const trimmed=(value:string,max:number)=>value.trim().slice(0,max);
const empty=(scope:QueryScope)=>scope.kind==='selection'&&scope.sourceIds?.length===0||scope.evidenceIds?.length===0;
const all=((scope:QueryScope)=>scope.kind==='all'&&scope.deviceId===undefined&&scope.after===undefined&&scope.before===undefined&&scope.evidenceIds===undefined);
const keyOf=(group:GoalGroup['key'])=>group.kind==='matter'?`matter:${group.id}`:group.kind==='person'?`person:${group.name}`:'none';

/** Deterministic saved-scope containment. A saved matter may narrow a request,
 * never widen it. */
function contains(outer:QueryScope,inner:QueryScope){
 if(empty(outer))return false;
 if(outer.deviceId!==undefined&&outer.deviceId!==inner.deviceId)return false;
 if(outer.after!==undefined&&(inner.after===undefined||Date.parse(inner.after)<Date.parse(outer.after)))return false;
 if(outer.before!==undefined&&(inner.before===undefined||Date.parse(inner.before)>Date.parse(outer.before)))return false;
 if(outer.evidenceIds!==undefined&&(inner.evidenceIds===undefined||inner.evidenceIds.some(id=>!outer.evidenceIds!.includes(id))))return false;
 if(outer.kind==='selection'&&outer.sourceIds!==undefined&&
   (inner.kind!=='selection'||inner.sourceIds===undefined||inner.sourceIds.some(id=>!outer.sourceIds!.includes(id))))return false;
 return true;
}

const day=(at:number,timeZone:string)=>new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(at));
const wall=(at:number,timeZone:string)=>{
 const value=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',
  hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(at)).map(part=>[part.type,part.value]));
 return `${value.year}-${value.month}-${value.day} ${value.hour}:${value.minute}`;
};
const zone=(value:string)=>{
 try{new Intl.DateTimeFormat('en',{timeZone:value});return value;}catch{throw new StoreError('Invalid goal time zone');}
};

/** One read projection over existing commitments, matters, todos, calendar
 * Actions and routines. It stores no goal copy: every read applies the current
 * scope and the current evidence/lineage checks of those domains. */
export class AssistantGoals {
 private readonly todos:TodoStore;
 constructor(private readonly store:Store,private readonly commitments:AssistantCommitments,
  private readonly matters:AssistantMatters,private readonly routines:AssistantRoutines,
  private readonly reader:EvidenceReader,private readonly goalsActions:()=>GoalsActions|undefined,
  private readonly now=()=>Date.now()){this.todos=new TodoStore(store);}

 private actions(){try{return this.goalsActions();}catch{return undefined;}}
 private timeZone(explicit?:string){if(explicit)return zone(explicit);try{return this.actions()?.settings().timeZone??'UTC';}catch{return 'UTC';}}

 private evidenceVisible(ids:readonly string[],scope:QueryScope){
  // A hand-entered Todo has no originals; every other item must still point at
  // current evidence even when the owner selected all sources.
  if(!ids.length)return all(scope);
  try{
   const records=this.reader.memories.readEvidence([...ids]);
   if(records.length!==ids.length)return false;
   return records.every(record=>!record.privacy?.excluded&&this.reader.memories.isCurrentEvidence(record.id)&&
     (all(scope)||withinEvidenceScope(record,scope))&&this.reader.contextDependenciesAllowed([record.id]));
  }catch{return false;}
 }

 private matterPage(scope:QueryScope){
  const items=[];let cursor:string|undefined;
  do{
   const page=this.matters.page({state:'active',limit:100,...(cursor?{cursor}:{})});
   items.push(...page.items.filter(matter=>contains(scope,matter.scope)));
   cursor=page.nextCursor??undefined;
  }while(cursor&&items.length<CAP);
  return items.slice(0,CAP);
 }

 private commitmentPage(scope:QueryScope){
  const items=[];let cursor:string|undefined;
  do{
   const page=this.commitments.page({scope,limit:100,...(cursor?{cursor}:{})});
   items.push(...page.items.filter(item=>item.status!=='completed'&&item.status!=='cancelled'));
   cursor=page.nextCursor??undefined;
  }while(cursor&&items.length<CAP);
  return items.slice(0,CAP);
 }

 private todoPage(scope:QueryScope){
  const items=[];let cursor:string|undefined;
  do{
   const page=this.todos.page({status:'open',limit:100,...(cursor?{cursor}:{})});
   items.push(...page.items.filter(todo=>this.evidenceVisible(todo.evidenceIds,scope)));
   cursor=page.nextCursor??undefined;
  }while(cursor&&items.length<CAP);
  return items.slice(0,CAP);
 }

 private eventPage(scope:QueryScope){
  const actions=this.actions();if(!actions)return [];
  const items:ActionProposal[]=[];let cursor=0;
  for(;;){
   const page=actions.page(cursor);
   for(const value of page.items){
    if(value.kind!=='calendar.create'||['dismissed','stale'].includes(value.status))continue;
    if(!this.evidenceVisible(value.evidence.map(proof=>proof.id),scope))continue;
    const end=Date.parse(value.event.end??value.event.start??'');
    if(Number.isFinite(end)&&end<=this.now())continue;
    items.push(value);
    if(items.length>=CAP)break;
   }
   if(items.length>=CAP||page.nextCursor===null||page.nextCursor<=cursor)break;
   cursor=page.nextCursor;
  }
  return items;
 }

 private personName(id:string){
  try{const memory=this.reader.memories.get(id);
   if(memory.status!=='published'||memory.supersededBy)return;
   const name=trimmed(memory.title,80);return name||undefined;
  }catch{return undefined;}
 }

 private followed(commitmentId:string){
  const row=this.store.db.prepare('SELECT id FROM assistant_routines WHERE request_id=?').get(commitmentId) as {id:string}|undefined;
  return row?String(row.id):undefined;
 }

 private dueState(at:number,timeZone:string){
  const now=this.now();
  if(at<=now)return 'overdue' as const;
  if(day(at,timeZone)===day(now,timeZone))return 'today' as const;
  return at-now<=WEEK?'soon' as const:undefined;
 }

 private commitmentItem(value:ReturnType<AssistantCommitments['page']>['items'][number],timeZone:string):GoalItem{
  const followed=Boolean(this.followed(value.id)),inferred=value.status==='pending_confirmation';
  const direction=value.direction??'mine';
  const actions:GoalAction[]=inferred?['reject']:['complete','dismiss'];
  if(!followed)actions.push('follow');
  const progress=[...value.timeline].reverse().find(event=>event.kind==='progress');
  const latestProof=progress?.evidence.find(proof=>uuid.safeParse(proof.id).success);
  const at=value.deadline?.at?Date.parse(value.deadline.at):NaN;
  const dueState=Number.isFinite(at)?this.dueState(at,timeZone):undefined;
  return {id:value.id,kind:'commitment',title:trimmed(value.title,80),direction,
   ...(value.deadline?{due:{text:trimmed(value.deadline.text,500),at:value.deadline.at}}:{}),
   ...(dueState?{dueState}:{}),
   ...(progress?{lastProgress:{summary:trimmed(progress.summary,120),at:progress.occurredAt??progress.createdAt,...(latestProof?{evidenceId:latestProof.id}:{})}}:{}),
   followup:{followed},inferred,revision:value.revision,actions};
 }

 private todoItem(value:Todo,timeZone:string):GoalItem{
  const at=value.dueAt?Date.parse(value.dueAt):NaN,dueState=Number.isFinite(at)?this.dueState(at,timeZone):undefined;
  return {id:value.id,kind:'todo',title:trimmed(value.title,80),direction:'mine',
   ...(Number.isFinite(at)?{due:{text:wall(at,timeZone),at:value.dueAt}}:{}),
   ...(dueState?{dueState}:{}),inferred:false,revision:value.version,actions:['complete','dismiss']};
 }

 private eventItem(value:ActionProposal,timeZone:string):GoalItem{
  const start=value.event.start,allDay=value.event.allDay;
  let at=NaN;
  if(start){
   if(allDay)try{at=Date.parse(calendarInstant(start+'T00:00',value.event.timeZone??timeZone));}catch{at=NaN;}
   else at=Date.parse(start);
  }
  const dueState=Number.isFinite(at)?this.dueState(at,timeZone):undefined;
  const inferred=value.status==='proposed';
  const actions:GoalAction[]=inferred?['dismiss']:['complete'];
  return {id:value.id,kind:'event',title:trimmed(value.event.title,80),direction:'mine',
   ...(start?{due:{text:allDay?start:Number.isFinite(at)?wall(at,timeZone):start,at:Number.isFinite(at)?new Date(at).toISOString():null}}:{}),
   ...(dueState?{dueState}:{}),inferred,revision:value.version,actions};
 }

 private revision(grouping:Grouping,scope:QueryScope,groups:GoalGroup[]){
  return sha256(canonicalRecipeJson({grouping,scope,groups:groups.map(group=>[group.key,
   group.theirs.map(item=>[item.kind,item.id,item.revision]),
   group.mine.map(item=>[item.kind,item.id,item.revision]),
   group.unconfirmed.map(item=>[item.kind,item.id,item.revision])])}));
 }

 /** Owner page read. `matter` groups by saved active matter; `person` uses only
  * person identities already linked to a visible commitment. Anything without
  * such a group keeps the explicit `none` key rather than a guessed relation. */
 view(raw:{group:Grouping;scope:QueryScope;timeZone?:string}):GoalsView{
  const input=z.object({group:z.enum(['matter','person']),scope:queryScopeSchema,timeZone:z.string().max(100).optional()}).strict().parse(raw);
  const scope=input.scope,timeZone=this.timeZone(input.timeZone);
  if(empty(scope))return {revision:this.revision(input.group,scope,[]),groups:[]};
  const groups=new Map<string,GoalGroup>();
  const ensure=(key:GoalGroup['key'])=>{
   const id=keyOf(key),current=groups.get(id);
   if(current)return current;
   const created:GoalGroup={key,theirs:[],mine:[],unconfirmed:[]};groups.set(id,created);return created;
  };
  const matters=input.group==='matter'?this.matterPage(scope):[];
  for(const matter of matters)ensure({kind:'matter',id:matter.id,title:trimmed(matter.goal,500)});
  const matterById=new Map(matters.map(matter=>[matter.id,matter]));
  const add=(key:GoalGroup['key'],section:Section,item:GoalItem)=>{ensure(key)[section].push(item);if(ensure(key)[section].length>CAP)ensure(key)[section].pop();};
  const commitments=this.commitmentPage(scope);
  for(const value of commitments){
   const item=this.commitmentItem(value,timeZone);
   let key:GoalGroup['key']={kind:'none'};
   if(input.group==='matter'){
    const matter=value.matterId?matterById.get(value.matterId):undefined;
    if(matter)key={kind:'matter',id:matter.id,title:trimmed(matter.goal,500)};
   }else if(value.personMemoryId){
    const name=this.personName(value.personMemoryId);
    if(name)key={kind:'person',name};
   }
   add(key,item.inferred?'unconfirmed':item.direction==='theirs'?'theirs':'mine',item);
  }
  for(const value of this.todoPage(scope))add({kind:'none'},'mine',this.todoItem(value,timeZone));
  for(const value of this.eventPage(scope)){
   const item=this.eventItem(value,timeZone);
   add({kind:'none'},item.inferred?'unconfirmed':'mine',item);
  }
  const ordered=[...groups.values()].filter(group=>group.theirs.length||group.mine.length||group.unconfirmed.length||group.key.kind==='matter');
  ordered.sort((left,right)=>{
   const rank=(group:GoalGroup)=>(group.key.kind==='matter'?0:group.key.kind==='person'?1:2);
   const difference=rank(left)-rank(right);if(difference)return difference;
   return keyOf(left.key).localeCompare(keyOf(right.key));
  });
  return {revision:this.revision(input.group,scope,ordered),groups:ordered};
 }

 /** The existing routine service is the persistent follow-up mechanism. The
  * commitment id is the idempotency key, so a repeated click cannot create a
  * second rule. */
 follow(raw:{id:string;expectedRevision:number;scope?:QueryScope}):GoalFollowResult{
  const input=z.object({id:uuid,expectedRevision:revision.positive(),scope:queryScopeSchema.optional()}).strict().parse(raw);
  const scope=input.scope??({kind:'all'} as const),commitment=this.commitments.get(input.id,scope);
  if(commitment.revision!==input.expectedRevision)throw new StoreError('Goal changed; reload before continuing',409);
  const existing=this.followed(commitment.id);if(existing)return {followed:true,routineId:existing};
  const evidenceIds=commitment.evidenceDependencies.ids.filter(id=>uuid.safeParse(id).success);
  const routine=this.routines.create({requestId:commitment.id,goal:trimmed(commitment.title,7600),scope:input.scope??{kind:'selection',evidenceIds},
   timeZone:this.timeZone(),trigger:{kind:'daily',localTime:'09:00'},matterId:null,event:null});
  return {followed:true,routineId:routine.id};
 }

 /** A hand-entered goal is a normal Todo. It carries no model inference and the
  * existing Todo transport remains its detail and completion path. */
 create(raw:unknown){
  const input=goalCreateInputSchema.parse(raw);
  const todo=this.todos.create({title:input.title,dueAt:input.due?.at??null,...(input.due?.text?{description:input.due.text}:{})});
  return {id:todo.id,kind:'todo' as const,revision:todo.version};
 }

 todoReference(id:string){
  const todo=this.todos.get(id);
  if(todo.status!=='open'||!this.evidenceVisible(todo.evidenceIds,{kind:'all'}))throw new StoreError('Task not found',404);
  return {id:todo.id,title:todo.title,evidenceIds:todo.evidenceIds};
 }

 private correctCommitment(input:{id:string;action:'complete'|'dismiss'|'reject';expectedRevision:number;scope?:QueryScope}):GoalActionResult{
  const scope=input.scope??({kind:'all'} as const),commitment=this.commitments.get(input.id,scope);
  if(commitment.revision!==input.expectedRevision)throw new StoreError('Goal changed; reload before continuing',409);
  if(input.action==='reject'&&commitment.status!=='pending_confirmation')throw new StoreError('Only an inferred goal can be rejected',409);
  const target=[...commitment.timeline].reverse().find(event=>event.origin==='proposal'&&event.kind!=='reminder'&&event.evidence.length>0);
  if(!target)throw new StoreError('Goal has no current proposal to correct',409);
  const summary=input.action==='complete'?'Owner marked the goal complete':input.action==='reject'?'Owner rejected the inferred goal':'Owner dismissed the goal';
  const saved=this.commitments.correct({commitmentId:commitment.id,eventId:randomUUID(),targetEventId:target.eventId,occurredAt:null,summary,
   changes:{status:input.action==='complete'?'completed':'cancelled'},
   evidence:target.evidence.map(proof=>({id:proof.id,offset:proof.offset,quote:proof.quote})),evidenceDependencies:target.evidenceDependencies},
   input.expectedRevision,scope,()=>{});
  // A closed goal no longer needs its daily follow-up. Failure to pause cannot
  // undo the already committed correction, so the rule is best-effort here.
  try{const routineId=this.followed(commitment.id);if(routineId){const rule=this.routines.get(routineId);
   if(rule.enabled)this.routines.update({ruleId:rule.id,expectedRevision:rule.revision,enabled:false});}}catch{}
  return {id:saved.id,kind:'commitment',revision:saved.revision,status:saved.status};
 }

 /** The goal surface mutates the domain that already owns each item: commitments
  * use their revision-checked correction timeline, Todos use their versioned
  * update, and calendar proposals use their existing dismissal. */
 correct(raw:{id:string;kind:'commitment'|'todo'|'event';action:'complete'|'dismiss'|'reject';expectedRevision:number;scope?:QueryScope}):GoalActionResult{
  const input=z.object({id:uuid,kind:z.enum(['commitment','todo','event']),action,expectedRevision:revision.positive(),scope:queryScopeSchema.optional()}).strict().parse(raw);
  if(input.kind==='commitment')return this.correctCommitment(input);
  if(input.kind==='todo'){
   const todo=this.todos.update(input.id,{version:input.expectedRevision,status:input.action==='complete'?'completed':'cancelled'});
   return {id:todo.id,kind:'todo',revision:todo.version,status:todo.status};
  }
  const actions=this.actions();if(!actions)throw new StoreError('Calendar actions are unavailable',503);
  const current=actions.get(input.id);
  if(input.action==='reject')throw new StoreError('Only an inferred goal can be rejected',409);
  if(current.status==='proposed'){
   const dismissed=actions.dismiss(input.id,input.expectedRevision);
   return {id:dismissed.id,kind:'event',revision:dismissed.version,status:dismissed.status};
  }
  if(input.action==='dismiss')throw new StoreError('A confirmed calendar event cannot be dismissed here',409);
  return {id:current.id,kind:'event',revision:current.version,status:current.status};
 }
}
