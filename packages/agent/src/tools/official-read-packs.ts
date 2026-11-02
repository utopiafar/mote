import type {ToolDescriptor} from './descriptor.js';
import {ToolRegistry,type ToolLifecycle,type ToolSnapshot,type ResolvedTool} from './registry.js';
import {ContextToolError} from '../tool-errors.js';

/** Detached run facts for pure pack factories, never a reader or a grant. */
export interface ReadPackInputs {readonly timeZone?:string;}
export interface DerivedNavigationInputs extends ReadPackInputs {
  readonly contextTime?:string;
  /** Host-selected from the structured task, never inferred from question text. */
  readonly defaultChangesView?:'overview'|'text';
  /** Frozen arrivals used for navigation; Host still checks every actual read. */
  readonly incrementalEvidenceIds?:readonly string[];
}
export type ReadPackFactory=(input:ReadPackInputs)=>readonly ToolDescriptor[];

export interface ReadToolDispatch {
  /** The existing parent session set (or its private stage view), not a copy. */
  readonly discovered:Pick<ReadonlySet<string>,'has'>;
  /** Exact version from capability_execute; absent for a direct native call. */
  readonly catalogVersion?:string;
  /** Explicit Host task mode, never a model argument or a name allowlist. */
  readonly allowDirectCatalog?:boolean;
}

/** Resolve through the same pin for both runtime transports. Discovery does
 * not grant a read: the returned executor still checks registration lifecycle,
 * declared operations, the parent port and fresh authority before/after I/O. */
export function resolveReadTool(snapshot:ToolSnapshot,name:string,dispatch:ReadToolDispatch):ResolvedTool {
  const entry=snapshot.entries.find(entry=>entry.name===name);
  const invalid=(message:string):never=>{throw new ContextToolError('invalid_tool_arguments',message,'correct_arguments');};
  if(!entry)invalid('Unknown or unauthorized capability');
  if(dispatch.catalogVersion!==undefined){
    if(entry!.exposure!=='catalog'||!dispatch.discovered.has(entry!.name)||entry!.version!==dispatch.catalogVersion)
      invalid('Discover this exact registered capability and version first');
  }else if(entry!.exposure==='catalog'&&!dispatch.allowDirectCatalog){
    invalid('Discover this registered capability before executing it');
  }
  return snapshot.resolve(entry!);
}

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
