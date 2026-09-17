import {z} from 'zod';
/** Positions are UTF-16 text offsets in the device parser's versioned output. */
export const fileIndexSchema=z.object({
 version:z.literal(1),fileId:z.string().min(1).max(200),contentVersion:z.string().regex(/^[a-f0-9]{64}$/),
 mode:z.enum(['catalog','index','archive']),coverage:z.enum(['none','full','lightweight','excerpt']),
 parser:z.string().min(1).max(100),status:z.enum(['ready','pending','unsupported']),
 totalCharacters:z.number().int().min(0).max(10000000),offset:z.number().int().min(0).max(10000000).default(0),
 length:z.number().int().min(0).max(100000),allowRead:z.boolean().default(false),
}).strict();
export type FileIndex=z.infer<typeof fileIndexSchema>;
export const fileReadRequestSchema=z.object({id:z.string().uuid(),sourceId:z.string().max(128),externalId:z.string().max(1000),revision:z.string().max(200),contentVersion:z.string().regex(/^[a-f0-9]{64}$/),offset:z.number().int().min(0).max(10000000),length:z.number().int().min(1).max(16000)}).strict();
export type FileReadRequest=z.infer<typeof fileReadRequestSchema>;
export const fileReadResultSchema=z.object({status:z.enum(['ready','version_changed','unavailable','denied']),text:z.string().max(16000).default(''),contentVersion:z.string().regex(/^[a-f0-9]{64}$/)}).strict().refine(v=>v.status==='ready'||!v.text);
