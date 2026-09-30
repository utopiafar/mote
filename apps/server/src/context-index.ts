import {formatArtifactRef,formatEvidenceRef} from '@mote/shared';
import type {Store,Range} from './store.js';
import type {MemoryStore} from './memory.js';
import type {SourceStore} from './sources.js';
import {StoreError} from './store.js';

export const CONTEXT_DIRECTORIES=[
 {path:'/context/memory',layer:'L3/L4',description:'Selected candidate and long-term memories',expand:'memories'},
 {path:'/context/episodes',layer:'L2',description:'Bounded segments and semantic interpretations',expand:'segments'},
 {path:'/context/sources',layer:'L0/L1',description:'Original source catalog; exact or fresh evidence remains directly searchable',expand:'sources'},
] as const;

/** Virtual read-only directories. Names express storage layers, never inferred user intent. */
export function contextIndex(store:Store,memories:Pick<MemoryStore,'page'>,sources:SourceStore,args:Range&{path?:string;query?:string}={},segments:Store['archive']['page']=args=>store.archive.page(args)){
 const path=args.path??'/context',limit=Math.min(args.limit??6,12);
 if(!['/context','/context/memory','/context/episodes','/context/sources'].includes(path))throw new StoreError('Unknown context directory');
 const entries:unknown[]=[];
 // The root describes capabilities, not corpus statistics. Avoid a full-vault
 // count on the first screen; actual pages are loaded only on expansion.
 if(path==='/context'&&!args.query)return {path,entries:CONTEXT_DIRECTORIES,nextCursor:null,coverage:{scope:'directory_metadata'},next:'Search multiple layers with query, or select a path. This directory is not exhaustive evidence.'};
 let nextCursor:string|null=null;
 if(path==='/context'||path==='/context/memory'){
  const page=memories.page({...args,layer:'memory',limit});if(path==='/context/memory')nextCursor=page.nextCursor;
  for(const item of page.items)entries.push({layer:'memory',ref:formatEvidenceRef('memory',item.id),id:item.id,title:item.title,revision:item.revision,status:item.status,evidenceCount:item.evidenceCount,estimatedCharacters:6000,expand:'memories'});
 }
 if(path==='/context'||path==='/context/episodes'){
  const page=segments({...args,limit,maxCharacters:6000});if(path==='/context/episodes')nextCursor=page.nextCursor;
  for(const item of page.items)if(item)entries.push({layer:item.kind,ref:formatArtifactRef(item.id,item.revision),id:item.id,revision:item.revision,preview:item.text,firstAt:item.firstAt,lastAt:item.lastAt,deviceId:item.deviceId,coverage:item.metadata.complete===true?'bounded_complete':'partial',estimatedCharacters:item.metadata.characters??12000,expand:'segments'});
 }
 if(path==='/context/sources'){
  let after='';if(args.cursor){try{const value=JSON.parse(Buffer.from(args.cursor,'base64url').toString());if(value.path!==path||value.deviceId!==(args.deviceId??'')||typeof value.after!=='string')throw Error();after=value.after;}catch{throw new StoreError('Invalid directory cursor');}}
  const candidates=sources.listSources().filter(s=>(!args.deviceId||args.deviceId===s.deviceId)&&s.id>after).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0),page=candidates.slice(0,limit);
  for(const source of page)entries.push({layer:'source',id:source.id,title:source.name,kind:source.kind,expand:'source_items'});
  if(candidates.length>limit)nextCursor=Buffer.from(JSON.stringify({path,deviceId:args.deviceId??'',after:page.at(-1)!.id})).toString('base64url');
 }
 return {path,entries,nextCursor,coverage:{scope:'bounded_candidates',originals:'Not searched by this overview. Use search_context for exact or fresh facts; missing candidates do not establish absence.'}};
}
