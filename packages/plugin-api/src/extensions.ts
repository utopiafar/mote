import {serviceContract,type ContributionIdentity,type ServiceBinding,type ServiceContract,type ServiceRef} from './contracts/index.js';
import {providerCardinalities,type ProviderCardinality} from './manifest.js';

export const extensionKinds=Object.freeze([...providerCardinalities]);
export type ExtensionKind=ProviderCardinality;
/** A plugin defines its own domain interface. The host interprets cardinality
 * and identity only; it never dispatches on a domain name or business method. */
export interface ExtensionDefinition {readonly kind:ExtensionKind;readonly service:ServiceRef}
export interface ExtensionContract<T,K extends ExtensionKind=ExtensionKind> {
  readonly kind:K;
  readonly service:ServiceContract<T>;
  readonly definition:ServiceContract<ExtensionDefinition>;
}
/** One actual activated owner of an interface; this is not a persistent choice
 * or an authorization grant. Reinstallation/reactivation changes its binding. */
export interface ExtensionPoint<T,K extends ExtensionKind=ExtensionKind> {
  readonly contract:ExtensionContract<T,K>;
  readonly binding:ServiceBinding;
}
/** Names are local to the complete provider contribution identity. Two plugins
 * may both contribute "reader" without colliding or overwriting each other. */
export interface ExtensionMember {
  readonly namespace:ContributionIdentity;
  readonly name:string;
  readonly binding:ServiceBinding;
  /** Chains sort by this explicit finite integer, then complete binding identity
   * for ties. Installation order is never a priority or a fallback policy. */
  readonly order?:number;
}
export type ExtensionPublication<K extends ExtensionKind> =
  K extends 'single'?{readonly name?:never;readonly order?:never}:
  K extends 'collection'?{readonly name:string;readonly order?:never}:
  {readonly name:string;readonly order:number};

export function extensionContract<T,K extends ExtensionKind>(kind:K,id:string,apiVersion:string):ExtensionContract<T,K>{
  if(!extensionKinds.includes(kind))throw new TypeError('Invalid extension kind');
  const service=serviceContract<T>(id,apiVersion);
  // This is a public metadata port, not the implementation value. The combined
  // ID is validated by the ordinary service-contract bounds rather than truncated.
  const definition=serviceContract<ExtensionDefinition>('mote.extension.definition/'+service.id,service.apiVersion);
  return Object.freeze({kind,service,definition});
}
export const singleExtension=<T>(id:string,apiVersion:string)=>extensionContract<T,'single'>('single',id,apiVersion);
export const collectionExtension=<T>(id:string,apiVersion:string)=>extensionContract<T,'collection'>('collection',id,apiVersion);
export const chainExtension=<T>(id:string,apiVersion:string)=>extensionContract<T,'ordered'>('ordered',id,apiVersion);
