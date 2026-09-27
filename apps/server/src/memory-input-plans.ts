import {z} from 'zod';
import type {Store} from './store.js';
import {memoryRecipeBindingSchema,type MemoryStrategyRef} from './memory-strategy-contract.js';
import {materialRequirementsSchema,type MaterialInputPin} from './material-readiness.js';
import {materialSourcePinSchema} from './material-source-pin.js';

/** Host-created selection metadata. Execution state belongs to ExecutionEngine. */
export const manualMemoryInputPlanSchema=z.object({materialId:z.string().regex(/^mat_[a-f0-9]{64}$/),selectedRef:z.string().max(256),sourcePin:materialSourcePinSchema,strategy:memoryRecipeBindingSchema,required:materialRequirementsSchema,evidenceAllowList:z.array(z.string().uuid()).max(20000).optional()}).strict();
export type ManualMemoryInputPlanRequest=z.infer<typeof manualMemoryInputPlanSchema>;
export type ManualMemoryInputPlan=ManualMemoryInputPlanRequest&{id:string;jobId:string;resolvedInput?:MaterialInputPin;batchIds?:string[]};
export type MemoryPlanSummary={total:number;waiting:number;blocked:number;stale:number;completed:number};
export type MemoryRecipeProgress={recipe:MemoryStrategyRef;inputs:MemoryPlanSummary;completedBatches:number;failedBatches:number;reasons:{code:string;required?:string[];materialRef?:string}[]};
export class MemoryInputPlans {
 constructor(private store:Store){store.db.exec(`CREATE TABLE IF NOT EXISTS memory_input_plans(id TEXT PRIMARY KEY,job_id TEXT NOT NULL REFERENCES memory_jobs(id) ON DELETE CASCADE,material_id TEXT NOT NULL REFERENCES material_heads(id) ON DELETE CASCADE,json TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS memory_input_plans_job ON memory_input_plans(job_id);
  CREATE INDEX IF NOT EXISTS memory_input_plans_material ON memory_input_plans(material_id);`);}
 list(jobId:string):ManualMemoryInputPlan[]{return this.store.db.prepare('SELECT json FROM memory_input_plans WHERE job_id=? ORDER BY rowid').all(jobId).map(row=>JSON.parse(String(row.json)));}
 get(id:string):ManualMemoryInputPlan|undefined{const row=this.store.db.prepare('SELECT json FROM memory_input_plans WHERE id=?').get(id);return row?JSON.parse(String(row.json)):undefined;}
 put(plan:ManualMemoryInputPlan){const json=JSON.stringify(plan),prior=this.store.db.prepare('SELECT json FROM memory_input_plans WHERE id=?').get(plan.id);this.store.reserveMetadata(Math.max(0,Buffer.byteLength(json)-Buffer.byteLength(String(prior?.json??''))));this.store.db.prepare('INSERT INTO memory_input_plans VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(plan.id,plan.jobId,plan.materialId,json);}
}
