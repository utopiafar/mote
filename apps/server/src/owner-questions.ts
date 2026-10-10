import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {ownerQuestionProviderRefSchema,ownerQuestionReplySchema,ownerQuestionSchema,ownerQuestionStateSchema,type OwnerQuestion,type OwnerQuestionPage,type OwnerQuestionProviderRef,type OwnerQuestionReply} from '@mote/shared';
import {StoreError,sha256,type Store} from './store.js';
import {decodeMemoryPrivate,encodeMemoryPrivate} from './memory-private-storage.js';
import {moteText} from './i18n.js';
import {ownerQuestionAnswerSchema,ownerQuestionCreateSchema,ownerQuestionProviderInstallationSchema,type OwnerQuestionAnswer,type OwnerQuestionCreate,type OwnerQuestionProvider,type OwnerQuestionRecord,type ResolvedOwnerQuestionReply} from './owner-question-contract.js';

type PrivatePayload={title:string;prompt:string;reason?:string;evidence:OwnerQuestion['evidence'];choices:OwnerQuestion['choices'];messages:OwnerQuestion['messages'];outcome?:string;context?:unknown};
type StoredQuestion=Omit<OwnerQuestion,'title'|'prompt'|'reason'|'evidence'|'choices'|'messages'|'outcome'>&{installationEpoch:string;private?:string};
type Row={id:string;identity:string;json:string};
const providerKey=(ref:OwnerQuestionProviderRef)=>JSON.stringify([ref.id,ref.version]);

/** Durable owner questions never occupy an executor/model slot while awaiting a reply.
 * Semantic decisions and continuation writes belong to exact installed providers. */
