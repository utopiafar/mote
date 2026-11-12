import {z} from 'zod';

/** Fixed declarative-view compositions; this is not a layout DSL. */
export const workspaceTemplateSchema=z.enum(['project','person','travel','reading']);
export type WorkspaceTemplate=z.infer<typeof workspaceTemplateSchema>;
