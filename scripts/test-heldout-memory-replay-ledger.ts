/** Host-only, append-only admission accounting. Never accepts semantic data. */
import {closeSync,existsSync,fsyncSync,mkdirSync,openSync,readFileSync,unlinkSync,writeSync} from 'node:fs';
import {randomUUID,createHash} from 'node:crypto';
import {join} from 'node:path';
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
export class StageSafetyError extends Error{constructor(readonly code:string){super(code);}}
const need=(ok:unknown,code:string)=>{if(!ok)throw new StageSafetyError(code);};
/** Structural phase cursor only; never source identities or arm mappings. */
export type PhaseClosure={kind:'ingress'|'extraction'|'integration'|'evaluation';wave:number;contextTime:string;archiveHeadHash:string;totalBatches:number;nextBatch:number;evaluatedPairs:number;wavePlan?:{path:string;sha256:string}};
export type LedgerEvent={index:number;at:string;previous:string;kind:string;data:Record<string,any>;sha256:string};

/** Non-mutating checkpoint inspection; a live writer or uncertain stage is not resumable. */
export function inspectAdmissionLedger(directory:string,experimentHash:string){
  need(!existsSync(join(directory,'writer.lock')),'ledger_locked_unknown_interruption');
  const bytes=readFileSync(join(directory,'admissions.ndjson'),'utf8');need(bytes.endsWith('\n'),'ledger_partial_record_unknown');const events:LedgerEvent[]=[];
  for(const line of bytes.trimEnd().split('\n')){const row=JSON.parse(line) as LedgerEvent;const {sha256,...body}=row;need(row.index===events.length&&row.previous===(events.at(-1)?.sha256??'genesis')&&sha256===hash(body),'ledger_chain_invalid');events.push(row);}
  need(events[0]?.kind==='manifest'&&events[0].data.manifestHash===experimentHash&&events[0].data.cumulativeCap===124,'ledger_manifest_mismatch');
  need(!events.some(row=>row.kind==='stop'),'ledger_persistently_stopped');const closed=new Set(events.filter(row=>row.kind==='stage-close').map(row=>row.data.stage));
  need(events.filter(row=>row.kind==='stage-open').every(row=>closed.has(row.data.stage)),'unknown_interrupted_stage');
  for(const admission of events.filter(row=>row.kind==='admit')){const terminal=events.filter(row=>row.kind==='terminal'&&row.data.callId===admission.data.callId),receipt=events.filter(row=>row.kind==='receipt'&&row.data.id===admission.data.receiptId);need(terminal.length===1&&receipt.length===1&&receipt[0].data.status!=='running','admission_receipt_unknown');need(terminal[0].data.status===receipt[0].data.status,'terminal_receipt_conflict');}
  return events;
}
/** Holding an exclusive lock for the complete stage makes check+reserve one writer operation.
 * A crash leaves that lock intentionally. No stale-lock reclamation or automatic retry. */
