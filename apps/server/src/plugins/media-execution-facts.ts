import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {requestLocalJson,isLoopback} from '../local-http.js';
import {sha256,StoreError} from '../store.js';
import type {ExecutionStep} from '../execution-engine.js';
import type {FileStore} from '../files.js';
type Store=FileStore['store'];

export const mediaExecutionFact=z.object({version:z.literal(1),requestId:z.string().uuid(),incarnation:z.string().uuid().optional(),stage:z.enum(['ocr','transcribe','diarize']).optional(),state:z.enum(['accepted','running','succeeded','failed','unknown']),acceptedAt:z.number().int().positive().optional(),startedAt:z.number().int().positive().optional(),finishedAt:z.number().int().positive().optional(),outcome:z.enum(['completed','processing_failed','worker_restarted','receipt_unavailable']).optional(),failureCode:z.enum(['processing_failed','processing_timeout','unsupported_input']).optional()}).strict();
export type MediaExecutionFact=z.infer<typeof mediaExecutionFact>;
export type MediaStage='ocr'|'transcribe'|'diarize';
export type MediaExecutionCall={requestId:string;scope:string;captureId:string;stepId:string;input:Record<string,unknown>;generation:string;configuration:string;stage:MediaStage;issuedAttempt:number;supported:number;fact?:MediaExecutionFact;state:'issued'|'settled'|'cleanup'};
type Row={request_id:string;scope:string;capture_id:string;step_id:string;input:string;generation:string;configuration:string;stage:MediaStage;issued_attempt:number;supported:number;fact:string|null;state:MediaExecutionCall['state']};
const view=(row:Row):MediaExecutionCall=>({requestId:row.request_id,scope:row.scope,captureId:row.capture_id,stepId:row.step_id,input:JSON.parse(row.input),generation:row.generation,configuration:row.configuration,stage:row.stage,issuedAttempt:row.issued_attempt,supported:row.supported,...(row.fact?{fact:mediaExecutionFact.parse(JSON.parse(row.fact))}:{}),state:row.state});

/** Identities and fixed execution metadata only. This is not a result cache or
 * an execution authority; the current domain grant still decides all replay. */
