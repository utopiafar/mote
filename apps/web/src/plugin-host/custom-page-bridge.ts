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
  /** The per-document key issued by the host for the exact loaded entry —
   * a replaced document never learns it, so navigation kills authority. */
  readonly documentKey: string;
  readonly instanceId: string;
  readonly generation: number;
  readonly requestId: string;
  readonly kind: 'request' | 'response' | 'event' | 'closing';
  readonly method: string;
  readonly payload?: unknown;
  readonly ok?: boolean;
  readonly error?: string;
}
const MAX_ID_CHARS = 128;
const encoder = new TextEncoder();

/** Whole-envelope wire budget: UTF-8 bytes of the JSON-encoded envelope.
 * Cyclic, BigInt or non-JSON values fail inside stringify and are refused
 * without the handler throwing. */
function measuredEnvelope(value: unknown): number {
  try { const raw = JSON.stringify(value); return raw === undefined ? -1 : encoder.encode(raw).length; }
  catch { return -1; }
}
function isJsonValue(value: unknown, depth = 0): boolean {
  if (depth > 8 || value === null) return value === null;
  if (typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') return true;
  if (Array.isArray(value)) return value.length <= 10000 && value.every(item => isJsonValue(item, depth + 1));
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype)
    return Object.values(value as object).length <= 10000 && Object.values(value as object).every(item => isJsonValue(item, depth + 1));
  return false;
}
export type BridgeInvoker = (method: string, params: unknown) => Promise<unknown>;

interface BridgeOptions {
  readonly instanceId: string;
  readonly nonce: string;
  readonly documentKey: string;
  readonly frame: Window;
  readonly generation: () => number;
  /** The real view-lifetime visibility predicate — admission and results
   * bind to it, not to the generation counter alone. */
  readonly visible: () => boolean;
  readonly declared: readonly string[];
  readonly invoke: BridgeInvoker;
  readonly post: (envelope: BridgeEnvelope) => void;
  /** Diagnostics: called with the reason for each refused envelope. */
  readonly onRejected?: (reason: string) => void;
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
    const drop = (reason: string) => { this.options.onRejected?.(reason + ':' + String((event.data as {requestId?: unknown})?.requestId)); return false; };
    const env = event.data as BridgeEnvelope;
    // A document-scoped close signal — authenticated by the issued channel
    // secret, not the message source (a pagehide may arrive with a null
    // source). Ends the channel before a replacement can use it.
    if (env && typeof env === 'object' && env.kind === 'closing' && env.documentKey === this.options.documentKey && env.nonce === this.options.nonce) {
      this.revoke(); return drop('closing');
    }
    if (event.source !== this.options.frame) return drop('foreign_source');
    if (!env || typeof env !== 'object' || env.contractVersion !== bridgeContractVersion) return drop('malformed');
    if (env.nonce !== this.options.nonce || env.documentKey !== this.options.documentKey) return drop('channel');
    if (env.instanceId !== this.options.instanceId) return drop('instance');
    if (env.generation !== this.options.generation()) return drop('generation');
    if (env.kind !== 'request') return drop('kind');
    if (this.#revoked || this.#hidden || !this.options.visible()) return drop('lifecycle');
    if (!this.options.declared.includes(env.method)) return drop('undeclared');
    if (typeof env.requestId !== 'string' || !env.requestId || env.requestId.length > MAX_ID_CHARS) return drop('requestId');
    const bytes = measuredEnvelope(env);
    if (bytes < 0 || bytes > BRIDGE_MAX_MESSAGE_BYTES) return drop('oversized');
    if (env.payload !== undefined && !isJsonValue(env.payload)) return drop('payload');
    const pendingKey = env.generation + ':' + env.requestId;
    if (this.#pending.has(pendingKey)) return drop('duplicate');
    // The total allowance renews per view generation — a long-lived page
    // keeps its budget; only in-flight concurrency is hard-bounded.
    if (env.generation !== this.#countedGeneration) { this.#total = 0; this.#countedGeneration = env.generation; }
    if (this.#total >= BRIDGE_MAX_TOTAL || this.#pending.size >= BRIDGE_MAX_PENDING) return false;
    this.#total++;
    this.#pending.set(pendingKey, {generation: env.generation});
    const fenced = () => this.options.generation() === env.generation && this.options.visible() && !this.#revoked && !this.#hidden;
    const respond = (envelope: BridgeEnvelope) => { if (fenced()) this.options.post(envelope); };
    try {
      const value = await this.options.invoke(env.method, env.payload);
      respond({contractVersion: bridgeContractVersion, nonce: this.options.nonce, documentKey: this.options.documentKey, instanceId: this.options.instanceId, generation: env.generation, requestId: env.requestId, kind: 'response', method: env.method, ok: true, payload: value});
      return true;
    } catch (error) {
      // A bounded, correlated failure — never an unhandled rejection.
      respond({contractVersion: bridgeContractVersion, nonce: this.options.nonce, documentKey: this.options.documentKey, instanceId: this.options.instanceId, generation: env.generation, requestId: env.requestId, kind: 'response', method: env.method, ok: false, error: String(error instanceof Error ? error.message : 'invoke_failed').slice(0, 256)});
      return true;
    } finally { this.#pending.delete(pendingKey); }
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
