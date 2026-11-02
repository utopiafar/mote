import type {ToolDescriptor} from './descriptor.js';
import {ToolRegistry,type ToolLifecycle} from './registry.js';

/** Detached run facts for pure pack factories, never a reader or a grant. */
export interface ReadPackInputs {readonly timeZone?:string;}
export interface DerivedNavigationInputs extends ReadPackInputs {
  readonly contextTime?:string;
  /** Frozen arrivals used for navigation; Host still checks every actual read. */
  readonly incrementalEvidenceIds?:readonly string[];
}
export type ReadPackFactory=(input:ReadPackInputs)=>readonly ToolDescriptor[];

/** Host assembly supplies an actual lifecycle for every pack. This does not
 * own/close that scope: sibling packs may share it. The registry is the sole
 * descriptor/pin authority; this object is only an acquisition batch. */
export interface ReadPackRegistration {
  readonly descriptors:readonly ToolDescriptor[];
  readonly lifecycle:Required<ToolLifecycle>;
}

/** Install a set of packs atomically into the one registry. A failed prepare
 * removes only this batch's registrations; existing or replaced siblings are
 * untouched. Descriptor execution and all receipts remain with Host session. */
export function installReadPacks(registry:ToolRegistry,packs:readonly ReadPackRegistration[]):()=>void {
  const releases:Array<()=>void>=[];
  let closed=false;
  const close=()=>{
    if(closed)return;closed=true;
    const errors:unknown[]=[];
    for(const release of releases.reverse())try{release();}catch(error){errors.push(error);}
    releases.length=0;
    if(errors.length)throw new AggregateError(errors,'Read pack registration cleanup failed');
  };
  try{
    for(const pack of packs){
      pack.lifecycle.signal.throwIfAborted();pack.lifecycle.assertCurrent();
      for(const descriptor of pack.descriptors)releases.push(registry.register(descriptor,pack.lifecycle));
      pack.lifecycle.signal.throwIfAborted();pack.lifecycle.assertCurrent();
    }
    return close;
  }catch(primary){
    try{close();}catch(cleanup){throw new AggregateError([primary,cleanup],'Read pack preparation and cleanup failed',{cause:primary});}
    throw primary;
  }
}
