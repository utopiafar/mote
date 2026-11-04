import type {CaptureRecord, SourceContextDeclaration} from '@mote/shared';
import type {Range, Store} from './store.js';
import type {MaterialPage, MaterialReadPage} from './materials.js';
import type {Memory} from './memory-schema.js';
import type {MemoryProviderKey} from './memory-provider-contract.js';
import type {MemoryStore} from './memory.js';
import type {MemoryBindings} from './memory-bindings.js';
import type {MemoryRecipeBinding} from './memory-strategy-contract.js';
import type {ManualMemoryInputPlanRequest} from './memory-input-plans.js';
import type {EvidenceExposurePolicy, EvidenceOperation} from './evidence-exposure.js';
import type {browseSourceCatalog} from './source-catalog.js';

/** Host archive reads. These are not Agent/MCP disclosure capabilities: those
 * audiences must use the ContextReader adapter and its EvidenceExposure checks. */
export interface CaptureRead {
  evidence(refs:string[], scope?:Range):CaptureRecord[];
  archivedEvidence(refs:string[], scope?:Range):CaptureRecord[];
  imageReference(ref:string, scope?:Range):(NonNullable<ReturnType<Store['imageReference']>> & {id:string;source:CaptureRecord['source']}) | undefined;
  context(records:CaptureRecord[]):CaptureRecord[];
}

/** Owner context browsing and exact expansion. Query audiences still require
 * the ContextReader adapter and its disclosure checks. */
export interface CaptureContextRead extends Pick<CaptureRead,'evidence'> {
  records(args:Range & {query?:string}, search?:boolean):{items:CaptureRecord[];more:boolean;scanned:number};
  search(args:Range & {query?:string}):Promise<CaptureRecord[] & {retrieval:{mode:string;degraded:boolean}}>;
  artifact(ref:string, scope?:Range):{id:string;ref:string;text:string;members:string[]} | undefined;
}

/** Source catalog reads do not grant capture, Material or Memory bodies. */
export interface SourceFileCatalogRead {
  fileCatalog(sourceId:string, args:Parameters<typeof browseSourceCatalog>[2]):ReturnType<typeof browseSourceCatalog>;
}

/** Formal Material reads keep their existing scoped, revision-pinned identity. */
export interface MaterialRead {
  materialCatalog(args?:Range & {sourceId?:string;kind?:string;query?:string}):MaterialPage;
  materialRead(args:Range & {ref:string;offset?:number;length?:number}):MaterialReadPage & {originalRefs:string[];originalRefsTotal:number;originalRefsTruncated:boolean};
}

export type MemoryReadSnapshot=ReturnType<MemoryBindings['retainSnapshot']>;
export type MemoryReadExposure={policy:EvidenceExposurePolicy;operation:EvidenceOperation};
export type MemoryReadQuery=Parameters<MemoryStore['page']>[0] & Range;
/** Host-only metadata receipt; it grants neither body disclosure nor extraction. */
export type MemoryCatalogMetadataReceipt={complete:boolean;members:{id:string;materialId?:string;sourceId?:string;attribution?:string}[];sourceContextDependencies:SourceContextDeclaration[]};

/** The explicit ownerArchive argument preserves owner history access. Query
 * callers retain the current-only defaults and the shared exposure policy.
 * External bodies always pass the provider/digest/current-authority checks. */
export interface MemoryRead {
  memory(ref:string, scope?:Range, ownerArchive?:boolean):Memory | undefined;
  memoryPage(args?:MemoryReadQuery, ownerArchive?:boolean):ReturnType<MemoryStore['page']>;
  memoryAsync(ref:string, scope?:Range, ownerArchive?:boolean, snapshot?:MemoryReadSnapshot, exposure?:MemoryReadExposure):Promise<Memory | undefined>;
  memoryPageAsync(args?:MemoryReadQuery, ownerArchive?:boolean, snapshot?:MemoryReadSnapshot, exposure?:MemoryReadExposure):Promise<ReturnType<MemoryStore['page']>>;
  assertMemoryReadable(cards:readonly Memory[], policy?:EvidenceExposurePolicy):void;
}

/** Retention changes provider lifetime and must remain an explicit capability. */
export interface MemoryReadSnapshots {
  readonly memoryBindings?:Pick<MemoryBindings, 'retainSnapshot'>;
  retainMemorySnapshot(context:object):MemoryReadSnapshot | undefined;
  memorySnapshot(context?:object):MemoryReadSnapshot | undefined;
  releaseMemorySnapshot(context:object):void;
}

export interface MemoryRecordHostState { status:Memory['status']; staleReason?:Memory['staleReason']; updatedAt?:string }
/** C21B record reads over the canonical stored bodies and their read-only
 * catalog projection. A record is not an evidence disclosure scope: Agent/MCP
 * audiences keep using the scoped MemoryRead port above. */
export interface MemoryRecordRead {
  memoryRecord(id:string):Memory;
  memoryRecordPage(args?:Parameters<MemoryStore['page']>[0]):ReturnType<MemoryStore['page']>;
  memoryRecordCount():number;
  memoryRecordText(id:string):string;
}
/** One immutable revision set plus the provider key, body digest and host state
 * downstream Memory publication consumes. Release is idempotent. */
export interface MemoryRecordSnapshot {
  readonly retainedAt:string;
  readonly ids:readonly string[];
  readonly records:Readonly<Record<string,Memory>>;
  readonly keys:Readonly<Record<string,MemoryProviderKey>>;
  readonly digests:Readonly<Record<string,string>>;
  readonly hostStates:Readonly<Record<string,MemoryRecordHostState>>;
  release():void;
}
export interface MemoryRecordSnapshots {
  retainMemoryRecordSnapshot(ids?:readonly string[]):MemoryRecordSnapshot;
  releaseMemoryRecordSnapshot(snapshot:MemoryRecordSnapshot):void;
}

/** Selection validates a fixed host input; it does not grant model disclosure. */
export interface MemoryInputSelection {
  memoryPlanSelection(scope:Range, bindings:readonly MemoryRecipeBinding[], policy?:EvidenceExposurePolicy, evidenceIds?:readonly string[], maximum?:number):{manualPlans:ManualMemoryInputPlanRequest[];evidenceIds:string[];unavailable:string[]};
  memorySelection(scope?:Range, maximum?:number, policy?:EvidenceExposurePolicy, requirements?:readonly (readonly string[] | undefined)[]):{evidenceIds:string[];waiting:string[];unavailable:string[]};
}

/** Canonical host lineage/currentness only. A current record is not an
 * authorization to disclose it through a model tool or external transport. */
export interface MemoryEvidenceLineage {
  readEvidence(ids:string[]):Array<CaptureRecord & {fileEvidence?:unknown}>;
  readCurrentEvidence(ids:readonly string[]):Array<CaptureRecord & {fileEvidence?:unknown}>;
  isCurrentEvidence(id:string):boolean;
  dependencyIds(id:string):string[];
}