export class OwnerQuestions {
 private providers=new Map<string,OwnerQuestionProvider>();
 private pending=new Map<string,{hash:string;work:Promise<OwnerQuestion>}>();
 constructor(private store:Store,private now=()=>new Date().toISOString()){
  const db=store.db;
  db.exec(`CREATE TABLE IF NOT EXISTS owner_questions(id TEXT PRIMARY KEY,identity TEXT NOT NULL UNIQUE,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,json TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS owner_questions_recent ON owner_questions(updated_at DESC,id DESC);
   CREATE TABLE IF NOT EXISTS owner_question_dependencies(question_id TEXT NOT NULL REFERENCES owner_questions(id) ON DELETE CASCADE,evidence_id TEXT NOT NULL,PRIMARY KEY(question_id,evidence_id));
   CREATE INDEX IF NOT EXISTS owner_question_evidence ON owner_question_dependencies(evidence_id,question_id);
   CREATE TABLE IF NOT EXISTS owner_question_replies(question_id TEXT NOT NULL REFERENCES owner_questions(id) ON DELETE CASCADE,request_id TEXT NOT NULL,request_hash TEXT NOT NULL,PRIMARY KEY(question_id,request_id));`);
  const retire=(id:string)=>`UPDATE owner_questions SET json=json_set(json_remove(json,'$.private','$.continuationId'),'$.state','obsolete','$.revision',json_extract(json,'$.revision')+1),updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE json_extract(json,'$.state')!='obsolete' AND id IN (SELECT question_id FROM owner_question_dependencies WHERE evidence_id=${id});`;
  db.exec(`CREATE TRIGGER IF NOT EXISTS owner_question_original_deleted BEFORE DELETE ON captures BEGIN ${retire('old.id')} END;`);
  for(const [table,event,condition] of [['file_chunks','BEFORE DELETE',''],['material_evidence','AFTER UPDATE OF invalidated',' WHEN new.invalidated=1']] as const){
   if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))db.exec(`CREATE TRIGGER IF NOT EXISTS owner_question_${table}_retired ${event} ON ${table}${condition} BEGIN ${retire(table==='material_evidence'?'new.id':'old.id')} END;`);
  }
  if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='material_heads'").get())db.exec(`CREATE TRIGGER IF NOT EXISTS owner_question_material_deleted BEFORE DELETE ON material_heads BEGIN
   UPDATE owner_questions SET json=json_set(json_remove(json,'$.private','$.continuationId'),'$.state','obsolete','$.revision',json_extract(json,'$.revision')+1),updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE json_extract(json,'$.state')!='obsolete' AND json_extract(json,'$.materialId')=old.id;
  END;`);
  if(store.contentEncryption.enabled)this.transaction(()=>{
   for(const row of db.prepare("SELECT id,identity,json FROM owner_questions WHERE json_extract(json,'$.private') LIKE 'json:%'").all() as Row[]){const value=this.decode(row);this.save(value.record,value.stored.installationEpoch);}
  });
 }
 register(provider:OwnerQuestionProvider){
  ownerQuestionProviderInstallationSchema.parse({id:provider.id,version:provider.version,installationEpoch:provider.installationEpoch});
  if(typeof provider.validate!=='function'||typeof provider.answer!=='function'||provider.commit!==undefined&&typeof provider.commit!=='function')throw new StoreError('Invalid owner question provider');
  const key=providerKey(provider);if(this.providers.has(key))throw new StoreError('Owner question provider already installed',409);
  this.providers.set(key,provider);return()=>{if(this.providers.get(key)===provider)this.providers.delete(key);};
 }
 private transaction<T>(run:()=>T):T{const db=this.store.db,own=!db.isTransaction;if(own)db.exec('BEGIN IMMEDIATE');try{const result=run();if(own)db.exec('COMMIT');return result;}catch(error){if(own&&db.isTransaction)db.exec('ROLLBACK');throw error;}}
 private row(id:string):Row{const row=this.store.db.prepare('SELECT id,identity,json FROM owner_questions WHERE id=?').get(id) as Row|undefined;if(!row)throw new StoreError('Owner question not found',404);return row;}
 private decode(row:Row):{record:OwnerQuestionRecord;stored:StoredQuestion}{
  const stored=JSON.parse(row.json) as StoredQuestion,{private:encoded,installationEpoch:_epoch,...metadata}=stored;
  const payload=encoded?decodeMemoryPrivate<PrivatePayload>(this.store,encoded):undefined;
  const question=ownerQuestionSchema.parse({...metadata,title:payload?.title??'',prompt:payload?.prompt??'',evidence:payload?.evidence??[],choices:payload?.choices??[],messages:payload?.messages??[],...(payload?.reason!==undefined?{reason:payload.reason}:{}),...(payload?.outcome!==undefined?{outcome:payload.outcome}:{}),updatedAt:stored.state==='obsolete'?String(this.store.db.prepare('SELECT updated_at FROM owner_questions WHERE id=?').get(row.id)!.updated_at):metadata.updatedAt});
  return {record:{question,context:payload?.context},stored};
 }
 private encode(record:OwnerQuestionRecord,installationEpoch:string):string{
  const {title,prompt,reason,evidence,choices,messages,outcome,...metadata}=ownerQuestionSchema.parse(record.question);
  return JSON.stringify({...metadata,installationEpoch,...(metadata.state==='obsolete'?{}:{private:encodeMemoryPrivate(this.store,{title,prompt,reason,evidence,choices,messages,outcome,context:record.context})})});
 }
 private save(record:OwnerQuestionRecord,installationEpoch:string){
  const json=this.encode(record,installationEpoch),old=this.row(record.question.id);
  this.store.reserveMetadata(Math.max(0,Buffer.byteLength(json)-Buffer.byteLength(old.json)));
  this.store.db.prepare('UPDATE owner_questions SET json=?,updated_at=? WHERE id=?').run(json,record.question.updatedAt,record.question.id);
 }
 private current(id:string):{record:OwnerQuestionRecord;stored:StoredQuestion;provider?:OwnerQuestionProvider}{
  const value=this.decode(this.row(id)),provider=this.providers.get(providerKey(value.record.question.provider));
  if(value.record.question.state==='obsolete')return {...value};
  // An absent plugin is temporarily unavailable. A replaced install cannot accept old questions.
  if(provider&&(provider.installationEpoch!==value.stored.installationEpoch||!provider.validate(value.record))){this.obsolete(id);return this.current(id);}
  return {...value,provider};
 }
 create(ref:OwnerQuestionProviderRef,input:OwnerQuestionCreate):OwnerQuestion {
  ref=ownerQuestionProviderRefSchema.parse({id:ref.id,version:ref.version});const provider=this.providers.get(providerKey(ref));if(!provider)throw new StoreError('Owner question provider unavailable',409);
  const parsed=ownerQuestionCreateSchema.parse(input),dependencies=[...new Set(parsed.dependencyIds)].sort();
  if(new Set(parsed.choices.map(choice=>choice.id)).size!==parsed.choices.length)throw new StoreError('Duplicate owner question choices');
  const identity=sha256(JSON.stringify([ref,provider.installationEpoch,parsed.operationId,parsed.workId,parsed.key,parsed.materialRef??null,dependencies]));
  return this.transaction(()=>{
   const prior=this.store.db.prepare('SELECT id FROM owner_questions WHERE identity=?').get(identity);if(prior)return this.get(String(prior.id));
   const {key:_key,dependencyIds:_dependencies,context,...publicInput}=parsed,at=this.now();
   const question=ownerQuestionSchema.parse({...publicInput,id:randomUUID(),provider:ref,state:'open',revision:1,createdAt:at,updatedAt:at,messages:[{role:'assistant',text:parsed.prompt,createdAt:at}]});
   const record={question,context};if(!provider.validate(record))throw new StoreError('Owner question evidence or work changed',409);
   const json=this.encode(record,provider.installationEpoch);this.store.reserveMetadata(Buffer.byteLength(json)+dependencies.reduce((bytes,id)=>bytes+Buffer.byteLength(id)+128,0)+512);
   this.store.db.prepare('INSERT INTO owner_questions VALUES(?,?,?,?,?)').run(question.id,identity,at,at,json);
   for(const dependency of dependencies)this.store.db.prepare('INSERT INTO owner_question_dependencies VALUES(?,?)').run(question.id,dependency);
   return question;
  });
 }
 get(id:string):OwnerQuestion {return structuredClone(this.current(id).record.question);}
 page(args:{state?:OwnerQuestion['state']|OwnerQuestion['state'][];operationId?:string;operationIds?:string[];workId?:string;materialId?:string;limit?:number;cursor?:string}={}):OwnerQuestionPage {
  const selected=z.object({state:z.union([ownerQuestionStateSchema,z.array(ownerQuestionStateSchema).min(1).max(5)]).optional(),operationId:z.string().max(512).optional(),operationIds:z.array(z.string().min(1).max(512)).min(1).max(100).optional(),workId:z.string().max(512).optional(),materialId:z.string().max(256).optional(),limit:z.number().int().min(1).max(100).default(30),cursor:z.string().max(1000).optional()}).strict().parse(args);
  const conditions:string[]=[],parameters:(string|number)[]=[];
  if(selected.state!==undefined){const states=[selected.state].flat();conditions.push(`json_extract(json,'$.state') IN (${states.map(()=>'?').join(',')})`);parameters.push(...states);}
  for(const field of ['operationId','workId','materialId'] as const)if(selected[field]!==undefined){conditions.push(`json_extract(json,'$.${field}')=?`);parameters.push(selected[field]!);}
  if(selected.operationIds){conditions.push("json_extract(json,'$.operationId') IN (SELECT value FROM json_each(?))");parameters.push(JSON.stringify([...new Set(selected.operationIds)]));}
  let cursor:{at:string;id:string}|undefined;
  if(selected.cursor)try{cursor=z.object({at:z.string().datetime({offset:true}),id:z.string().uuid()}).strict().parse(JSON.parse(Buffer.from(selected.cursor,'base64url').toString()));}catch{throw new StoreError('Invalid owner question cursor');}
  const found:Array<{question:OwnerQuestion;cursor:{at:string;id:string}}>=[],states=selected.state===undefined?undefined:[selected.state].flat();
  // Validation can retire a candidate. Keep scanning its original order until
  // the requested page contains current matches, rather than reporting no pending work.
  while(found.length<=selected.limit){
   const where=[...conditions,...cursor?['(updated_at<? OR (updated_at=? AND id<?))']:[]];
   const rows=this.store.db.prepare(`SELECT id,updated_at FROM owner_questions ${where.length?'WHERE '+where.join(' AND '):''} ORDER BY updated_at DESC,id DESC LIMIT ?`).all(...parameters,...cursor?[cursor.at,cursor.at,cursor.id]:[],Math.max(30,selected.limit+1));
   if(!rows.length)break;
   for(const row of rows){cursor={at:String(row.updated_at),id:String(row.id)};const question=this.get(cursor.id);if(!states||states.includes(question.state))found.push({question,cursor});if(found.length>selected.limit)break;}
   if(found.length>selected.limit||rows.length<Math.max(30,selected.limit+1))break;
  }
  const page=found.slice(0,selected.limit),last=page.at(-1);
  return {items:page.map(item=>item.question),nextCursor:found.length>selected.limit&&last?Buffer.from(JSON.stringify(last.cursor)).toString('base64url'):null};
 }
 /** Retire private prose in the same transaction as a dependency/work withdrawal. */
 obsolete(id:string){return this.transaction(()=>{const value=this.decode(this.row(id));if(value.record.question.state==='obsolete')return;value.record.question.state='obsolete';value.record.question.revision++;value.record.question.updatedAt=this.now();delete value.record.question.continuationId;this.save(value.record,value.stored.installationEpoch);});}
 private receipt(id:string,reply:OwnerQuestionReply,hash:string){const prior=this.store.db.prepare('SELECT request_hash FROM owner_question_replies WHERE question_id=? AND request_id=?').get(id,reply.requestId);if(prior&&prior.request_hash!==hash)throw new StoreError('Owner reply request ID was reused with different content',409);return Boolean(prior);}
 reply(id:string,raw:OwnerQuestionReply):Promise<OwnerQuestion>{
  const reply=ownerQuestionReplySchema.parse(raw),hash=sha256(JSON.stringify(reply)),key=JSON.stringify([id,reply.requestId]);
  const active=this.pending.get(key);if(active){if(active.hash!==hash)return Promise.reject(new StoreError('Owner reply request ID was reused with different content',409));return active.work;}
  const work=this.performReply(id,reply,hash);this.pending.set(key,{hash,work});void work.finally(()=>this.pending.delete(key)).catch(()=>{});return work;
 }
 private async performReply(id:string,reply:OwnerQuestionReply,hash:string):Promise<OwnerQuestion>{
  if(this.receipt(id,reply,hash))return this.get(id);
  const initial=this.current(id),record=structuredClone(initial.record),provider=initial.provider;
  if(record.question.state==='obsolete')throw new StoreError('Owner question is obsolete',409);
  if(!provider)throw new StoreError('Owner question provider unavailable',409);
  if(record.question.state==='answered'||record.question.revision!==reply.expectedRevision)throw new StoreError('Owner question changed; reload before answering',409);
  const resolved:ResolvedOwnerQuestionReply={...reply};
  if(reply.choiceId){const choice=record.question.choices.find(choice=>choice.id===reply.choiceId);if(!choice)throw new StoreError('Owner question choice is no longer available',409);resolved.answer=choice.answer;}
  const prepared:OwnerQuestionAnswer|undefined=reply.action==='defer'?undefined:ownerQuestionAnswerSchema.parse(await provider.answer(record,resolved));
  // Preparation may await a model; recheck before entering the transaction and again before writes.
  this.current(id);
  return this.transaction(()=>{
   if(this.receipt(id,reply,hash))return this.get(id);
   const current=this.current(id);
   if(current.record.question.state==='obsolete'||current.record.question.revision!==reply.expectedRevision||current.provider!==provider||current.stored.installationEpoch!==provider.installationEpoch)throw new StoreError('Owner question changed while interpreting the answer',409);
   const value=structuredClone(current.record),question=value.question,at=this.now();
   let outcome=prepared;
   if(prepared){const committed=provider.commit?.(value,resolved,prepared);if(committed!==undefined)outcome=ownerQuestionAnswerSchema.parse(committed);}
   question.updatedAt=at;question.revision++;
   if(reply.action==='defer'){question.state='deferred';question.messages.push({role:'user',text:moteText('稍后再说'),createdAt:at});}
   else {
    if(resolved.answer!==undefined)question.messages.push({role:'user',text:resolved.answer,createdAt:at});
    else if(reply.action==='unknown')question.messages.push({role:'user',text:moteText('我也不知道，结束这次追问'),createdAt:at});
    if(outcome!.kind==='followup'){question.state='open';question.prompt=outcome!.prompt;if(outcome!.choices!==undefined)question.choices=outcome!.choices;question.messages.push({role:'assistant',text:outcome!.prompt,createdAt:at});delete question.outcome;delete question.continuationId;}
    else if(outcome!.kind==='continued'){question.state='answered';question.continuationId=outcome!.continuationId;question.outcome=outcome!.outcome;}
    else {question.state='closed';question.outcome=outcome!.outcome;delete question.continuationId;}
   }
   const afterEffect=this.decode(this.row(id));
   if(afterEffect.record.question.state==='obsolete'||afterEffect.record.question.revision!==reply.expectedRevision)throw new StoreError('Owner question evidence changed during continuation',409);
   if(!provider.validate(value))throw new StoreError('Owner question continuation failed current validation',409);
   this.save(value,current.stored.installationEpoch);
   this.store.reserveMetadata(Buffer.byteLength(id)+Buffer.byteLength(reply.requestId)+hash.length+128);
   this.store.db.prepare('INSERT INTO owner_question_replies VALUES(?,?,?)').run(id,reply.requestId,hash);
   return structuredClone(question);
  });
 }
}
declare module '@deepseek-ai/cordis' {interface Context {moteOwnerQuestions:OwnerQuestions;}}
