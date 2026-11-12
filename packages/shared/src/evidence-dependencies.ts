import {z} from 'zod';

/** Original capture IDs, including read-but-uncited evidence. Incomplete or
 * missing lineage requires conservative invalidation. This is not a grant. */
export const evidenceDependenciesSchema=z.object({
  version:z.literal(1),complete:z.boolean(),ids:z.array(z.string().uuid()),
}).strict();
export type EvidenceDependencies=z.infer<typeof evidenceDependenciesSchema>;
