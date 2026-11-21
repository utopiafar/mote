import type {PluginResourceScope} from '@mote/plugin-host';
import {
 ideasIgnoreAllInputSchema,ideasQuerySchema,ideasViewSchema,
 type IdeaAction,type IdeaItem,type IdeasIgnoreAllInput,type IdeasIgnoreAllResult,type IdeasView,type OperationState,type QueryScope,type StartedIdea,
} from '@mote/shared';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import type {AssistantCards} from './assistant-cards.js';
import type {AssistantTasks} from './assistant-tasks.js';
import {withinEvidenceScope,type EvidenceReader} from './evidence-reader.js';
import {sha256,StoreError,type EvidenceStore} from './evidence-store.js';
import {moteText} from './i18n.js';
import {registerNavBadge} from './nav-state.js';
import type {OwnerQuestions} from './owner-questions.js';
import {taskEvidenceIds} from './task-evidence.js';
import {TaskRecords} from './task-records.js';

type IdeaCard=ReturnType<AssistantCards['ideaCandidates']>[number];
const all:QueryScope={kind:'all'};
const unfiltered=(scope:QueryScope)=>scope.kind==='all'&&scope.deviceId===undefined&&
 scope.after===undefined&&scope.before===undefined&&scope.evidenceIds===undefined;

function displayText(value:string,limit:number){
 return value.replace(/[\u0000-\u001f\u007f]+/g,' ').trim().slice(0,limit).replace(/[\uD800-\uDBFF]$/u,'').trimEnd();
}

function cardIdea(card:IdeaCard):IdeaItem|undefined{
 const detail=displayText(card.body,200),title=displayText(card.title,80)||displayText(detail,80);
 if(!title)return;
 const actions:IdeaAction[]=['later','ignore'];
 if(card.kind==='question')actions.unshift('answer');
 if(card.startable)actions.unshift('start');
 return {id:card.id,source:'card',kind:card.kind,title,detail:detail||undefined,revision:card.revision,seq:card.seq,actions};
}

const taskStatus={
 waiting:()=>moteText('排队中'),
 running:()=>moteText('正在进行'),
 blocked:()=>moteText('需要你补充'),
 succeeded:()=>moteText('已完成'),
 failed:()=>moteText('失败'),
 cancelled:()=>moteText('已取消'),
 skipped:()=>moteText('已跳过'),
} satisfies Record<Exclude<OperationState,'stale'>,()=>string>;

/** The owner projection reads existing card, question and task state. Card
 * feedback is also the sole writer for a bulk dismissal. */
export class AssistantIdeas{
 private readonly records:TaskRecords;
 constructor(private readonly store:EvidenceStore,private readonly cards:Pick<AssistantCards,'ideaCandidates'|'feedback'>,
  private readonly questions:Pick<OwnerQuestions,'page'|'ignoreAll'|'ignoreView'|'markSurfaced'>,private readonly tasks:Pick<AssistantTasks,'get'>,
  private readonly reader:EvidenceReader){
  this.records=new TaskRecords(store);
 }

 private snapshot<T>(read:()=>T):T{
  const db=this.store.db;
  db.exec('SAVEPOINT assistant_ideas');
  try{
   const result=read();
   db.exec('RELEASE assistant_ideas');
   return result;
  }catch(error){
   if(db.isTransaction)db.exec('ROLLBACK TO assistant_ideas; RELEASE assistant_ideas');
   throw error;
  }
 }

 private *questionIdeas(scope:QueryScope,seen:{watermark:number;items:Array<{id:string;revision:number}>}):Generator<IdeaItem>{
  if(scope.evidenceIds?.length===0||scope.kind==='selection'&&scope.sourceIds?.length===0)return;
  const dependencyIds=this.store.db.prepare('SELECT evidence_id FROM owner_question_dependencies WHERE question_id=?');
  const scoped=!unfiltered(scope);
  const selected=scope.evidenceIds&&new Set(taskEvidenceIds(this.store,{version:1,complete:true,ids:scope.evidenceIds}));
  let cursor:string|undefined;
  do{
   const page=this.questions.page({state:['open','deferred'],limit:100,cursor});
   for(const question of page.items){
    if(question.ignoredAt)continue;
    const ids=[...new Set([...dependencyIds.all(question.id).map(row=>String(row.evidence_id)),...question.evidence.map(span=>span.id)])];
    if(!this.reader.contextDependenciesAllowed(ids))continue;
    if(scoped){
     if(!ids.length||selected&&ids.some(id=>!selected.has(id)))continue;
     const records=this.reader.memories.readEvidenceIfCurrent(ids);
     if(!records||records.length!==ids.length||records.some(record=>record.privacy.excluded||!withinEvidenceScope(record,scope)))continue;
    }
    const detail=displayText(question.prompt,200),title=displayText(question.title,80)||displayText(detail,80);
    if(!title)continue;
    const updated=Date.parse(question.updatedAt);
    if(Number.isFinite(updated))seen.watermark=Math.max(seen.watermark,updated);
    seen.items.push({id:question.id,revision:question.revision});
    yield {id:question.id,source:'owner-question',kind:'needs-info',title,detail:detail||undefined,
     revision:question.revision,seq:0,actions:['answer']};
   }
   cursor=page.nextCursor??undefined;
  }while(cursor);
 }

