import type {ContextReader,QueryInput} from '@mote/agent';
import type {EvidenceDependencies} from '@mote/shared';

type Lead=NonNullable<QueryInput['openingMemories']>[number];
type Scope=Pick<QueryInput,'after'|'before'|'deviceId'|'contextTime'>;

/** Use the same privacy-aware reader as model tools; never place original records in the opening prompt. */
export async function openingMemoryContext(reader:ContextReader,question:string,scope:Scope):Promise<{leads:Lead[];evidenceDependencies:EvidenceDependencies}> {
  const evidenceDependencies:EvidenceDependencies={version:1,complete:true,ids:[]};
  if(!reader.memories)return {leads:[],evidenceDependencies};
  const bounds={after:scope.after,before:scope.before,deviceId:scope.deviceId,asOf:scope.contextTime,layer:'memory' as const};
  const search=question.trim().length<=160?question.trim():'';
  const pages=await Promise.all([
    reader.memories({...bounds,status:'published',tier:'consolidated',limit:2}),
    ...(search?[reader.memories({...bounds,status:'published',query:search,limit:3})]:[]),
    reader.memories({...bounds,status:'published',limit:5}),
    reader.memories({...bounds,status:'proposed',limit:5}),
  ]);
  const candidates=pages.flatMap(page=>page.items);
  const selected:Lead[]=[],seen=new Set<string>();
  for(const candidate of candidates){
    if(selected.length===5)break;
    if(!candidate||typeof candidate!=='object')continue;
    const id=(candidate as {id?:unknown}).id;
    if(typeof id!=='string'||seen.has(id))continue;
    seen.add(id);
    const detail=(await reader.memories({...bounds,id,limit:1})).items[0];
    if(!detail||typeof detail!=='object')continue;
    const memory=detail as Record<string,unknown>;
    if(memory.status!=='published'&&memory.status!=='proposed')continue;
    if(memory.admission&&typeof memory.admission==='object'&&(memory.admission as {layer?:unknown}).layer!=='memory')continue;
    if(typeof memory.title!=='string'||typeof memory.statement!=='string'||typeof memory.createdAt!=='string')continue;
    const ids=memory.evidenceIds;
    if(!Array.isArray(ids)||!ids.length||ids.some(id=>typeof id!=='string'))evidenceDependencies.complete=false;
    else evidenceDependencies.ids.push(...ids as string[]);
    selected.push({id,title:memory.title.slice(0,160),statement:memory.statement.slice(0,700),uncertainty:typeof memory.uncertainty==='string'?memory.uncertainty.slice(0,300):'',status:memory.status,tier:memory.tier==='consolidated'?'consolidated':'episode',createdAt:memory.createdAt});
  }
  evidenceDependencies.ids=[...new Set(evidenceDependencies.ids)];
  return {leads:selected,evidenceDependencies};
}

/** Owner preview: only the public cards, without model execution. */
export async function openingMemories(reader:ContextReader,question:string,scope:Scope):Promise<Lead[]> {
  return (await openingMemoryContext(reader,question,scope)).leads;
}
