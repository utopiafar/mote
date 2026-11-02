import type {CaptureInput} from '@mote/shared';

export interface ContextRecord {
  id: string;
  capturedAt: string;
  appName: string;
  ocrText: string;
  summary?: string;
  deviceId?: string;
  sourceType?: string;
  durationMs?: number;
  /** Host-resolved declaration context; captured prose cannot create this field. */
  attributionContext?: import('@mote/shared').AttributionContext;
  [field: string]: unknown;
}

export interface ContextRange {
  after?: string;
  before?: string;
  deviceId?: string;
  limit?: number;
  cursor?: string;
  source?: CaptureInput['source'];
  appId?: string;
  collection?: 'content' | 'activity';
}

export interface ContextPage {
  items: ContextRecord[];
  nextCursor: string | null;
  /** Total records in the time/device scope, independent of the page cursor. */
  totalCount?: number;
}

export interface MediaContextRange extends ContextRange {
  appVisibility?: 'foreground' | 'background' | 'unknown';
  screenLocked?: boolean;
  playbackType?: 'local' | 'remote' | 'unknown';
}

/** Host-verified original range. The bridge projects it before model disclosure. */
export interface MemorySourceSpan {
  record: ContextRecord;
  offset: number;
  length: number;
}

export interface ContextReader {
  /** Host registry, snapshotted before each model run. */
  contextTools?(facts?:import('./tools/official-read-packs.js').DerivedNavigationInputs):readonly import('./tools/official-read-packs.js').ReadPackRegistration[];
  catalog?(args:ContextRange&{path?:string;query?:string}):Promise<unknown>;
  /** Private host lineage receipt. Recording dependencies never grants model reads. */
  materialCatalog?(args:ContextRange&{sourceId?:string;kind?:string;query?:string}):Promise<{items:{id:string;ref:string;[field:string]:unknown}[];nextCursor:string|null;disclosureDependencies?:import('@mote/shared').EvidenceDependencies}>;
  materialRead?(args:ContextRange&{ref:string;offset?:number;length?:number}):Promise<{material:{id:string;ref:string;[field:string]:unknown};text:string;textRange:{offset:number;total:number;nextOffset:number|null};spans:{memberIds:string[];[field:string]:unknown}[];originalRefs:string[];originalRefsTotal:number;originalRefsTruncated:boolean;sourceSpans?:{record:ContextRecord;offset:number;length:number}[];disclosureDependencies?:import('@mote/shared').EvidenceDependencies}>;
  segments?(args:ContextRange & {id?:string;query?:string}):Promise<{items:{members:string[];[key:string]:unknown}[];nextCursor:string|null;[key:string]:unknown}>;
  readImage?(args:import('@mote/shared').ImageReadInput):Promise<import('@mote/shared').ImageReadResult>;
  search(args: ContextRange & { query?: string }): Promise<ContextRecord[]>;
  timeline(args: ContextRange): Promise<ContextPage>;
  evidence(args: ContextRange & { ids: string[] }): Promise<ContextRecord[]>;
  activity(args: ContextRange): Promise<unknown>;
  mediaActivity?(args: MediaContextRange): Promise<unknown>;
  devices(): Promise<unknown>;
  readFileEvidence?(args:ContextRange & {id:string;offset:number;length:number}):Promise<{status:string;record?:ContextRecord;reason?:string}>;
  fileChunks?(args:ContextRange & {id:string;offset?:number}):Promise<ContextRecord[]>;
  sourceHistory?(args:ContextRange & {id:string}): Promise<ContextRecord[]>;
  sources?(args:ContextRange & {query?:string}): Promise<unknown>;
  sourceContext?(args:ContextRange & {sourceContextRef:string}):Promise<{attributionContext:import('@mote/shared').AttributionContext}>;
  sourceItems?(args:ContextRange & {sourceId?:string;kind?:string;includeDeleted?:boolean}): Promise<ContextPage>;
  memories?(args:ContextRange & {includeEvidence?:boolean;includeHistory?:boolean;asOf?:string;id?:string;query?:string;tier?:'episode'|'consolidated';layer?:'observation'|'memory';kind?:'episodic'|'semantic'|'procedural';status?:'published'|'proposed'|'stale'}): Promise<{items:unknown[];nextCursor?:string|null;evidence?:ContextRecord[];references?:{id:string;capturedAt:string;characters:number}[];sourceSpans?:MemorySourceSpan[];sourceCoverage?:{references:number;delivered:number;partial:boolean}}>;
}

