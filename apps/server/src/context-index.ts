import {formatArtifactRef,formatEvidenceRef} from '@mote/shared';
import type {Store,Range} from './store.js';
import type {MemoryStore} from './memory.js';
import type {SourceStore} from './sources.js';
import {StoreError} from './store.js';

/** Virtual read-only directories. Names express storage layers, never inferred user intent. */
export function contextIndex(store:Store,memories:Pick<MemoryStore,'page'>,sources:SourceStore,args:Range&{path?:string;query?:string}={},segments:Store['archive']['page']=args=>store.archive.page(args)){
 const path=args.path??'/context',limit=Math.min(args.limit??6,12);
 if(!['/context','/context/memory','/context/episodes','/context/sources'].includes(path))throw new StoreError('Unknown context directory');
 const entries:unknown[]=[];
 if(path==='/context'&&!args.query)return {path,entries:[
  {path:'/context/memory',layer:'L3/L4',description:'Selected candidate and long-term memories',expand:'memories'},
  {path:'/context/episodes',layer:'L2',description:'Bounded segments and semantic interpretations',expand:'segments'},
  {path:'/context/sources',layer:'L0/L1',description:'Original source catalog; exact or fresh evidence remains directly searchable',expand:'sources'},
 ],coverage:store.archive.stats(),next:'Search multiple layers with query, or select a path. This directory is not exhaustive evidence.'};
 if(path==='/context'||path==='/context/memory')for(const item of memories.page({...args,limit}).items)entries.push({layer:'memory',ref:formatEvidenceRef('memory',item.id),id:item.id,title:item.title,revision:item.revision,status:item.status,evidenceCount:item.evidenceCount,estimatedCharacters:6000,expand:'memories'});
 if(path==='/context'||path==='/context/episodes')for(const item of segments({...args,limit,maxCharacters:6000}).items)if(item)entries.push({layer:item.kind,ref:formatArtifactRef(item.id,item.revision),id:item.id,revision:item.revision,preview:item.text,firstAt:item.firstAt,lastAt:item.lastAt,deviceId:item.deviceId,coverage:item.metadata.complete===true?'bounded_complete':'partial',estimatedCharacters:item.metadata.characters??12000,expand:'segments'});
 if(path==='/context/sources')for(const source of sources.listSources().filter(s=>!args.deviceId||args.deviceId===s.deviceId).slice(0,limit))entries.push({layer:'source',id:source.id,title:source.name,kind:source.kind,expand:'source_items'});
 return {path,entries,coverage:{scope:'bounded_candidates',originals:'Not searched by this overview. Use search_context for exact or fresh facts; missing candidates do not establish absence.'}};
}
