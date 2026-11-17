import {z} from 'zod';
import type {EvidenceStore as Store} from './evidence-store.js';
import {installSchemaPlan} from './schema-installation.js';
import {memoryInputPlansSchemaInstallation} from './memory-input-plans-schema.js';
import {memoryRecipeBindingSchema,type MemoryStrategyRef} from './memory-strategy-contract.js';
import {materialRequirementsSchema,type MaterialInputPin} from './material-readiness.js';
import {materialSourcePinSchema} from './material-source-pin.js';

/** Host-created selection metadata. Execution state belongs to ExecutionEngine. */
export const manualMemoryInputPlanSchema=z.object({materialId:z.string().regex(/^mat_[a-f0-9]{64}$/),selectedRef:z.string().max(256),sourcePin:materialSourcePinSchema,strategy:memoryRecipeBindingSchema,required:materialRequirementsSchema,evidenceAllowList:z.array(z.string().uuid()).max(20000).optional()}).strict();
export type ManualMemoryInputPlanRequest=z.infer<typeof manualMemoryInputPlanSchema>;
export type ManualMemoryInputPlan=ManualMemoryInputPlanRequest&{id:string;jobId:string;resolvedInput?:MaterialInputPin;batchIds?:string[];coveredByBatchId?:string};
export type MemoryPlanSummary={total:number;waiting:number;blocked:number;stale:number;completed:number};
export type MemoryRecipeProgress={recipe:MemoryStrategyRef;inputs:MemoryPlanSummary;completedBatches:number;failedBatches:number;invalidatedBatches?:number;reasons:{code:string;required?:string[];materialRef?:string}[]};
export class MemoryInputPlans {
 constructor(private store:Store){installSchemaPlan(store.db,[memoryInputPlansSchemaInstallation]);}
 list(jobId:string):ManualMemoryInputPlan[]{return this.store.db.prepare('SELECT json FROM memory_input_plans WHERE job_id=? ORDER BY rowid').all(jobId).map(row=>JSON.parse(String(row.json)));}
 get(id:string):ManualMemoryInputPlan|undefined{const row=this.store.db.prepare('SELECT json FROM memory_input_plans WHERE id=?').get(id);return row?JSON.parse(String(row.json)):undefined;}
 put(plan:ManualMemoryInputPlan){const json=JSON.stringify(plan);this.store.db.prepare('INSERT INTO memory_input_plans VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(plan.id,plan.jobId,plan.materialId,json);}
}
