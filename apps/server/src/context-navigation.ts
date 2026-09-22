import {z} from 'zod';
import {sourceSchema,evidenceRefId,formatEvidenceRef} from '@mote/shared';
import type {Range} from './store.js';

/** Navigation is an explicit query scope, never an authorization grant or an original. */
export const navigationScopeSchema=z.object({
  after:z.string().datetime({offset:true}).optional(),before:z.string().datetime({offset:true}).optional(),
  deviceId:z.string().max(128).optional(),appId:z.string().max(300).optional(),source:sourceSchema.optional(),
  sourceId:z.string().max(128).optional(),collection:z.enum(['content','activity']).optional(),
  projectKey:z.string().max(200).optional(),repositoryKey:z.string().regex(/^[a-f0-9]{64}$/).optional(),
  provider:z.enum(['claude','codex','kimi']).optional(),sessionId:z.string().max(500).optional(),
}).strict();
export type NavigationScope=z.infer<typeof navigationScopeSchema>;
export type NavigationExpansion={kind:'search';scope:NavigationScope;refs:string[]};
const navigation=z.object({anchor:z.string().uuid(),scope:navigationScopeSchema}).strict();
const scopeKeys=Object.keys(navigationScopeSchema.shape) as (keyof NavigationScope)[];
export const MAX_CONTEXT_REF_LENGTH=4096;

export function navigationScope(range:Range):NavigationScope {
  return navigationScopeSchema.parse(Object.fromEntries(scopeKeys.filter(key=>range[key]!==undefined).map(key=>[key,range[key]])));
}
export function navigationRef(kind:'collection'|'session',anchor:string,scope:NavigationScope):string {
  const id=evidenceRefId(anchor,'capture');if(!id)throw new Error('Invalid navigation anchor');
  const ref=`${kind}:v1:${Buffer.from(JSON.stringify(navigation.parse({anchor:id,scope}))).toString('base64url')}`;
  if(ref.length>MAX_CONTEXT_REF_LENGTH)throw new Error('Navigation reference exceeds budget');
  return ref;
}
export function parseNavigationRef(ref:string){
  if(ref.length>MAX_CONTEXT_REF_LENGTH)return;
  const match=/^(collection|session):v1:([A-Za-z0-9_-]+)$/.exec(ref);if(!match)return;
  try{
    const bytes=Buffer.from(match[2],'base64url');if(bytes.toString('base64url')!==match[2])return;
    const value=navigation.parse(JSON.parse(bytes.toString('utf8')));
    if(value.scope.after&&value.scope.before&&Date.parse(value.scope.after)>=Date.parse(value.scope.before))return;
    return {...value,kind:match[1] as 'collection'|'session',anchor:formatEvidenceRef('capture',value.anchor)};
  }catch{return;}
}
/** Intersect scopes. The reader additionally enforces filters outside the navigation protocol. */
export function intersectNavigationScope(stored:NavigationScope,request:Range):Range|undefined {
  const result={...request,...stored};
  for(const key of scopeKeys){
    const a=stored[key],b=request[key];if(a===undefined||b===undefined)continue;
    if(key==='after')result.after=Date.parse(a)>=Date.parse(b)?a:b;
    else if(key==='before')result.before=Date.parse(a)<=Date.parse(b)?a:b;
    else if(a!==b)return;
  }
  if(result.after&&result.before&&Date.parse(result.after)>=Date.parse(result.before))return;
  return result;
}
