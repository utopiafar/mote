import {sha256} from './store.js';
import {z} from 'zod';
import type {MemoryWorkMember,MemoryWorkCoverage} from './memory-work-contract.js';
import type {ModelConfiguration} from './model-configuration.js';
export type MemoryFeedbackRequest={jobId:string;batchId:string;round:number;contextTime:string;configuration?:ModelConfiguration;targets:MemoryWorkMember[];authorized:MemoryWorkMember[];coverage:MemoryWorkCoverage};
export const memoryFeedbackGroupSchema=z.object({memberKeys:z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(1).max(20),contextKeys:z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(20),instruction:z.string().min(1).max(4000)}).strict();
export type MemoryFeedbackGroup=z.infer<typeof memoryFeedbackGroupSchema>&{id:string;goal:string};
export type MemoryFeedbackPlan={workId:string;groups:MemoryFeedbackGroup[]};
export type MemoryFeedbackPlanner=(request:MemoryFeedbackRequest,signal:AbortSignal)=>Promise<MemoryFeedbackPlan>;
/** Only explicit identities and measured capacity are host decisions. */
export function validMemoryFeedbackGroup(request:MemoryFeedbackRequest,input:unknown){
 const parsed=memoryFeedbackGroupSchema.safeParse(input);if(!parsed.success)return false;
 const {memberKeys,contextKeys}=parsed.data,keys=[...memberKeys,...contextKeys];
 return new Set(keys).size===keys.length&&memberKeys.every(key=>request.targets.some(member=>member.key===key))&&contextKeys.every(key=>request.authorized.some(member=>member.key===key))&&memberKeys.reduce((sum,key)=>sum+(request.authorized.find(member=>member.key===key)?.length??Infinity),0)<=12000&&contextKeys.reduce((sum,key)=>sum+(request.authorized.find(member=>member.key===key)?.length??Infinity),0)<=12000;
}
export function validMemoryFeedbackPlan(request:MemoryFeedbackRequest,groups:MemoryFeedbackGroup[]){const keys=groups.flatMap(group=>group.memberKeys);return groups.length>0&&groups.length<=8&&groups.every(group=>validMemoryFeedbackGroup(request,{memberKeys:group.memberKeys,contextKeys:group.contextKeys,instruction:group.instruction}))&&new Set(keys).size===keys.length&&keys.length===request.targets.length&&request.targets.every(member=>keys.includes(member.key));}

export function memoryFeedbackBatchId(groupId:string){const hash=sha256(groupId);return hash.slice(0,8)+'-'+hash.slice(8,12)+'-4'+hash.slice(13,16)+'-8'+hash.slice(17,20)+'-'+hash.slice(20,32);}
