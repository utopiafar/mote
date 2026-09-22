import {z} from 'zod';
import {sourceItemSchema,type SourceItem} from '@mote/shared';
export const importRecordSchema=z.object({item:sourceItemSchema,evidencePaths:z.array(z.string().min(1).max(4000)).min(1).max(100),attachments:z.array(z.string().min(1).max(4000)).max(100).default([])}).strict();
export type PreparedRecord={item:SourceItem;evidencePaths:string[];attachments:string[]};
export const importDispositionsSchema=z.object({items:z.array(z.object({path:z.string().min(1).max(4000),status:z.enum(['parsed','attachment','container','excluded','unsupported']),reason:z.string().min(1).max(1000)}).strict()).max(4000)}).strict();
