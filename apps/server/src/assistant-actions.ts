import {assistantActionCommandSchema,queryScopeSchema,type AssistantActionResults,type QueryScope,type ActionProposalTarget} from '@mote/shared';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import {z} from 'zod';
import type {AssistantTasks} from './assistant-tasks.js';
import type {Actions} from './actions.js';
import type {ManagedCalendar} from './managed-calendar.js';
import type {TodoStore} from './todos.js';
import {canonicalRecipeJson} from './recipe-contract.js';
import {sha256,StoreError,type Store} from './store.js';

/** Links only: Todos and Actions remain the sole state/receipt authorities.
 * No model callback can reach command(), and this adapter has no sender. */
export class AssistantActions {
 constructor(private store:Store,private tasks:Pick<AssistantTasks,'actionSource'|'actionCurrent'>,
  private actions:Actions,private todos:TodoStore,private managed:ManagedCalendar){
  const retire=(taskId:string)=>`UPDATE action_proposals SET json=json_remove(json_set(json,'$.evidence',json('[]'),'$.uncertainty','',
     '$.event',json('{"title":"来源已删除的日程建议","start":null,"end":null,"timeZone":null,"allDay":false,"location":"","description":""}'),
     '$.version',json_extract(json,'$.version')+1,
     '$.status',CASE WHEN json_extract(json,'$.status') IN ('proposed','approved','dismissed') THEN 'stale' ELSE json_extract(json,'$.status') END),'$.message')
    WHERE id IN (SELECT object_id FROM assistant_action_links WHERE task_id=${taskId} AND kind!='todo.create');
    UPDATE todos SET version=version+1,json=json_set(json,'$.title','待办','$.description','','$.dueAt',NULL,'$.evidenceIds',json('[]'),'$.version',version+1)
    WHERE id IN (SELECT object_id FROM assistant_action_links WHERE task_id=${taskId} AND kind='todo.create');`;
  store.db.exec(`CREATE TABLE IF NOT EXISTS assistant_action_links(
   task_id TEXT NOT NULL REFERENCES task_records(id) ON DELETE CASCADE,draft_index INTEGER NOT NULL,
   matter_id TEXT,kind TEXT NOT NULL,object_id TEXT NOT NULL UNIQUE,command_hash TEXT NOT NULL,
   PRIMARY KEY(task_id,draft_index));
   CREATE INDEX IF NOT EXISTS assistant_action_links_matter ON assistant_action_links(matter_id,task_id);
   CREATE TRIGGER IF NOT EXISTS assistant_action_task_retired AFTER UPDATE OF state ON task_records
   WHEN new.state IN ('stale','cancelled') AND old.state!=new.state BEGIN
    ${retire('new.id')}
   END;
   CREATE TRIGGER IF NOT EXISTS assistant_action_task_deleted BEFORE DELETE ON task_records BEGIN ${retire('old.id')} END;`);
  store.registerStorage('assistant-action-links',{assistant_action_links:'length(CAST(task_id AS BLOB))+coalesce(length(CAST(matter_id AS BLOB)),0)+length(CAST(object_id AS BLOB))+length(CAST(command_hash AS BLOB))+128'});
 }
 current(id:string){
  const link=this.store.db.prepare("SELECT task_id FROM assistant_action_links WHERE object_id=? AND kind!='todo.create'").get(id);
  if(!link)return true;
  const taskId=String(link.task_id);if(!this.tasks.actionCurrent(taskId))return false;
  const row=this.store.db.prepare('SELECT json FROM action_proposals WHERE id=?').get(id);
  if(!row)return false;
  const action=JSON.parse(String(row.json)) as ReturnType<Actions['get']>;
  if(!['proposed','approved'].includes(action.status))return true;
  const ids=this.store.db.prepare('SELECT evidence_id FROM task_evidence WHERE task_id=?').all(taskId).map(row=>String(row.evidence_id));
  const records=this.actions.read(ids).filter(record=>record.provenance?.layer!=='derived');
  return Boolean(action.target&&this.managed.proposalGranted(action.kind,action.target,records));
 }
 currentTodo(id:string){
  const link=this.store.db.prepare("SELECT task_id FROM assistant_action_links WHERE object_id=? AND kind='todo.create'").get(id);
  return !link||this.tasks.actionCurrent(String(link.task_id));
 }
 private targets(source:ReturnType<AssistantTasks['actionSource']>,kind:'calendar.create'|'message.send'){
  const choices=[...this.actions.connectorTargets(),...this.actions.targets().flatMap(device=>device.calendars.map(calendar=>({name:device.deviceName+' · '+calendar.title,target:{deviceId:device.deviceId,calendarId:calendar.id} as ActionProposalTarget})))];
  return choices.filter(choice=>this.managed.proposalGranted(kind,choice.target,source.records));
 }
 get(taskId:string,scope:QueryScope):AssistantActionResults{
  const source=this.tasks.actionSource(taskId,scope);
  return {taskId,revision:source.task.revision,matterId:source.matterId,drafts:source.output.actions.map((draft,index)=>{
   const link=this.store.db.prepare('SELECT object_id FROM assistant_action_links WHERE task_id=? AND draft_index=?').get(taskId,index);
   let linked:AssistantActionResults['drafts'][number]['linked'];
   if(link){const id=String(link.object_id);
    if(draft.kind==='todo.create'){const todo=this.todos.get(id);linked={id,kind:draft.kind,status:todo.status};}
    else{const action=this.actions.get(id);linked={id,kind:draft.kind,status:action.status,...(action.operationId?{operationId:action.operationId}:{}),...(action.externalId?{externalId:action.externalId}:{}),...(action.error?{error:action.error}:{})};}
   }
   return {index,draft,targets:draft.kind==='todo.create'?[]:this.targets(source,draft.kind),...(linked?{linked}:{})};
  })};
 }
 byMatter(id:string,scope:QueryScope){
  const rows=this.store.db.prepare('SELECT DISTINCT task_id FROM assistant_action_links WHERE matter_id=? ORDER BY task_id').all(id);
  const items:AssistantActionResults[]=[];
  for(const row of rows)try{items.push(this.get(String(row.task_id),scope));}catch(error){if(!(error instanceof StoreError&&[404,409].includes(error.statusCode)))throw error;}
  return {items};
 }
 command(raw:unknown){
  const input=assistantActionCommandSchema.parse(raw),db=this.store.db;
  // Validation can durably retire an obsolete origin before a rejected command.
  this.tasks.actionSource(input.taskId,input.scope,input.expectedRevision);
  db.exec('SAVEPOINT assistant_action_command');
  try{
   const source=this.tasks.actionSource(input.taskId,input.scope,input.expectedRevision),draft=source.output.actions[input.index];
   if(!draft)throw new StoreError('Assistant action draft not found',404);
   const hash=sha256(canonicalRecipeJson(input));
   const prior=db.prepare('SELECT command_hash FROM assistant_action_links WHERE task_id=? AND draft_index=?').get(input.taskId,input.index);
   if(prior){if(prior.command_hash!==hash)throw new StoreError('Assistant action command conflicts with its original request',409);}
   else{
    let id:string;
    if(draft.kind==='todo.create'){
     if(input.target)throw new StoreError('A Todo has no external target',400);
     // TodoStore references original captures; chunks/Material evidence remain
     // in the task lineage rather than being copied into another task body.
     const evidenceIds=source.records.filter(record=>Boolean(db.prepare('SELECT 1 FROM captures WHERE id=?').get(record.id))).map(record=>record.id);
     if(evidenceIds.length>30)throw new StoreError('Choose a smaller task scope for this Todo',413);
     id=this.todos.create({...draft.todo,evidenceIds:[...new Set(evidenceIds)]}).id;
    }else{
     if(!input.target||!this.targets(source,draft.kind).some(choice=>canonicalRecipeJson(choice.target)===canonicalRecipeJson(input.target)))
      throw new StoreError('The action grant does not cover this task and target',403);
     id=this.actions.proposeAssistant(draft,input.target).id;
    }
    db.prepare('INSERT INTO assistant_action_links VALUES(?,?,?,?,?,?)').run(input.taskId,input.index,source.matterId,draft.kind,id,hash);
    this.store.reserveMetadata(0);
   }
   const result=this.get(input.taskId,input.scope);db.exec('RELEASE assistant_action_command');return result;
  }catch(error){db.exec('ROLLBACK TO assistant_action_command; RELEASE assistant_action_command');throw error;}
 }
}

export function registerAssistantActionRoutes(app:FastifyInstance,actions:AssistantActions,owner:(request:FastifyRequest)=>void){
 const scope=(raw:unknown)=>{const query=z.object({scope:z.string().max(16000)}).strict().parse(raw);let value:unknown;
  try{value=JSON.parse(query.scope);}catch{throw new StoreError('Invalid assistant action scope');}return queryScopeSchema.parse(value);};
 app.post('/api/assistant/action-commands',{bodyLimit:65536},async request=>{owner(request);return actions.command(request.body);});
 app.get('/api/assistant/tasks/:id/actions',async request=>{owner(request);return actions.get(z.object({id:z.string().uuid()}).parse(request.params).id,scope(request.query));});
 app.get('/api/assistant/matters/:id/actions',async request=>{owner(request);return actions.byMatter(z.object({id:z.string().uuid()}).parse(request.params).id,scope(request.query));});
}
