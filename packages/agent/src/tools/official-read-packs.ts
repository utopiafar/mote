import {createOriginalReadPack} from './packs/originals.js';
import {createAttributionPack} from './packs/attribution.js';
import {createMaterialReadPack} from './packs/materials.js';
import {createMemoryReadPack} from './packs/memories.js';
import {createDerivedNavigationPack} from './packs/derived-navigation.js';
import {createSourceReadPack} from './packs/sources.js';
import {createFileReadPack} from './packs/files.js';
import {createMeasurementReadPack} from './packs/measurements.js';
import {createOwnerMetadataPack} from './packs/owner-metadata.js';
import {createImageReadPack} from './packs/images.js';
import {createConversationHistoryPack} from './packs/conversation-history.js';
import type {ToolDescriptor} from './descriptor.js';
import {registerDefaultReadPacks,type ToolSnapshot,type ResolvedTool} from './registry.js';
import {ContextToolError} from '../tool-errors.js';

export {installReadPacks,type ReadPackRegistration} from './registry.js';

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

/** One thin composition point for official and plugin packs. Nothing here
 * reads context or authorizes a result; the caller supplies the actual Host
 * lifecycle when registering this batch in its one run registry. */
export function createOfficialReadPacks(input:DerivedNavigationInputs={}):readonly ToolDescriptor[] {
  const facts=Object.freeze({...input,...(input.incrementalEvidenceIds?{incrementalEvidenceIds:Object.freeze([...input.incrementalEvidenceIds])}:{})});
  return Object.freeze([
    ...createOriginalReadPack(facts),...createAttributionPack(facts),
    ...createMaterialReadPack(facts),...createMemoryReadPack(facts),...createDerivedNavigationPack(facts),
    ...createSourceReadPack(facts),...createFileReadPack(facts),
    ...createMeasurementReadPack(facts),...createOwnerMetadataPack(facts),...createImageReadPack(),...createConversationHistoryPack(),
  ]);
}

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

registerDefaultReadPacks(createOfficialReadPacks);
