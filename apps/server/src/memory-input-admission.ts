import type {MemoryEvidenceLineage} from './evidence-read-ports.js';
import type {MaterialInputPin,MaterialDependencyStatus} from './material-readiness.js';
import type {MaterialSourcePin} from './material-source-pin.js';
import type {MemoryRecipeBinding} from './memory-strategy-contract.js';
import type {ManualMemoryInputPlanRequest} from './memory-input-plans.js';
import type {AutomaticMemoryGrant} from './memory-input-authorization.js';
import {formatMaterialRef} from './materials.js';
import {StoreError,type Store} from './store.js';
import {memoryEvidenceFingerprint} from './memory.js';
import type {StatementSync} from 'node:sqlite';

export type MemoryAutomaticAuthority={id:string;automaticGrant?:AutomaticMemoryGrant;automaticGrants?:AutomaticMemoryGrant[]};
export type MemoryInputAdmissionOptions={
  materialSourceCurrent?:(pin:MaterialSourcePin,materialId:string)=>boolean;
  materialPlanAllowed?:(materialId:string,profileId?:string)=>boolean;
  deletionEvidenceAllowedForMemory?:(id:string,profileId?:string)=>boolean;
  materialInput?:(ref:string,required:readonly string[])=>(MaterialInputPin&{ready:boolean;dependencies?:MaterialDependencyStatus[]})|undefined;
  materialRequirements?:(ref:string)=>string[]|undefined;
  automaticAllowed?:(job:MemoryAutomaticAuthority)=>boolean;
  materialAllowedForMemory?:(ref:string,profileId?:string,required?:readonly string[])=>boolean;
  evidenceAllowedForMemory?:(id:string,profileId?:string)=>boolean;
};
export type MemoryReadyInputScope={strategy?:MemoryRecipeBinding;ids:string[];inputs:MaterialInputPin[];refs:Record<string,string>;planIds?:string[]};
export interface MemoryInputAdmissionPort {
  assert(ids:readonly string[],profileId?:string):void;
  assertDeletion(ids:readonly string[],profileId?:string):void;
  withCurrent<T>(ids:readonly string[],run:()=>T,profileId?:string):T;
}

/** Host input selection and currentness guards. This does not grant disclosure
 * through any model, HTTP or MCP reader; those retain their exposure policy. */