export class MediaExecutionCalls {
 private nonce:string;
 constructor(private store:Store){
  store.db.exec(`CREATE TABLE IF NOT EXISTS media_execution_instance(id INTEGER PRIMARY KEY CHECK(id=1),nonce TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS media_execution_calls(request_id TEXT PRIMARY KEY,scope TEXT NOT NULL,capture_id TEXT NOT NULL,step_id TEXT NOT NULL,input TEXT NOT NULL,generation TEXT NOT NULL,configuration TEXT NOT NULL,stage TEXT NOT NULL,issued_attempt INTEGER NOT NULL,supported INTEGER NOT NULL DEFAULT -1,fact TEXT,state TEXT NOT NULL DEFAULT 'issued');
   CREATE INDEX IF NOT EXISTS media_execution_pending ON media_execution_calls(state);`);
  store.registerStorage('media-processing',{
    media_execution_calls:'length(CAST(input AS BLOB))+coalesce(length(CAST(fact AS BLOB)),0)+1024',
    media_execution_instance:'length(CAST(nonce AS BLOB))+128',
  });
  store.db.prepare('INSERT OR IGNORE INTO media_execution_instance VALUES(1,?)').run(randomUUID()+randomUUID());
  this.nonce=String(store.db.prepare('SELECT nonce FROM media_execution_instance WHERE id=1').get()!.nonce);
 }
 scope(stepId:string,generation:string,requestId:string){return sha256(JSON.stringify([this.nonce,stepId,generation,requestId]));}
 begin(input:{requestId:string;captureId:string;step:ExecutionStep;generation:string;configuration:string;stage:MediaStage}){
  const {requestId,captureId,step,generation,configuration,stage}=input;
  if(step.state!=='running'||!Number.isSafeInteger(step.attempts)||step.attempts<1)throw new StoreError('Media request needs a current execution attempt',409);
  const scope=this.scope(step.id,generation,requestId),canonical=JSON.stringify(step.input),db=this.store.db;
  this.store.reserveMetadata(Buffer.byteLength(canonical)+1024);
  db.prepare('INSERT INTO media_execution_calls(request_id,scope,capture_id,step_id,input,generation,configuration,stage,issued_attempt) VALUES(?,?,?,?,?,?,?,?,?)').run(requestId,scope,captureId,step.id,canonical,generation,configuration,stage,step.attempts);
  return this.get(requestId)!;
 }
 get(id:string){const row=this.store.db.prepare('SELECT * FROM media_execution_calls WHERE request_id=?').get(id) as Row|undefined;return row?view(row):undefined;}
 pending(){return (this.store.db.prepare("SELECT * FROM media_execution_calls WHERE state IN ('issued','cleanup') ORDER BY rowid").all() as Row[]).map(view);}
 support(id:string,supported:boolean){this.store.db.prepare("UPDATE media_execution_calls SET supported=? WHERE request_id=? AND state='issued'").run(Number(supported),id);}
 observe(id:string,value:MediaExecutionFact){
  const call=this.get(id),fact=mediaExecutionFact.parse(value);
  // A new worker incarnation cannot report the old call's outcome, but its
  // explicit `worker_restarted`/`receipt_unavailable` unknown is the proof that
  // the old recognizer is gone and the input may be replayed.
  const restarted=fact.state==='unknown'&&['worker_restarted','receipt_unavailable'].includes(fact.outcome??'');
  const receiptUnavailable=fact.state==='unknown'&&fact.outcome==='receipt_unavailable';
  if(!call||call.state==='settled'||fact.requestId!==id||!receiptUnavailable&&(fact.stage!==call.stage||!fact.incarnation||!fact.acceptedAt)||call.fact?.incarnation&&call.fact.incarnation!==fact.incarnation&&!restarted)return false;
  if(['succeeded','failed'].includes(fact.state)&&(!fact.finishedAt||fact.state==='succeeded'&&!fact.startedAt||fact.state==='failed'&&!fact.failureCode))return false;
  // A terminal observation is monotonic, even when a subsequent read fails.
  if(call.fact&&['succeeded','failed'].includes(call.fact.state))return JSON.stringify(call.fact)===JSON.stringify(fact);
  const json=JSON.stringify(fact);this.store.reserveMetadata(Buffer.byteLength(json)+256);
  this.store.db.prepare('UPDATE media_execution_calls SET fact=?,supported=1 WHERE request_id=?').run(json,id);return true;
 }
 settle(id:string){this.store.db.prepare("UPDATE media_execution_calls SET state='settled' WHERE request_id=? AND state='issued'").run(id);}
 cleanup(id:string){this.store.db.prepare("UPDATE media_execution_calls SET state='cleanup' WHERE request_id=?").run(id);}
 erased(id:string){this.store.db.prepare("DELETE FROM media_execution_calls WHERE request_id=? AND state='cleanup'").run(id);}
}

type Address={endpoint:string;apiKey:string;scope:string;requestId:string;signal:AbortSignal};
const address=(input:Address)=>{
 if(!isLoopback(input.endpoint)||!input.apiKey)return;
 const url=new URL(input.endpoint);url.pathname='/executions/'+input.requestId;url.search='';url.hash='';return url;
};
export async function readMediaExecutionFact(input:Address){
 const url=address(input);if(!url)return;
 try{const fact=mediaExecutionFact.parse(await requestLocalJson(url,{headers:{Authorization:'Bearer '+input.apiKey,'X-Mote-Request-Scope':input.scope},signal:AbortSignal.any([input.signal,AbortSignal.timeout(10000)]),limit:4096}));return fact.requestId===input.requestId?fact:undefined;}
 catch{input.signal.throwIfAborted();return;}
}
export async function eraseMediaExecutionFact(input:Address){
 const url=address(input);if(!url)return false;
 try{const value=z.object({version:z.literal(1),requestId:z.string().uuid(),deleted:z.literal(true)}).strict().parse(await requestLocalJson(url,{method:'DELETE',headers:{Authorization:'Bearer '+input.apiKey,'X-Mote-Request-Scope':input.scope},signal:AbortSignal.any([input.signal,AbortSignal.timeout(10000)]),limit:4096}));return value.requestId===input.requestId;}
 catch{input.signal.throwIfAborted();return false;}
}
