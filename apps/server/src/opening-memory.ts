import type {ContextReader,QueryInput} from '@mote/agent';
import type {EvidenceDependencies} from '@mote/shared';
import {z} from 'zod';
import {StoreError} from './evidence-store.js';

type Lead=NonNullable<QueryInput['openingMemories']>[number];
type Scope=Pick<QueryInput,'after'|'before'|'deviceId'|'contextTime'>;
const validityTime=z.string().max(64).datetime({offset:true});

/** One projection for preparation and transport revalidation. Preserve complete
 * derived claims and limits; the real model budget owns request capacity. */
export function openingMemoryLead(memory:Record<string,unknown>):Lead|undefined {
  if(typeof memory.id!=='string'||memory.status!=='published')return;
  const admission=memory.admission&&typeof memory.admission==='object'&&!Array.isArray(memory.admission)?memory.admission as Record<string,unknown>:undefined;
  if(admission&&admission.layer!=='memory')return;
  if(typeof memory.title!=='string'||typeof memory.statement!=='string'||typeof memory.createdAt!=='string')return;
  const attribution=admission?.attribution;
  const scopedAdmission=typeof admission?.scope==='string'&&admission.scope.trim()&&typeof attribution==='string'&&['user','third_party','observed','inferred'].includes(attribution)?
    {scope:admission.scope,attribution:attribution as NonNullable<Lead['admission']>['attribution']}:undefined;
  if(memory.contextPriority==='standing'&&!scopedAdmission)return;
  const validity=(field:'validFrom'|'validUntil')=>{const parsed=validityTime.safeParse(memory[field]);return parsed.success?parsed.data:undefined;};
  const validFrom=validity('validFrom'),validUntil=validity('validUntil');
  return {id:memory.id,title:memory.title,statement:memory.statement,uncertainty:typeof memory.uncertainty==='string'?memory.uncertainty:'',status:'published',tier:memory.tier==='consolidated'?'consolidated':'episode',createdAt:memory.createdAt,
    ...(memory.contextPriority==='standing'?{contextPriority:'standing'}:{}),...(scopedAdmission?{admission:scopedAdmission}:{}),...(validFrom?{validFrom}:{}),...(validUntil?{validUntil}:{})};
}

/** The same privacy-aware reader as model tools. Explicit standing context is
 * paged in full; recent/search cards are optional navigation, not importance. */
export async function openingMemoryContext(reader:Pick<ContextReader,'memories'>,question:string,scope:Scope):Promise<{leads:Lead[];evidenceDependencies:EvidenceDependencies}> {
  const evidenceDependencies:EvidenceDependencies={version:1,complete:true,ids:[]};
  if(!reader.memories)return {leads:[],evidenceDependencies};
  const bounds={after:scope.after,before:scope.before,deviceId:scope.deviceId,asOf:scope.contextTime,layer:'memory' as const,status:'published' as const};
  const selected:Lead[]=[],seen=new Set<string>();
  const add=async(candidate:unknown,standing=false)=>{
    if(!candidate||typeof candidate!=='object')return false;
    const id=(candidate as {id?:unknown}).id;
    if(typeof id!=='string'||seen.has(id))return false;
    const detail=(await reader.memories!({...bounds,id,limit:1})).items[0];
    if(!detail||typeof detail!=='object')return false;
    const memory=detail as Record<string,unknown>,lead=openingMemoryLead(memory);
    if(!lead||lead.id!==id||standing&&lead.contextPriority!=='standing')return false;
    const ids=memory.evidenceIds;
    if(!Array.isArray(ids)||!ids.length||ids.some(id=>typeof id!=='string'))evidenceDependencies.complete=false;
    else evidenceDependencies.ids.push(id,...ids as string[]);
    seen.add(id);selected.push(lead);return true;
  };
  let cursor:string|undefined;
  const cursors=new Set<string>();
  do{
    const page=await reader.memories({...bounds,contextPriority:'standing',limit:100,...(cursor?{cursor}:{})});
    for(const candidate of page.items)await add(candidate,true);
    cursor=page.nextCursor??undefined;
    if(cursor){if(cursors.has(cursor))throw new StoreError('Memory context pagination changed; retry preparation',409);cursors.add(cursor);}
  }while(cursor);
  const search=question.trim().length<=160?question.trim():'';
  const pages=await Promise.all([
    reader.memories({...bounds,tier:'consolidated',limit:2}),
    ...(search?[reader.memories({...bounds,query:search,limit:3})]:[]),
    reader.memories({...bounds,limit:5}),
  ]);
  let ordinary=0;
  for(const candidate of pages.flatMap(page=>page.items)){
    if(ordinary===5)break;
    if(await add(candidate))ordinary++;
  }
  evidenceDependencies.ids=[...new Set(evidenceDependencies.ids)];
  return {leads:selected,evidenceDependencies};
}

/** Owner preview: only the public cards, without model execution. */
export async function openingMemories(reader:Pick<ContextReader,'memories'>,question:string,scope:Scope):Promise<Lead[]> {
  return (await openingMemoryContext(reader,question,scope)).leads;
}
