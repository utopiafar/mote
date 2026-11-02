/** Custom plugin page bridge: narrow request/response RPC over postMessage
 * between the host and a sandboxed iframe. The envelope binds the channel to
 * the real contentWindow, a per-session nonce, the instance and the U02 view
 * generation — never a token, window.mote, fs or arbitrary fetch. */
export const bridgeContractVersion = '1';
export const BRIDGE_MAX_MESSAGE_BYTES = 65536;
export const BRIDGE_MAX_PENDING = 8;
export const BRIDGE_MAX_TOTAL = 256;

export interface BridgeEnvelope {
  readonly contractVersion: string;
  readonly nonce: string;
  readonly instanceId: string;
  readonly generation: number;
  readonly requestId: string;
  readonly kind: 'request' | 'response' | 'event';
  readonly method: string;
  readonly payload?: unknown;
}
export type BridgeInvoker = (method: string, params: unknown) => Promise<unknown>;

interface BridgeOptions {
  readonly instanceId: string;
  readonly nonce: string;
  readonly frame: Window;
  readonly generation: () => number;
  /** The real view-lifetime visibility predicate — admission and results
   * bind to it, not to the generation counter alone. */
  readonly visible: () => boolean;
  readonly declared: readonly string[];
  readonly invoke: BridgeInvoker;
  readonly post: (envelope: BridgeEnvelope) => void;
}

/** One bound channel. Admission is by the real contentWindow + nonce +
 * instance + generation; hide() refuses new reads, revoke() tears the whole
 * bridge down and a stale channel can never fire again. */
export class CustomPageBridge {
  readonly options: BridgeOptions;
  #pending = new Map<string, {generation: number}>();
  #total = 0;
  #countedGeneration = -1;
  #revoked = false;
  #hidden = false;

  constructor(options: BridgeOptions) {
    this.options = options;
    if (!options.declared.length) throw new Error('bridge requires at least one declared method');
  }

  /** One incoming envelope. Rejections are silent drops — a foreign frame,
   * a forged nonce, a guessed instance or an oversized request can never
   * reach the invoker. */
  async accept(event: MessageEvent<unknown>): Promise<boolean> {
    if (event.source !== this.options.frame) return false;
    const env = event.data as BridgeEnvelope;
    if (!env || typeof env !== 'object' || env.contractVersion !== bridgeContractVersion) return false;
    if (env.nonce !== this.options.nonce || env.instanceId !== this.options.instanceId) return false;
    if (env.generation !== this.options.generation()) return false;
    if (env.kind !== 'request') return false;
    if (this.#revoked || this.#hidden || !this.options.visible()) return false;
    if (!this.options.declared.includes(env.method)) return false;
    if (this.#pending.has(env.requestId)) return false;
    // The total allowance renews per view generation — a long-lived page
    // keeps its budget; only in-flight concurrency is hard-bounded.
    if (env.generation !== this.#countedGeneration) { this.#total = 0; this.#countedGeneration = env.generation; }
    if (this.#total >= BRIDGE_MAX_TOTAL || this.#pending.size >= BRIDGE_MAX_PENDING) return false;
    if (env.payload !== undefined && JSON.stringify(env.payload).length > BRIDGE_MAX_MESSAGE_BYTES) return false;
    this.#total++;
    this.#pending.set(env.requestId, {generation: env.generation});
    try {
      const value = await this.options.invoke(env.method, env.payload);
      // A result only lands while the issuing generation is still current
      // and the view is still visible.
      if (this.options.generation() === env.generation && this.options.visible() && !this.#revoked && !this.#hidden)
        this.options.post({contractVersion: bridgeContractVersion, nonce: this.options.nonce, instanceId: this.options.instanceId, generation: env.generation, requestId: env.requestId, kind: 'response', method: env.method, payload: value});
      return true;
    } finally { this.#pending.delete(env.requestId); }
  }

  hide() { this.#hidden = true; }
  show() { this.#hidden = false; }
  revoke() { this.#revoked = true; this.#pending.clear(); }

  /** Host-acknowledged checkpoint only — values the page wrote are stored
   * under the issuing generation and replayed only while it is current. */
  static checkpoint(id: string, payload: unknown): {id: string; payload: unknown} {
    if (id.length > 128 || JSON.stringify(payload ?? null).length > BRIDGE_MAX_MESSAGE_BYTES) throw new Error('checkpoint out of budget');
    return {id, payload};
  }
}
