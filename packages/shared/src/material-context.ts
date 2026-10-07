import {z} from 'zod';

/** Owner declarations are control-plane metadata, never decoded from source prose. */
export const ownerRelationSchema=z.enum(['owner','third_party','mixed','unknown']);
export type OwnerRelation=z.infer<typeof ownerRelationSchema>;
export const attributionContextSchema=z.object({
  version:z.literal(1),ownerRelation:ownerRelationSchema,
  basis:z.enum(['owner_material','owner_source','connector','default']),
  sourceDeclaration:z.object({sourceId:z.string().min(1).max(128),version:z.number().int().positive(),ownerRelation:ownerRelationSchema.nullable()}).strict().optional(),
  /** Conflicting current Material declarations; bounded display, complete lineage digest. */
  materialDeclarations:z.object({items:z.array(z.object({materialId:z.string().regex(/^mat_[a-f0-9]{64}$/),revision:z.string().regex(/^[a-f0-9]{64}$/),ownerRelation:ownerRelationSchema}).strict()).max(32),total:z.number().int().nonnegative(),digest:z.string().regex(/^[a-f0-9]{64}$/)}).strict().optional(),
  correction:z.object({version:z.number().int().positive(),ownerRelation:ownerRelationSchema.nullable()}).strict().optional(),
}).strict();
export type AttributionContext=z.infer<typeof attributionContextSchema>;
export const unknownAttributionContext=():AttributionContext=>({version:1,ownerRelation:'unknown',basis:'default'});
