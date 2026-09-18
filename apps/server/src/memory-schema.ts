import {z} from 'zod';
import {fileIndexSchema,fileEvidenceSchema} from '@mote/shared';

const timestamp=z.string().max(64).datetime({offset:true});
export const memoryEvidenceSchema=z.object({
  id:z.string().uuid(),deviceId:z.string().max(200).optional(),sourceId:z.string().max(128).optional(),externalId:z.string().max(1000).optional(),revision:z.string().max(200).optional(),
  capturedAt:timestamp,receivedAt:timestamp,recordedAt:timestamp.optional(),occurredAt:timestamp.optional(),
  fileId:z.string().max(200).optional(),path:z.string().max(4000).optional(),uri:z.string().max(4000).optional(),
  timeBasis:z.enum(['recorded','occurred','unknown']).optional(),contentRole:z.enum(['authored','transcript','summary','reference','other']).optional(),
  offset:z.number().int().min(0).max(100000).optional(),length:z.number().int().min(0).max(100000).optional(),quote:z.string().max(12000).optional(),
  fileEvidence:fileEvidenceSchema.optional(),fileIndex:fileIndexSchema.optional(),
  contentHash:z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export const codingMemorySchema=z.object({
  kind:z.enum(['pitfall','decision','principle','preference']),scope:z.enum(['session','project','shared']),
  applicability:z.string().trim().min(1).max(2000),validation:z.enum(['observed','user_confirmed','tested','unverified']),
}).strict();
export const memoryAdmissionSchema=z.object({
  layer:z.enum(['observation','memory']),
  reason:z.string().trim().min(1).max(1200),
  scope:z.string().trim().min(1).max(600),
  attribution:z.enum(['user','third_party','observed','inferred']),
}).strict();
export const memorySchema=z.object({
  domain:z.enum(['personal','coding']).optional(),coding:codingMemorySchema.optional(),
  scopeRefs:z.array(z.object({provider:z.enum(['claude','codex','kimi']),sessionId:z.string().max(500),projectKey:z.string().max(200)}).strict()).max(30).optional(),
  admission:memoryAdmissionSchema.optional(),reviewRunId:z.string().max(200).optional(),
  id:z.string().uuid(),tier:z.enum(['episode','consolidated']).optional(),kind:z.enum(['episodic','semantic','procedural']).optional(),relatedMemoryIds:z.array(z.string().uuid()).max(50).optional(),validFrom:timestamp.optional(),validUntil:timestamp.optional(),title:z.string().max(160),statement:z.string().max(6000),uncertainty:z.string().max(2000),
  evidenceIds:z.array(z.string().uuid()).min(1).max(30),evidence:z.array(memoryEvidenceSchema).max(100).optional(),
  createdAt:timestamp,updatedAt:timestamp.optional(),status:z.enum(['proposed','published','stale']),
  staleReason:z.enum(['evidence_changed','restored_archive']).optional(),model:z.string().max(200),runId:z.string().max(200),
  skillVersion:z.string().max(200).optional(),fingerprint:z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type Memory=z.infer<typeof memorySchema>;
export type MemoryEvidence=z.infer<typeof memoryEvidenceSchema>;
export type EvidenceRange={id:string;offset:number;length:number};
