import {z} from 'zod';
import type {SourceItem} from '@mote/shared';
export type FileDisposition={path:string;status:'parsed'|'attachment'|'container'|'excluded'|'unsupported';reason:string};
type Record={item:SourceItem;evidencePaths:string[];attachments:string[]};
export type DispositionRoles=ReadonlyMap<string,FileDisposition['status']>;
export function createImportSchemas(zod:typeof z,sourceItemSchema:typeof import('@mote/shared').sourceItemSchema):{recordSchema:z.ZodType<Record>;dispositionsSchema:z.ZodType<{items:FileDisposition[]}>};
export function dispositionRoles(items:FileDisposition[],inputPaths:Iterable<string>,workspace:string,hostAttachmentPaths?:Iterable<string>):DispositionRoles;
export function validateDispositionReferences(record:Pick<Record,'evidencePaths'|'attachments'>,roles:DispositionRoles,workspace:string,line:number):void;
