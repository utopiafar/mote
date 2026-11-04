import {StoreError} from '../store.js';
export type EvidenceDeletionCapability={available:boolean;kind:'capture'|'file'|null};
type Alias={virtual:boolean;captureId?:string};
/** C24 owns evidence deletion identity. Records, file archives and Material
 * aliases arrive as narrow ports; no consumer passes a Store or feature bag. */
export interface EvidenceDeletionCapturePort {
  delete(id:string,assertCurrent?:()=>void):{deleted:number};
  evidence(ids:string[]):unknown[];
}
export interface EvidenceDeletionFilePort {
  captureForEvidence(id:string):string|undefined;
  remove(id:string):{deleted:number};
}
export interface EvidenceDeletionAliasPort {
  resolve(id:string):Alias;
}
export interface EvidenceDeletionPorts {
  readonly captures:EvidenceDeletionCapturePort;
  readonly files:EvidenceDeletionFilePort;
  readonly aliases:EvidenceDeletionAliasPort;
}
export function createEvidenceDeletion(ports:EvidenceDeletionPorts):EvidenceDeletion{return new EvidenceDeletion(ports);}
const assemblyProviders=new WeakMap<object,()=>EvidenceDeletion|undefined>();
/** The publication activation registers one live deletion owner before routes
 * serve requests. Feature handlers resolve it per request, so a stopped
 * activation returns 503 instead of reusing a closed object. */
export function registerEvidenceDeletionForAssembly(store:object,provider:()=>EvidenceDeletion|undefined){assemblyProviders.set(store,provider);}
export function evidenceDeletionForAssembly(store:object):EvidenceDeletion{
  const deletion=assemblyProviders.get(store)?.();
  if(!deletion)throw new StoreError('Evidence deletion is unavailable',503);
  return deletion;
}
/** The HTTP entrypoint chooses no tables: each domain resolves and deletes its own identities. */
export class EvidenceDeletion {
  constructor(private ports:EvidenceDeletionPorts){}
  capability(id:string):EvidenceDeletionCapability{
    if(this.ports.files.captureForEvidence(id))return {available:true,kind:'file'};
    const alias=this.ports.aliases.resolve(id),available=alias.virtual?Boolean(alias.captureId):this.ports.captures.evidence([id]).length===1;
    return {available,kind:available?'capture':null};
  }
  delete(id:string){
    const file=this.ports.files.captureForEvidence(id);if(file)return this.ports.files.remove(file);
    const alias=this.ports.aliases.resolve(id);
    if(!alias.virtual)return this.ports.captures.delete(id);
    if(!alias.captureId)throw new StoreError('This reference cannot directly delete an original record',409);
    return this.ports.captures.delete(alias.captureId,()=>{
      if(this.ports.aliases.resolve(id).captureId!==alias.captureId)throw new StoreError('Original record changed; refresh before deleting',409);
    });
  }
}
