import {formatEvidenceRef,queryScopeSchema,type QueryScope} from '@mote/shared';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import {z} from 'zod';
import {AssistantMatters,matterCommandSchema,matterScopeContains,type MatterAuthority} from './assistant-matters.js';
import type {AssistantRoutines} from './assistant-routines.js';
import type {AssistantCommitments} from './assistant-commitments.js';
import type {AssistantTasks} from './assistant-tasks.js';
import type {EvidenceReader} from './evidence-reader.js';
import {EvidenceExposurePolicy} from './evidence-exposure.js';
import {StoreError,type Store} from './store.js';
import {TaskRecords} from './task-records.js';

const empty=(scope:QueryScope)=>scope.kind==='selection'&&scope.sourceIds?.length===0||scope.evidenceIds?.length===0;
/** Saved intent with a wider scope must not leak into a narrowed detail read. */
function contains(outer:QueryScope,inner:QueryScope){
 if(empty(outer))return false;
 if(outer.deviceId!==undefined&&outer.deviceId!==inner.deviceId)return false;
 if(outer.after!==undefined&&(!inner.after||Date.parse(inner.after)<Date.parse(outer.after)))return false;
 if(outer.before!==undefined&&(!inner.before||Date.parse(inner.before)>Date.parse(outer.before)))return false;
 if(outer.evidenceIds!==undefined&&(!inner.evidenceIds||inner.evidenceIds.some(id=>!outer.evidenceIds!.includes(id))))return false;
 if(outer.kind==='selection'&&outer.sourceIds!==undefined&&(inner.kind!=='selection'||inner.sourceIds===undefined||inner.sourceIds.some(id=>!outer.sourceIds!.includes(id))))return false;
 return true;
}
const scopeValue=(value:string)=>{let parsed:unknown;try{parsed=JSON.parse(value);}catch{throw new StoreError('Invalid assistant detail scope');}return queryScopeSchema.parse(parsed);};
const querySchema=z.object({scope:z.string().max(16000),limit:z.coerce.number().int().min(1).max(100).optional(),cursor:z.string().max(1000).optional(),matterId:z.string().uuid().optional()}).strict();
const idOf=(request:FastifyRequest)=>z.object({id:z.string().uuid()}).parse(request.params).id;

/** Only the owner HTTP surface can mutate a matter. All derived links resolve
 * through current evidence/task readers; captured text never reaches commands. */
export function registerAssistantMatterRoutes(app:FastifyInstance,deps:{store:Store;matters:AssistantMatters;routines:AssistantRoutines;
 commitments:AssistantCommitments;tasks:AssistantTasks;reader:EvidenceReader;owner:(request:FastifyRequest)=>void}){
 const {matters,routines,commitments,tasks,reader,owner}=deps,records=new TaskRecords(deps.store);
 const authority=(scope:QueryScope):MatterAuthority=>({
  currentEvidence:ids=>reader.evidence(ids.map(id=>formatEvidenceRef('capture',id)),scope).flatMap(record=>{
   const item={id:record.id,title:record.windowTitle||record.appName||'',sourceId:record.provenance?.sourceId,deviceId:record.deviceId,at:record.capturedAt};
   return !record.privacy?.excluded&&reader.memories.isCurrentEvidence(record.id)&&matterScopeContains(scope,item)&&reader.contextDependenciesAllowed([record.id],new EvidenceExposurePolicy())?[item]:[];
  }),
  currentTask:id=>{try{tasks.get(id,scope);const task=records.get(id);return {id:task.id,state:task.state,revision:task.revision,updatedAt:task.updatedAt};}
   catch(error){if(error instanceof StoreError&&[403,404,409].includes(error.statusCode))return;throw error;}},
 });
 app.get('/api/assistant/matters',async request=>{
  owner(request);const {scope:raw,...args}=querySchema.omit({matterId:true}).parse(request.query),scope=scopeValue(raw);
  if(empty(scope))return {items:[],nextCursor:null};
  const page=matters.page(args);return {...page,items:page.items.filter(item=>contains(scope,item.scope))};
 });
 app.get('/api/assistant/matters/:id',async request=>{
  owner(request);const {scope:raw}=querySchema.pick({scope:true}).parse(request.query),scope=scopeValue(raw),id=idOf(request);
  if(!contains(scope,matters.get(id).scope))throw new StoreError('Matter not found',404);
  // Task readers require the exact original selection, not a broader page scope.
  return matters.detail(id,authority(matters.get(id).scope));
 });
 app.post('/api/assistant/matter-commands',{bodyLimit:65536},async request=>{
  owner(request);const command=matterCommandSchema.parse(request.body);
  const scope=command.type==='create'?command.scope:command.type==='edit'&&command.scope?command.scope:matters.get(command.matterId).scope;
  return matters.command(command,authority(scope));
 });
 app.get('/api/assistant/commitments',async request=>{
  owner(request);const {scope:raw,...args}=querySchema.parse(request.query);return commitments.page({...args,scope:scopeValue(raw)});
 });
 app.get('/api/assistant/commitments/:id',async request=>{
  owner(request);const {scope}=querySchema.pick({scope:true}).parse(request.query);return commitments.get(idOf(request),scopeValue(scope));
 });
 app.get('/api/assistant/routines',async request=>{
  owner(request);const {scope:raw,matterId,...args}=querySchema.parse(request.query),scope=scopeValue(raw);
  if(empty(scope))return {items:[],nextCursor:null};
  const page=routines.page(args);return {...page,items:page.items.filter(item=>contains(scope,item.scope)&&(!matterId||item.matterId===matterId))};
 });
 app.get('/api/assistant/routines/:id',async request=>{
  owner(request);const {scope:raw}=querySchema.pick({scope:true}).parse(request.query),scope=scopeValue(raw),rule=routines.get(idOf(request));
  if(!contains(scope,rule.scope))throw new StoreError('Routine not found',404);return rule;
 });
}
