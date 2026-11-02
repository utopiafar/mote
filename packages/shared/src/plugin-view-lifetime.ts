/** View lifecycle contract: mounted/visible/suspended/disposed with activation
 * generations, per-view abort signals and subscription disposers. Hiding stops
 * new reads and polling and isolates late responses; it never cancels
 * separately authorized durable background work. Draft and return-ticket
 * identity is scoped by owner/connection/plugin-instance/view; storage
 * primitives belong to the host, draft schemas belong to plugins. */
export const viewLifecycleStates = ['mounted', 'visible', 'suspended', 'disposed'] as const;
export type ViewLifecycleState = typeof viewLifecycleStates[number];

export const draftScopes = ['owner', 'connection', 'plugin-instance', 'view'] as const;
export type DraftScope = typeof draftScopes[number];

/** A draft/return ticket is owned by exactly one scope identity; the same key
 * under another scope owner is a different draft, never shared state. */
export interface DraftTicket<T = unknown> {
  readonly scope: DraftScope;
  readonly ownerKey: string;
  readonly key: string;
  readonly value: T;
}

export type SaveOutcome = {readonly ok: true} | {readonly ok: false; readonly reason: 'save_failed'};

/** The durable side effect a suspended view may leave running. */
export interface DurableLease {readonly signal: AbortSignal; release(): void}

/** Write acknowledgement semantics: an unknown result keeps the original
 * request identity for later state reconciliation; it is never replayed. */
export type WriteAck = 'ack' | 'nack' | 'unknown';
export type WriteAckResolution = 'commit' | 'fail' | 'hold';
export function resolveWriteAck(ack: WriteAck): WriteAckResolution {
  return ack === 'ack' ? 'commit' : ack === 'nack' ? 'fail' : 'hold';
}

/** Whether a draft survives a lifecycle transition. View-scoped drafts survive
 * hide but die with the view; other scopes are partitioned by their owner and
 * survive owner switches keyed to their own owner. */
export function draftSurvivesTransition(scope: DraftScope, transition: 'suspend' | 'owner-switch' | 'dispose'): boolean {
  if (transition === 'dispose') return false;
  if (scope === 'view') return transition === 'suspend';
  return true;
}

export class ViewLifetime {
  #state: ViewLifecycleState = 'mounted';
  #generation = 0;
  #viewController = new AbortController();
  #durableController = new AbortController();
  #disposers = new Set<() => void>();

  get state(): ViewLifecycleState { return this.#state; }
  get generation(): number { return this.#generation; }
  /** Abort signal for view-scoped reads/polling; aborted on suspend/dispose. */
  get viewSignal(): AbortSignal { return this.#viewController.signal; }
  /** Abort signal for separately authorized durable work; aborts on dispose only. */
  get durableSignal(): AbortSignal { return this.#durableController.signal; }

  /** Enter visible from mounted or suspended; a new generation isolates any
   * in-flight response issued under an earlier epoch. */
  show(): void {
    if (this.#state === 'disposed') throw new TypeError('View is disposed');
    if (this.#state === 'visible') return;
    this.#generation += 1;
    this.#viewController = new AbortController();
    this.#state = 'visible';
  }

  /** Hide the view: stop new reads and cancel view-scoped work. Durable leases
   * keep running. Returns the generation that was active, for tests/callers. */
  suspend(): number {
    if (this.#state !== 'visible') return this.#generation;
    const previous = this.#generation;
    this.#generation += 1;
    this.#viewController.abort();
    this.#state = 'suspended';
    return previous;
  }

  /** A response is renderable only while visible and issued under the current
   * generation; anything earlier is stale evidence, not UI state. */
  admits(generation: number): boolean {
    return this.#state === 'visible' && generation === this.#generation;
  }

  /** Register cleanup for disposal; returns a disposer. Idempotent disposal. */
  onDispose(dispose: () => void): () => void {
    if (this.#state === 'disposed') { dispose(); return () => {}; }
    this.#disposers.add(dispose);
    return () => this.#disposers.delete(dispose);
  }

  dispose(): void {
    if (this.#state === 'disposed') return;
    this.#state = 'disposed';
    this.#generation += 1;
    this.#viewController.abort();
    this.#durableController.abort();
    const disposers = [...this.#disposers];
    this.#disposers.clear();
    for (const dispose of disposers) dispose();
  }
}