export class AdmissionLedger{
  readonly events:LedgerEvent[]=[];private lock:number;private file=-1;private busy=false;private stage?:string;
  constructor(readonly directory:string,readonly manifestHash:string,readonly cumulativeCap=124){
    mkdirSync(directory,{recursive:true,mode:0o700});
    try{this.lock=openSync(join(directory,'writer.lock'),'wx',0o600);}catch{throw new StageSafetyError('ledger_locked_unknown_interruption');}
    try{
      const path=join(directory,'admissions.ndjson');if(existsSync(path)){
        const bytes=readFileSync(path,'utf8');need(bytes.endsWith('\n'),'ledger_partial_record_unknown');
        for(const line of bytes.trimEnd().split('\n')){const row=JSON.parse(line) as LedgerEvent;const {sha256,...body}=row;need(row.index===this.events.length&&row.previous===(this.events.at(-1)?.sha256??'genesis')&&sha256===hash(body),'ledger_chain_invalid');this.events.push(row);}
      }
      this.file=openSync(path,'a',0o600);if(!this.events.length)this.append('manifest',{manifestHash,cumulativeCap});
      need(this.events[0].data.manifestHash===manifestHash&&this.events[0].data.cumulativeCap===cumulativeCap,'ledger_manifest_mismatch');
      const opens=this.events.filter(e=>e.kind==='stage-open'),closes=new Set(this.events.filter(e=>e.kind==='stage-close').map(e=>e.data.stage));
      if(opens.some(e=>!closes.has(e.data.stage))||this.pending().length){this.append('stop',{code:'unknown_interrupted_stage'});throw new StageSafetyError('unknown_interrupted_stage');}
      need(!this.stopped,'ledger_persistently_stopped');
    }catch(e){if(this.file!>=0)closeSync(this.file!);closeSync(this.lock!);unlinkSync(join(directory,'writer.lock'));throw e;}
  }
  private append(kind:string,data:Record<string,any>){const body={index:this.events.length,at:new Date().toISOString(),previous:this.events.at(-1)?.sha256??'genesis',kind,data};const row={...body,sha256:hash(body)};writeSync(this.file,JSON.stringify(row)+'\n');fsyncSync(this.file);this.events.push(row);return row;}
  get stopped(){return this.events.some(e=>e.kind==='stop');}
  get admitted(){return this.events.filter(e=>e.kind==='admit');}
  pending(){const done=new Set(this.events.filter(e=>e.kind==='terminal').map(e=>e.data.callId));return this.admitted.filter(e=>!done.has(e.data.callId));}
  bindExecutor(manifestHash:string,priorManifestHash?:string,offlineValidationHash?:string){const prior=this.events.filter(e=>e.kind==='executor-freeze').at(-1);if(prior?.data.manifestHash===manifestHash)return;if(prior)need(prior.data.manifestHash===priorManifestHash&&typeof offlineValidationHash==='string'&&/^[a-f0-9]{64}$/.test(offlineValidationHash),'executor_transition_not_validated');this.append('executor-freeze',{manifestHash,priorManifestHash:prior?.data.manifestHash??null,offlineValidationHash:offlineValidationHash??null});}
  begin(stage:string,parentHash:string,maxCalls:number){need(!this.stage&&!this.stopped,'stage_cannot_start');need(!this.events.some(e=>e.kind==='stage-open'&&e.data.stage===stage),'stage_already_started');this.stage=stage;this.append('stage-open',{stage,parentHash,maxCalls});}
  stop(code:string){if(!this.stopped)this.append('stop',{code});}
  reserve(logicalKey:string,inputHash:string,receiptId:string){
    try{need(this.stage&&!this.stopped,'admission_closed');need(!this.busy,'global_concurrency_exceeded');need(!this.admitted.some(e=>e.data.logicalKey===logicalKey),'outer_retry_forbidden');
      const begin=this.events.find(e=>e.kind==='stage-open'&&e.data.stage===this.stage)!;
      need(this.admitted.length<this.cumulativeCap&&this.admitted.filter(e=>e.data.stage===this.stage).length<begin.data.maxCalls,'admission_budget_exceeded');
      const callId=randomUUID();this.append('admit',{stage:this.stage,callId,logicalKey,inputHash,receiptId});this.busy=true;return callId;
    }catch(e){this.stop(e instanceof StageSafetyError?e.code:'admission_internal_failure');throw e;}
  }
  terminal(callId:string,status:'completed'|'failed',safeCode:string,counts:{modelRunStarts:number|null;repairs:number|null}){need(this.busy&&this.pending().some(e=>e.data.callId===callId),'terminal_without_admission');this.append('terminal',{callId,status,safeCode,...counts});this.busy=false;if(status==='failed')this.stop(safeCode);}
  receipts(rows:Array<{id:string;status:string;tokens?:unknown;estimatedCost?:unknown;currency?:unknown;durationMs?:number}>){
    const previous=new Set(this.events.filter(e=>e.kind==='receipt').map(e=>e.data.id));for(const row of rows){need(this.admitted.some(e=>e.data.receiptId===row.id),'receipt_without_admission');need(!previous.has(row.id),'receipt_counted_twice');this.append('receipt',row);previous.add(row.id);}
  }
  rejectedReceipts(rows:Array<Record<string,any>>){for(const row of rows){need(!this.admitted.some(e=>e.data.receiptId===row.id),'rejected_receipt_was_admitted');need(!this.events.some(e=>e.kind==='host-rejection-receipt'&&e.data.id===row.id),'rejection_receipt_duplicate');this.append('host-rejection-receipt',row);}}
  finish(snapshotHash:string,succeeded:boolean,phase?:PhaseClosure){need(this.stage&&!this.busy&&!this.pending().length,'stage_has_unknown_call');const counted=new Map(this.events.filter(e=>e.kind==='receipt').map(e=>[e.data.id,e]));need(this.admitted.every(e=>counted.has(e.data.receiptId)&&counted.get(e.data.receiptId)!.data.status!=='running'),'admission_receipt_unknown');need(this.admitted.every(e=>{const terminal=this.events.find(t=>t.kind==='terminal'&&t.data.callId===e.data.callId);return terminal?.data.status===counted.get(e.data.receiptId)!.data.status;}),'terminal_receipt_conflict');if(!succeeded)this.stop('stage_technical_failure');this.append('stage-close',{stage:this.stage,snapshotHash,succeeded,...(phase?{phase}:{})});this.stage=undefined;}
  summary(){return {admitted:this.admitted.length,completed:this.events.filter(e=>e.kind==='terminal'&&e.data.status==='completed').length,failed:this.events.filter(e=>e.kind==='terminal'&&e.data.status==='failed').length,unknown:this.pending().length,unreconciledReceipts:this.admitted.filter(a=>!this.events.some(e=>e.kind==='receipt'&&e.data.id===a.data.receiptId&&e.data.status!=='running')).length,terminalReceiptConflicts:this.admitted.filter(a=>{const t=this.events.find(e=>e.kind==='terminal'&&e.data.callId===a.data.callId),r=this.events.find(e=>e.kind==='receipt'&&e.data.id===a.data.receiptId);return t&&r&&t.data.status!==r.data.status;}).length,hostRejectedReceipts:this.events.filter(e=>e.kind==='host-rejection-receipt').length,receipts:this.events.filter(e=>e.kind==='receipt').length,failedReceipts:this.events.filter(e=>e.kind==='receipt'&&e.data.status==='failed').length,incompleteReceipts:this.events.filter(e=>e.kind==='receipt'&&(!e.data.tokens||e.data.tokens.complete!==true)).length,modelRunStarts:this.events.some(e=>e.kind==='terminal'&&e.data.modelRunStarts===null)?null:this.events.filter(e=>e.kind==='terminal').reduce((sum,e)=>sum+e.data.modelRunStarts,0),repairs:this.events.some(e=>e.kind==='terminal'&&e.data.repairs===null)?null:this.events.filter(e=>e.kind==='terminal').reduce((sum,e)=>sum+e.data.repairs,0),stopped:this.stopped,headHash:this.events.at(-1)!.sha256};}
  close(){closeSync(this.file);closeSync(this.lock);unlinkSync(join(this.directory,'writer.lock'));}
}
