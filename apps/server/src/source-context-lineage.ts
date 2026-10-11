import {sourceContextDeclarationSchema,type SourceContextDeclaration} from '@mote/shared';
import {SourceContextStore} from './source-context.js';
import {StoreError} from './store.js';

/** Metadata reads have their own lineage; they are never synthetic captures. */
export function combineSourceContextDependencies(values:readonly (readonly SourceContextDeclaration[]|undefined)[]):SourceContextDeclaration[]{
  const result=new Map<string,SourceContextDeclaration>();
  for(const pins of values)for(const value of pins??[]){
    const pin=sourceContextDeclarationSchema.parse(value);
    result.set(JSON.stringify([pin.sourceId,pin.version,pin.fingerprint]),pin);
  }
  return [...result.values()];
}
export function sourceContextDependenciesCurrent(contexts:SourceContextStore,pins:readonly SourceContextDeclaration[]|undefined):boolean{
  try{assertSourceContextDependencies(contexts,pins);return true;}catch{return false;}
}
export function assertSourceContextDependencies(contexts:SourceContextStore,pins:readonly SourceContextDeclaration[]|undefined){
  for(const value of pins??[]){
    const pin=sourceContextDeclarationSchema.parse(value),current=contexts.identity(pin.sourceId);
    if(!current||current.version!==pin.version||current.fingerprint!==pin.fingerprint)throw Object.assign(new StoreError('Source context changed; retry with current context',409),{code:'source_context_changed'});
  }
}
