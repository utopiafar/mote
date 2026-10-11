import {createHash} from 'node:crypto';
import {sourceContextDeclarationSchema,type SourceContextDeclaration} from '@mote/shared';
import {StoreError,type Store,type Range} from './store.js';
import type {SourceStore} from './sources.js';

export function sourceContextRef(pin:SourceContextDeclaration){return `source-context:${Buffer.from(pin.sourceId).toString('base64url')}@${pin.version}#${pin.fingerprint}`;}
export function parseSourceContextRef(ref:string):SourceContextDeclaration|undefined {
  const match=/^source-context:([A-Za-z0-9_-]+)@([1-9][0-9]*)#([a-f0-9]{64})$/.exec(ref);if(!match)return;
  const parsed=sourceContextDeclarationSchema.safeParse({sourceId:Buffer.from(match[1],'base64url').toString('utf8'),version:Number(match[2]),fingerprint:match[3]});
  return parsed.success&&sourceContextRef(parsed.data)===ref?parsed.data:undefined;
}
/** Literal owner-metadata retrieval. It never classifies intent, identity or topics. */
export function browseSourceContexts(_store:Store,sources:SourceStore,args:Range&{query?:string}={}){
  const contexts=sources.contexts,query=args.query?.trim().toLowerCase()??'',limit=Math.min(100,Math.max(1,args.limit??12));
  const candidates=sources.listSources().filter(source=>(!args.deviceId||source.deviceId===args.deviceId)&&(!args.sourceId||source.id===args.sourceId)).sort((a,b)=>a.id.localeCompare(b.id)).map(source=>({source,context:contexts.current(source.id)}));
  const fingerprint=createHash('sha256').update(JSON.stringify({deviceId:args.deviceId,sourceId:args.sourceId,query,candidates:candidates.map(({source,context})=>[source.id,source.name,context.version,context.fingerprint])})).digest('hex');
  let after='';if(args.cursor){try{const value=JSON.parse(Buffer.from(args.cursor,'base64url').toString());if(value.fingerprint!==fingerprint||typeof value.after!=='string')throw Error();after=value.after;}catch{throw new StoreError('Source directory changed or cursor does not match this query; restart the search',409);}}
  const matches=candidates.filter(({source,context})=>source.id.localeCompare(after)>0&&(!query||source.name.toLowerCase().includes(query)||context.description.toLowerCase().includes(query))),page=matches.slice(0,limit);
  const items=page.map(({source,context})=>{
    const at=query?context.description.toLowerCase().indexOf(query):-1,start=at<0?0:Math.max(0,at-100);
    const pin=contexts.identity(source.id);
    return {id:source.id,name:source.name,kind:source.kind,deviceId:source.deviceId,retention:source.retention,enabled:source.enabled,status:source.status,
      ...(pin?{sourceContextRef:sourceContextRef(pin),sourceContext:pin,descriptionPreview:context.description.slice(start,start+300),descriptionCharacters:context.description.length}:{}),
      contextScope:'source_default_existing_and_future',citationAuthority:false};
  });
  return {items,nextCursor:matches.length>limit?Buffer.from(JSON.stringify({fingerprint,after:page.at(-1)!.source.id})).toString('base64url'):null,coverage:{scope:'source_metadata',originals:'Not searched. Browse source_items or material_catalog with this source id before making archive claims.'}};
}