 private startedIdea(card:IdeaCard,scope:QueryScope):StartedIdea|undefined{
  if(!card.taskId)return;
  try{
   const {task}=this.tasks.get(card.taskId,scope);
   if(task.state==='stale')return;
   const record=this.records.get(card.taskId);
   if(record.state==='stale')return;
   const title=displayText('goal' in task?task.goal:card.title,80)||displayText(card.body,80);
   if(!title)return;
   const steps=this.store.db.prepare('SELECT succeeded,total,updated_at FROM operation_progress WHERE id=? AND total>0').get(record.operationId);
   const progress=steps?moteText('已完成 {0}/{1}',steps.succeeded,steps.total):taskStatus[record.state]();
   const updatedAt=steps&&Number(steps.updated_at)>Date.parse(record.updatedAt)
    ?new Date(Number(steps.updated_at)).toISOString():record.updatedAt;
   return {taskId:record.id,title,state:record.state,progress,updatedAt};
  }catch(error){
   if(error instanceof StoreError&&[403,404,409,410].includes(error.statusCode))return;
   throw error;
  }
 }

 private read(scope:QueryScope,now:number,includeStarted=false){
  const mine:IdeaItem[]=[],yours:IdeaItem[]=[],started:StartedIdea[]=[];
  const canIgnoreAll=unfiltered(scope),questionSeen={watermark:0,items:[] as Array<{id:string;revision:number}>};
  let watermark=0;
  for(const card of this.cards.ideaCandidates(scope,now,{includeStarted})){
   if(card.taskId){
    const item=this.startedIdea(card,scope);
    if(item)started.push(item);
    continue;
   }
   const item=cardIdea(card);
   if(!item)continue;
   (item.kind==='suggestion'?mine:yours).push(item);
   // The command has no scope parameter. Only an unfiltered read can
   // supply a watermark for ignoring cards across the owner's scope.
   if(canIgnoreAll)watermark=Math.max(watermark,item.seq);
  }
  for(const question of this.questionIdeas(scope,questionSeen))yours.push(question);
  return {watermark,questionWatermark:canIgnoreAll?questionSeen.watermark:0,mine,yours,started,questionSeen};
 }

 private viewAt(scope:QueryScope,now:number,recordSurface=false):IdeasView{
  const {questionSeen,...items}=this.read(scope,now,true);
  const view=ideasViewSchema.parse({...items,revision:sha256(JSON.stringify(items))});
  if(recordSurface&&unfiltered(scope)&&questionSeen.items.length)this.questions.markSurfaced(view.questionWatermark,view.revision,questionSeen.items);
  return view;
 }

 view(scope:QueryScope):IdeasView{
  return this.snapshot(()=>this.viewAt(scope,Date.now(),true));
 }

 count():number{
  return this.snapshot(()=>{
   const {mine,yours}=this.read(all,Date.now());
   return mine.length+yours.length;
  });
 }

 ignoreAll({upToSeq,upToQuestionAt,viewRevision}:IdeasIgnoreAllInput):IdeasIgnoreAllResult{
  return this.snapshot(()=>{
   const now=Date.now();
   let ignored=0;
   for(const card of this.cards.ideaCandidates(all,now,{upToSeq})){
    if(!cardIdea(card))continue;
    this.cards.feedback(card.id,{action:'ignore',expectedRevision:card.revision},all);
    ignored++;
   }
   if(upToQuestionAt!==undefined)ignored+=viewRevision?this.questions.ignoreView(viewRevision):this.questions.ignoreAll(upToQuestionAt);
   return {ignored,revision:this.viewAt(all,now).revision};
  });
 }
}

export function registerAssistantIdeaRoutes(app:FastifyInstance,ideas:AssistantIdeas,owner:(request:FastifyRequest)=>void,scope?:PluginResourceScope){
 scope?.defer(registerNavBadge('ideas',()=>ideas.count()));
 app.get('/api/assistant/ideas',async request=>{
  owner(request);
  return ideas.view(ideasQuerySchema.parse(request.query).scope);
 });
 app.post('/api/assistant/ideas/ignore-all',{bodyLimit:16384},async request=>{
  owner(request);
  return ideas.ignoreAll(ideasIgnoreAllInputSchema.parse(request.body));
 });
}
