import {z} from 'zod';

/** Owner declarations are control-plane metadata, never decoded from source prose. */
export const ownerRelationSchema=z.enum(['owner','third_party','mixed','unknown']);
export type OwnerRelation=z.infer<typeof ownerRelationSchema>;
/** Source-scoped exact owner prose lives in private storage; persisted evidence
 * carries only its immutable host-owned identity. Empty prose is a versioned clear. */
export const sourceContextDeclarationSchema=z.object({sourceId:z.string().min(1).max(128).regex(/^[a-zA-Z0-9_.:-]+$/),version:z.number().int().positive(),fingerprint:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export type SourceContextDeclaration=z.infer<typeof sourceContextDeclarationSchema>;
export const sourceContextSnapshotSchema=z.object({sourceId:sourceContextDeclarationSchema.shape.sourceId,version:z.number().int().nonnegative(),description:z.string().max(12000),fingerprint:sourceContextDeclarationSchema.shape.fingerprint.optional(),updatedAt:z.string().datetime({offset:true}).optional()}).strict();
export type SourceContextSnapshot=z.infer<typeof sourceContextSnapshotSchema>;
export const sourceContextUpdateSchema=z.object({expectedVersion:z.number().int().nonnegative(),description:z.string().max(12000)}).strict();
export const attributionContextSchema=z.object({
  version:z.literal(1),ownerRelation:ownerRelationSchema,
  basis:z.enum(['owner_material','owner_source','connector','default']),
  sourceDeclaration:z.object({sourceId:z.string().min(1).max(128),version:z.number().int().positive(),ownerRelation:ownerRelationSchema.nullable()}).strict().optional(),
  /** Conflicting current Material declarations; bounded display, complete lineage digest. */
  materialDeclarations:z.object({items:z.array(z.object({materialId:z.string().regex(/^mat_[a-f0-9]{64}$/),revision:z.string().regex(/^[a-f0-9]{64}$/),ownerRelation:ownerRelationSchema}).strict()).max(32),total:z.number().int().nonnegative(),digest:z.string().regex(/^[a-f0-9]{64}$/)}).strict().optional(),
  correction:z.object({version:z.number().int().positive(),ownerRelation:ownerRelationSchema.nullable()}).strict().optional(),
  /** Host-owned declaration identities are persisted; prose is opened only for authorized reads. */
  declarations:z.array(z.object({id:z.string().uuid(),version:z.number().int().positive(),fingerprint:z.string().regex(/^[a-f0-9]{64}$/)}).strict()).optional(),
  ownerStatements:z.array(z.object({id:z.string().uuid(),question:z.string().max(2000),answer:z.string().max(8000)}).strict()).optional(),
  /** Exact owner-entered import context, limited to these original captures.
   * It is separate from a reply to a Material question and does not set ownerRelation. */
  importDeclarations:z.array(z.object({id:z.string().uuid(),version:z.number().int().positive(),fingerprint:z.string().regex(/^[a-f0-9]{64}$/),captureIds:z.array(z.string().uuid()).min(1)}).strict()).optional(),
  importStatements:z.array(z.object({id:z.string().uuid(),version:z.number().int().positive(),instruction:z.string().max(12000),captureIds:z.array(z.string().uuid()).min(1)}).strict()).optional(),
  sourceContextDeclarations:z.array(sourceContextDeclarationSchema).optional(),
  sourceContextStatements:z.array(z.object({sourceId:sourceContextDeclarationSchema.shape.sourceId,version:z.number().int().positive(),description:z.string().max(12000)}).strict()).optional(),
}).strict();
export type AttributionContext=z.infer<typeof attributionContextSchema>;
export const unknownAttributionContext=():AttributionContext=>({version:1,ownerRelation:'unknown',basis:'default'});
