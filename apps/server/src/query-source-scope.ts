import type {ContextReader} from '@mote/agent';
import {EvidenceExposurePolicy} from './evidence-exposure.js';
import type {QueryScope} from './query-scope.js';

/** Server-owned source-list reader grant. Undefined is unrestricted; [] never
 * grants archive access. Source IDs are predicates, never an original list. */
export function querySourcePolicy(scope:QueryScope|undefined,sourceAllowed?:(id:string)=>boolean){
  const ids=scope?.sourceIds;
  return new EvidenceExposurePolicy([],ids===undefined?undefined:context=>Boolean(context.sourceId&&ids.includes(context.sourceId)&&(!sourceAllowed||sourceAllowed(context.sourceId))));
}

/** Apply the live grant before pagination, retrieval and aggregation. The
 * existing reader still checks current source, original and exposure authority.
 * No model-supplied argument can widen the host's list. */
export function sourceScopedReader(reader:ContextReader,current:()=>readonly string[]|undefined):ContextReader {
  return Object.fromEntries(Object.entries(reader).map(([name,read])=>[name,(args:object={})=>{
    const sourceIds=current();
    // Image arguments have their own strict wire schema. Their existing
    // exposure policy checks the same live source grant without a range field.
    return (read as (args:object)=>unknown)({...args,...(sourceIds===undefined||name==='readImage'?{}:{sourceIds})});
  }])) as unknown as ContextReader;
}