export class MemoryInputAdmission implements MemoryInputAdmissionPort {
  private materialTableStatement?:StatementSync;
  private materialRefStatement?:StatementSync;
  constructor(private store:Store,private evidence:MemoryEvidenceLineage,private options:MemoryInputAdmissionOptions={},private resolveStrategy:(strategy:MemoryRecipeBinding)=>unknown=()=>{}){}
  private formalMaterialsEnabled(){return Boolean((this.materialTableStatement??=this.store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='material_evidence'")).get());}
  rawSourceItem(id:string):boolean {
    if(!this.formalMaterialsEnabled())return false;
    const record=this.evidence.readEvidence([id])[0],sourceId=record?.provenance?.sourceId,externalId=record?.provenance?.externalId;
    if(!sourceId||!externalId||record.source==='screen'||record.source==='ui_page')return false;
    return Boolean(this.store.db.prepare('SELECT 1 FROM source_connections WHERE id=?').get(sourceId));
  }
  currentMaterialRef(id:string):string|undefined {
    if(!this.formalMaterialsEnabled())return;
    const row=(this.materialRefStatement??=this.store.db.prepare(`SELECT h.id,h.revision,h.retired FROM material_evidence e JOIN material_heads h ON h.id=e.material_id WHERE e.id=?`)).get(id) as {id:string;revision:string;retired:number}|undefined;
    return row&&!row.retired?formatMaterialRef(row.id,row.revision):undefined;
  }
  sourceCurrent(pin:MaterialSourcePin,materialId:string){return Boolean(this.options.materialSourceCurrent?.(pin,materialId));}
  planAllowed(materialId:string,profileId?:string){return Boolean(this.options.materialPlanAllowed?.(materialId,profileId));}
  evidenceAllowed(id:string,profileId?:string){return this.options.evidenceAllowedForMemory?this.options.evidenceAllowedForMemory(id,profileId):true;}
  automaticAllowed(job:MemoryAutomaticAuthority){return Boolean(this.options.automaticAllowed?.(job));}
  get hasSelection(){return Boolean(this.options.materialInput);}
  selection(ref:string,required:readonly string[]){return this.options.materialInput?.(ref,required);}
  requirements(ref:string){return this.options.materialRequirements?.(ref);}
  admit(ids:readonly string[],pinned?:Readonly<Record<string,string>>,profileId?:string,inputs:readonly MaterialInputPin[]=[],expected:readonly {id:string;fingerprint:string}[]=[]):Record<string,string> {
    const refs:Record<string,string>={},currentEvidence=new Map(this.evidence.readCurrentEvidence(ids).map(record=>[record.id,record]));
    for(const pin of expected){const record=currentEvidence.get(pin.id);if(!record||memoryEvidenceFingerprint(record)!==pin.fingerprint)throw new StoreError('Memory evidence changed',409);}
    const byEvidence=new Map<string,MaterialInputPin[]>(),checked=new Map<MaterialInputPin,{ref:string;allowed:boolean}>();
    for(const input of inputs)for(const id of input.evidenceIds){const selected=byEvidence.get(id)??[];selected.push(input);byEvidence.set(id,selected);}
    for(const id of ids){
      if(!this.evidenceAllowed(id,profileId))throw new StoreError('Memory evidence is not allowed for this model',409);
      const ref=this.currentMaterialRef(id);
      if(!ref){if(this.rawSourceItem(id))throw new StoreError('Source item Memory requires a published Material',409);if(pinned?.[id])throw new StoreError('Memory Material changed',409);continue;}
      const selections=byEvidence.get(id)??[];
      const allowed=selections.length?selections.every(input=>{
        const prior=checked.get(input);if(prior?.ref===ref)return prior.allowed;
        const current=this.selection(ref,input.required),allowed=Boolean(current?.ready&&current.materialId===input.materialId&&current.fingerprint===input.fingerprint&&this.options.materialAllowedForMemory?.(ref,profileId,input.required));
        checked.set(input,{ref,allowed});return allowed;
      }):this.options.materialAllowedForMemory?.(ref,profileId);
      if(!currentEvidence.has(id)||!allowed||pinned&&!selections.length&&pinned[id]!==ref)throw new StoreError('Memory Material dependency is not ready or changed',409);
      refs[id]=ref;
    }
    if(pinned&&Object.keys(pinned).length!==Object.keys(refs).length)throw new StoreError('Memory Material pin changed',409);
    return refs;
  }
  assert(ids:readonly string[],profileId?:string){this.admit(ids,undefined,profileId);}
  assertDeletion(ids:readonly string[],profileId?:string){
    const allowed=this.options.deletionEvidenceAllowedForMemory??this.options.evidenceAllowedForMemory;
    for(const id of ids)if(!this.evidence.readEvidence([id]).length||allowed&&!allowed(id,profileId))throw new StoreError('Memory deletion evidence is unavailable to the selected model',409);
  }
  withCurrent<T>(ids:readonly string[],run:()=>T,profileId?:string):T {
    const db=this.store.db,own=!db.isTransaction;if(own)db.exec('BEGIN IMMEDIATE');
    try{this.assert(ids,profileId);const value=run();if(own)db.exec('COMMIT');return value;}catch(error){if(own&&db.isTransaction)db.exec('ROLLBACK');throw error;}
  }
  evaluatePlan(plan:ManualMemoryInputPlanRequest,profileId?:string):{state:'ready';scope:MemoryReadyInputScope;pin:MaterialInputPin}|{state:'waiting'|'blocked'|'stale';code:string}{
    if(!this.sourceCurrent(plan.sourcePin,plan.materialId))return {state:'stale',code:'evidence_changed'};
    try{this.resolveStrategy(plan.strategy);}catch{return {state:'blocked',code:'memory_strategy_unavailable'};}
    if(!this.planAllowed(plan.materialId,profileId))return {state:'blocked',code:'memory_authorization_revoked'};
    const selection=this.selection(plan.materialId,plan.required);if(!selection)return {state:'blocked',code:'memory_input_unavailable'};
    if(!selection.ready){const deps=selection.dependencies??[];return deps.some(d=>d.state==='failed')?{state:'blocked',code:'memory_input_failed'}:deps.some(d=>d.state==='unavailable')?{state:'blocked',code:'memory_input_unavailable'}:{state:'waiting',code:'memory_input_pending'};}
    if(plan.evidenceAllowList&&selection.evidenceIds.some(id=>!plan.evidenceAllowList!.includes(id)))return {state:'blocked',code:'memory_input_outside_selection'};
    const pin:MaterialInputPin={materialId:selection.materialId,required:selection.required,fingerprint:selection.fingerprint,evidenceIds:selection.evidenceIds};
    try{const refs=this.admit(pin.evidenceIds,undefined,profileId,[pin]);return {state:'ready',pin,scope:{strategy:plan.strategy,ids:pin.evidenceIds,inputs:[pin],refs}};}catch{return {state:'blocked',code:'memory_authorization_revoked'};}
  }
}
