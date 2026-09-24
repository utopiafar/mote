import {z} from 'zod';

export const importStatusSchema=z.enum(['queued','preparing','awaiting_confirmation','importing','completed','failed','needs_configuration','unsupported']);
export type ImportStatus=z.infer<typeof importStatusSchema>;
export type ArchivedFile={id:string;hash:string;name:string;relativePath:string;mimeType:string;sizeBytes:number;createdAt:string};
export type ImportPreview={count:number;samples:{title:string;text:string;kind:string;attachmentCount:number}[]};
export type ImportDispositionStatus='parsed'|'attachment'|'container'|'excluded'|'unsupported';
export type ImportDispositions={counts:Record<ImportDispositionStatus,number>;items:{fileId:string;path:string;status:ImportDispositionStatus;reason:string}[]};
export const importReviewDecisionSchema=z.object({confidence:z.enum(['high','low','unknown']),ambiguous:z.boolean(),reason:z.string().min(1).max(1000).optional()}).strict();
export type ImportReviewDecision=z.infer<typeof importReviewDecisionSchema>;
export type ImportReviewGate={decision:'automatic'|'confirmation';reason:string};
export type ImportJob={
  id:string;operationId?:string;execution?:import('./execution.js').ExecutionEnvelope;name:string;instruction:string;sourceId:string;sourcePackId?:string;status:ImportStatus;
  processingStatus:'archived'|'analyzing'|'preview_ready'|'saving'|'saved'|'blocked';
  createdAt:string;updatedAt:string;files:ArchivedFile[];summary:string;warnings:string[];
  archive:{files:number;bytes:number;expandedFiles:number};
  progress:{total:number;processed:number;imported:number;duplicates:number};
  preview?:ImportPreview;dispositions?:ImportDispositions;reviewDecision?:ImportReviewDecision;reviewGate?:ImportReviewGate;error?:string;captureIds:string[];memoryJobId?:string;
};
export const importRequestSchema=z.object({
  requestId:z.string().uuid().optional(),
  name:z.string().trim().min(1).max(200).optional(),
  processing:z.enum(['automatic','preview']).default('preview'),
  sourcePackId:z.string().regex(/^[a-z][a-z0-9.-]{2,127}$/).optional(),
  instruction:z.string().max(12000).default(''),
  files:z.array(z.object({name:z.string().min(1).max(1000),mimeType:z.string().max(200).optional(),dataBase64:z.string().max(90_000_000)}).strict()).min(1).max(2000).optional(),
  archivedFileIds:z.array(z.string().uuid()).min(1).max(2000).optional(),
  directory:z.string().min(1).max(4000).optional(),
}).strict().refine(value=>[value.files,value.directory,value.archivedFileIds].filter(Boolean).length===1,{message:'Choose uploaded files or a server directory'});
export type ImportRequest=z.infer<typeof importRequestSchema>;
