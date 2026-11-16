import type {StateStore} from '@mote/plugin-api';
import type {HostPluginContext} from '@mote/plugin-host';
import {PluginHostError} from '@mote/plugin-host';
import {serviceBindingSchema,serviceRefSchema,type PluginLifecycle,type ServiceBinding,type ServiceContract} from '@mote/plugin-api/contracts';
import type {PluginManifest} from '../plugin-release.js';
import {domainContributions,type DomainPluginFactory,type DomainPluginOptions} from './service-plugin-loader.js';
import {validatePageBridgePort} from './presentation-plugin-loader.js';

/** One adapter for the existing PluginHost lifecycle, state namespace and
 * lease resolver. Check validates publication without publishing live ports
 * or allowing state writes; enable uses the same package declarations. */
export async function createDomainPlugin(context:HostPluginContext,factory:DomainPluginFactory,manifest:PluginManifest,input:DomainPluginOptions,
 options:{publish:boolean;signal:AbortSignal;assertCurrent:()=>void;published:(binding:ServiceBinding)=>void}):Promise<PluginLifecycle>{
 const signal=AbortSignal.any([context.scope.signal,options.signal]),contributions=domainContributions(manifest),published=new Set<string>();
 const current=()=>{context.scope.assertCurrent();signal.throwIfAborted();options.assertCurrent();};
 const state=Object.freeze(Object.fromEntries((['get','list','compareAndSet','checkpoint'] as const).map(method=>[method,async(...args:unknown[])=>{
  current();if(method==='compareAndSet'&&!options.publish)throw new PluginHostError('permission_denied');
  const result=await Reflect.apply(context.state[method],context.state,args);current();return result;
 }]))) as unknown as StateStore;
 const scoped=Object.freeze({...context,scope:Object.freeze({...context.scope,signal,assertCurrent:current,
  defer:(dispose:()=>void|Promise<void>)=>{current();context.scope.defer(dispose);},retire:(dispose:()=>void|Promise<void>)=>{current();context.scope.retire(dispose);},
  run:<T>(work:(signal:AbortSignal)=>T|Promise<T>)=>context.scope.run(()=>{current();return work(signal);}).then(result=>{current();return result;}),
  every:(ms:number,work:(signal:AbortSignal)=>unknown|Promise<unknown>)=>{current();return context.scope.every(ms,()=>{current();return work(signal);});}}),state,
  services:Object.freeze({acquire:async<T>(contract:ServiceContract<T>,binding:ServiceBinding,requested?:AbortSignal)=>{current();const lease=await context.services.acquire(contract,binding,AbortSignal.any([signal,...(requested?[requested]:[])]));current();return lease;}}),
  provide:<T>(id:string,contract:ServiceContract<T>,value:T,revision=0)=>{
   current();const service=serviceRefSchema.parse(contract),contribution=contributions.find(entry=>entry.id===id),key=JSON.stringify([id,service.id]);
   if(value===undefined||!contribution?.provides?.some(port=>port.id===service.id&&port.apiVersion===service.apiVersion)||published.has(key))throw new PluginHostError('invalid_contract');
   validatePageBridgePort(manifest,id,service.id,value);
   // Staged checks use the same identity/API/revision schemas as provide(),
   // rather than accepting a descriptor that live publication would reject.
   const candidate=serviceBindingSchema.parse({service,provider:{scope:context.scope.identity,contributionId:id},revision});
   const binding=options.publish?context.provide(id,contract,value,revision):candidate;
   published.add(key);if(options.publish)options.published(binding);return binding;
  }});
 current();const lifecycle=await Reflect.apply(factory,undefined,[scoped,input]);
 // Adopt cleanup before checking cancellation or the rest of the lifecycle.
 // A factory can acquire resources before its asynchronous result arrives.
 let disposed=false;
 const dispose=async()=>{if(disposed)return;disposed=true;await lifecycle?.dispose?.();};
 context.scope.defer(dispose);
 current();if(!lifecycle||['prepare','start','quiesce','stop','dispose'].some(key=>typeof lifecycle[key as keyof PluginLifecycle]!=='function'))throw new PluginHostError('invalid_contract');
 return {async prepare(){current();await lifecycle.prepare();current();},async start(){current();await lifecycle.start();current();
   if(contributions.some(entry=>entry.provides?.some(port=>!published.has(JSON.stringify([entry.id,port.id])))))throw new PluginHostError('dependency_unavailable');
  },quiesce:reason=>lifecycle.quiesce(reason),stop:reason=>lifecycle.stop(reason),dispose};
}
