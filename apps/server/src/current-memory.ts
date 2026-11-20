import {formatEvidenceRef,queryScopeSchema,type QueryScope} from '@mote/shared';
import {z} from 'zod';
import type {MemoryRead} from './evidence-read-ports.js';
import type {MemoryStore} from './memory.js';

/** Read-only entry for chat and assistant consumers. Current pages use the
 * shared reader's retirement filter, source scope and disclosure checks. */
export async function readCurrentMemoryPage(reader:Pick<MemoryRead,'memoryPageAsync'>,rawScope:QueryScope,options:Pick<NonNullable<Parameters<MemoryStore['page']>[0]>,'id'|'query'|'contextPriority'|'tier'|'kind'|'layer'|'asOf'|'cursor'|'limit'|'level'>={}){
 const scope=queryScopeSchema.parse(rawScope);
 const limit=z.number().int().min(1).max(100).default(20).parse(options.limit);
 const {kind,...bounds}=scope;
 if(scope.evidenceIds?.length===0||kind==='selection'&&scope.sourceIds?.length===0)return {items:[],nextCursor:null};
 return reader.memoryPageAsync({
  ...bounds,...options,limit,status:'published',layer:options.layer??'memory',includeHistory:false,includeStale:false,
  ...(options.id?{id:formatEvidenceRef('memory',z.string().uuid().parse(options.id))}:{}),
  ...(kind==='selection'&&scope.sourceIds!==undefined?{sourceIds:scope.sourceIds}:{}),
 },false);
}
