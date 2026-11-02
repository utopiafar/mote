import type {ContextRange,ContextReader} from '../context-contracts.js';
import type {QueryInput} from '../query-contracts.js';
import type {RuntimeToolIdentity} from '../runtime/contracts.js';

/** Finite local read operations, not an RPC method name or arbitrary reader.
 * Adding a ContextReader member does not automatically grant it to a pack. */
export type HostReadOperation=
  | 'catalog'|'search'|'timeline'|'evidence'
  | 'materialCatalog'|'materialRead'|'segments'|'memories'
  | 'sources'|'sourceItems'|'sourceHistory'|'sourceContext'
  | 'readFileEvidence'|'fileChunks'
  | 'activity'|'mediaActivity'|'devices'|'readImage';
export type HostReadArguments<K extends HostReadOperation>=Parameters<NonNullable<ContextReader[K]>>;
export type HostReadResult<K extends HostReadOperation>=Awaited<ReturnType<NonNullable<ContextReader[K]>>>;

/** Parent A08 binds one port to one selected descriptor and one staged call.
 * A pack gets no reader/store, mutable discovery state, grant table, ledger,
 * image quota/cache, sender, confirm or discard. Result IDs are untrusted;
 * only the parent's actual read/delivery lifecycle can grant citations.
 *
 * Every operation checks the same pinned descriptor is still registered and
 * the current task/scope/grants before I/O and after await, before disclosure.
 * Operation declarations describe requirements; they never grant authority.
 * A frozen snapshot does not exempt an old call from revocation/unload.
 * This port does not alter A01 HostToolPort's attempt-bound sender contract. */
export interface HostSessionPort {
  readonly tool:RuntimeToolIdentity;
  /** Effective scope for this call, normalized/clamped by Host (including limit). */
  readonly scope:Readonly<ContextRange>;
  readonly signal:AbortSignal;
  assertCurrent():void;
  read<K extends HostReadOperation>(operation:K,...args:HostReadArguments<K>):Promise<HostReadResult<K>>;
  /** Host-granted calendar comparison only. No Action execution endpoint. */
  actionCatalog(args:Parameters<NonNullable<QueryInput['actionCatalog']>>[0]):ReturnType<NonNullable<QueryInput['actionCatalog']>>;
  /** Current tool progress only; parent bounds/redacts and isolates observers. */
  progress(message:string):void;
}
