/** Product work is a read-only projection of host receipts, never inferred from log text. */
export type WorkState='waiting'|'running'|'needs_input'|'completed'|'failed'|'cancelled'|'stale'|'excluded';
export type WorkStage='preparing'|'planning'|'searching'|'checking'|'organizing'|'saving'|'finished';
export type WorkProgress=
 | {mode:'determinate';unit:'records';total:number;completed:number;failed:number;needsInput:number;excluded:number}
 | {mode:'semantic';stage:WorkStage;returnedItems?:number;completedBranches?:number;totalBranches?:number;summary?:string};
export type WorkBranch={id:string;title:string;state:WorkState;progress?:WorkProgress;artifactIds:string[];operationId?:string;runId?:string};
export type WorkArtifact={id:string;kind:'answer'|'memory'|'import'|'insight'|'result';title:string;summary?:string;ref?:string;href?:string;count?:number};
export type WorkEvent={id:string;type:'work.started'|'plan.updated'|'branch.started'|'branch.completed'|'branch.replanned'|'artifact.created'|'work.needs_input'|'work.completed'|'work.failed'|'work.cancelled';at:string;branchId?:string;summary?:string;count?:number};
export type WorkActivity={id:string;kind:string;goal:string;state:WorkState;createdAt:string;updatedAt:string;progress:WorkProgress;branches:WorkBranch[];branchCounts?:{total:number;running:number;completed:number};branchesNextCursor?:number|null;artifacts:WorkArtifact[];evidence:{count:number;refs:string[];runId?:string};events:WorkEvent[];destination:string;technical:{operationIds:string[];runId?:string}};
export type WorkActivityPage={items:WorkActivity[];nextCursor:number|null};
/** Tool receipts count returned items, not distinct evidence actually read. */
export type WorkQueryEvent={stage:'starting'|'model'|'tool'|'validating';at:string;tool?:string;message?:string;count?:number;phase?:'started'|'completed';step?:number};
export function queryWorkProgress(events:readonly WorkQueryEvent[],completed=false):WorkProgress {
 const last=events.at(-1),reads=events.filter(event=>event.stage==='tool'&&event.phase==='completed'&&Number.isSafeInteger(event.count)&&event.count!>=0);
 const stage:WorkStage=completed?'finished':!last||last.stage==='starting'?'preparing':last.stage==='validating'?'checking':last.stage==='tool'?'searching':'organizing';
 return {mode:'semantic',stage,...(reads.length?{returnedItems:reads.reduce((sum,event)=>sum+event.count!,0)}:{}),...(last?.message?{summary:last.message}:{})};
}
