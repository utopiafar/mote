import {z} from 'zod';
import {sourceConnectionSchema,sourceIdSchema,sourceItemSchema} from './sources.js';

/** Independent coverage dimensions; counts, when known, use the same units
 * within a dimension. They do not prove the original can be opened. */
export const fileCoverageSchema=z.object({
  status:z.enum(['pending','partial','ready','failed','unsupported']),
  completed:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  total:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  reason:z.string().max(1000).optional(),
}).strict().refine(value=>(value.completed===undefined)===(value.total===undefined)&&
  (value.completed===undefined||value.completed<=value.total!)&&
  (value.completed===undefined||value.status!=='ready'||value.completed===value.total)&&
  (value.completed===undefined||value.status!=='partial'||value.completed<value.total!),
  {message:'Coverage counts must be paired and consistent with status'});
export type FileCoverage=z.infer<typeof fileCoverageSchema>;

/** Builds on the current source item and fileIndex, rather than introducing a
 * parallel file identity. Availability is a projection, not a read grant. */
export const fileViewSchema=z.object({
  captureId:z.string().uuid(),sourceId:sourceIdSchema,
  item:sourceItemSchema.refine(item=>item.kind==='file',{message:'Expected a file source item'}),
  retention:sourceConnectionSchema.shape.retention.removeDefault(),
  hasOriginal:z.boolean(),originMissing:z.boolean(),canOpenOriginal:z.boolean(),
  coverage:z.object({extraction:fileCoverageSchema,semantic:fileCoverageSchema,embedding:fileCoverageSchema}).strict(),
}).strict();
export type FileView=z.infer<typeof fileViewSchema>;
