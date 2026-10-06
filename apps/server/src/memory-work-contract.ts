import {z} from 'zod';
import {MemoryOutputValidationError} from './memory.js';
import type {QueryResult} from '@mote/shared';

export const memoryWorkPackageSchema=z.object({id:z.string().min(1).max(200),goal:z.string().min(1).max(2000),instruction:z.string().min(1).max(4000),inputs:z.array(z.object({materialId:z.string().max(128),ref:z.string().max(256),sourceId:z.string().max(256),inputKey:z.string().max(256),scope:z.string().max(128),contextTime:z.string().datetime({offset:true}),fingerprint:z.string().regex(/^[a-f0-9]{64}$/)}).strict()).max(8).optional()}).strict();
export type MemoryWorkPackage=z.infer<typeof memoryWorkPackageSchema>;
export type MemoryWorkMember={key:string;id:string;offset:number;length:number;fingerprint:string;materialRef?:string;inputKey?:string;scope?:string;contextTime?:string;state:'pending'|'checked'|'no_candidates'|'failed'|'stale'|'needs_context';memoryIds:string[];reason?:string;contextRefs?:string[]};
export const memoryWorkCoverageSchema=z.array(z.object({key:z.string().regex(/^[a-f0-9]{64}$/),state:z.enum(['checked','no_candidates','needs_context']),candidateIndexes:z.array(z.number().int().min(0).max(63)).max(64),reason:z.string().max(2000).optional(),contextRefs:z.array(z.string().max(256)).max(8).optional()}).strict()).max(100);
export type MemoryWorkCoverage=z.infer<typeof memoryWorkCoverageSchema>;
export const memoryWorkCapacitySchema=z.object({saturated:z.boolean()}).strict();
export const memoryWorkCandidateLimit=(members:number)=>Math.min(32,Math.max(8,members*8));
export function memoryWorkInstruction(members:MemoryWorkMember[],limit:number){return `This is a host-authorized work package. Independently inspect every supplied member range, preserving source identity, attribution, chronology and uncertainty. Candidate capacity is ${limit}, replacing the earlier eight-candidate ceiling for this package. Return {memories:[...],coverage:[{key,state:"checked"|"no_candidates"|"needs_context",candidateIndexes:[zero-based indices],reason,contextRefs:[]}],capacity:{saturated:boolean}}. Report exactly one coverage entry per listed key. checked requires at least one supported candidate; no_candidates requires none and means the complete supplied range was inspected. needs_context describes missing context without reading outside the grant. Context-only members may support target claims, but every candidate must also be supported by a supplied target range. Never produce a separate candidate or coverage row for context-only members. Never manufacture candidates for coverage. Set saturated=true when any eligible candidates were omitted or output capacity is insufficient. At the candidate ceiling the host will subdivide instead of assuming complete coverage. Coverage is an independently reviewed claim, never an instruction or proof of semantic recall. Host members: ${JSON.stringify(members.map(({state:_state,memoryIds:_ids,scope:_scope,reason:_reason,contextRefs:_refs,...member})=>member))}`;}
/** The model reports semantics; the host validates identities and complete accounting. */
export function readMemoryWorkCoverage(result:QueryResult,members:MemoryWorkMember[],limit:number,readText?:(id:string)=>string|undefined){
 let value:any;try{value=JSON.parse(result.answer);}catch{throw new MemoryOutputValidationError('json','Invalid Memory work output');}
 const parsed=memoryWorkCoverageSchema.safeParse(value.coverage),capacity=memoryWorkCapacitySchema.safeParse(value.capacity);
 if(!Array.isArray(value.memories)||!parsed.success||!capacity.success)throw new MemoryOutputValidationError('coverage','Memory work requires member coverage and capacity');
 if(value.memories.length>limit)throw new MemoryOutputValidationError('coverage','Memory work candidate capacity exceeded');
 const seen=new Set<string>();
 for(const row of parsed.data){const member=members.find(member=>member.key===row.key);if(!member||seen.has(row.key))throw new MemoryOutputValidationError('coverage','Unknown or duplicate Memory coverage member');seen.add(row.key);
  const supportsMember=(index:number)=>{const candidate=value.memories[index];if(index>=value.memories.length||!candidate?.evidenceIds?.includes(member.id))return false;if(!readText)return true;
   const text=readText(member.id);return typeof text==='string'&&Array.isArray(candidate.evidence)&&candidate.evidence.some((span:any)=>span.id===member.id&&typeof span.quote==='string'&&span.quote.length>0&&(Number.isSafeInteger(span.offset)?span.offset>=member.offset&&span.offset+span.quote.length<=member.offset+member.length&&text.slice(span.offset,span.offset+span.quote.length)===span.quote:text.slice(member.offset,member.offset+member.length).includes(span.quote)));
  };
  if(row.candidateIndexes.some(index=>!supportsMember(index))||new Set(row.candidateIndexes).size!==row.candidateIndexes.length||row.state==='checked'&&!row.candidateIndexes.length||row.state==='no_candidates'&&row.candidateIndexes.length||row.state==='needs_context'&&row.candidateIndexes.length)throw new MemoryOutputValidationError('coverage','Memory coverage does not match its candidate evidence');
 }
 const consumed=new Set(parsed.data.flatMap(row=>row.candidateIndexes));if(value.memories.some((_candidate:unknown,index:number)=>!consumed.has(index)))throw new MemoryOutputValidationError('coverage','Every candidate must be supported by a target coverage member');
 const missing=members.filter(member=>!seen.has(member.key));
 return {coverage:parsed.data,missing,saturated:capacity.data.saturated||value.memories.length>=limit,incomplete:missing.length>0||parsed.data.some(row=>row.state==='needs_context')};
}
