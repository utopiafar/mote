/** Custom plugin page bridge: narrow request/response RPC over a
 * MessageChannel between the host and the EXACT loaded entry document.
 * The channel port is issued once to the document that actually loaded —
 * a replaced document under the same WindowProxy never receives a port,
 * so pre-load or post-replacement requests have no carrier at all, and
 * responses are posted to the issued port (dead with the old document),
 * never to the shared contentWindow. */
export const bridgeContractVersion = '1';
export const BRIDGE_MAX_MESSAGE_BYTES = 65536;
export const BRIDGE_MAX_PENDING = 8;
export const BRIDGE_MAX_TOTAL = 256;
const MAX_ID_CHARS = 128;
const encoder = new TextEncoder();

export interface BridgeEnvelope {
  readonly contractVersion: string;
  readonly nonce: string;
  readonly documentKey: string;
  readonly instanceId: string;
  readonly generation: number;
  readonly requestId: string;
  readonly kind: 'request' | 'response' | 'event';
  readonly method: string;
  readonly payload?: unknown;
  readonly ok?: boolean;
  readonly error?: string;
}
export type BridgeInvoker = (method: string, params: unknown) => Promise<unknown>;

interface BridgeOptions {
  readonly instanceId: string;
  readonly nonce: string;
  readonly documentKey: string;
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

function measuredEnvelope(value: unknown): number {
  try { const raw = JSON.stringify(value); return raw === undefined ? -1 : encoder.encode(raw).length; }
  catch { return -1; }
}
function isJsonValue(value: unknown): boolean {
  // Iterative traversal — nesting depth is bounded by the whole-envelope
  // byte limit, not an artificial cap; total nodes stay budgeted.
  const stack = [value];
  let nodes = 0;
  while (stack.length) {
    const item = stack.pop();
    if (++nodes > 10000) return false;
    if (item === undefined) continue; // an absent optional field is not a wire value
    if (item === null || typeof item === 'boolean' || typeof item === 'string') continue;
    if (typeof item === 'number') { if (!Number.isFinite(item)) return false; continue; }
    if (Array.isArray(item)) { stack.push(...item); continue; }
    if (typeof item === 'object' && Object.getPrototypeOf(item) === Object.prototype) { stack.push(...Object.values(item as object)); continue; }
    return false;
  }
  return true;
}

/** One bound channel. Admission requires the envelope to arrive over the
 * issued MessagePort — the caller only feeds port events here — with the
 * bound nonce/documentKey/instance/generation matching. */
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

  /** One incoming envelope from the issued port. Refusals are silent
   * drops — forged channel fields, stale generations, oversized or
   * non-JSON wire values can never reach the invoker. */
  async accept(event: {data?: unknown}): Promise<boolean> {
    const drop = (reason: string) => { this.options.onRejected?.(reason + ':' + String((event.data as {requestId?: unknown})?.requestId).slice(0, MAX_ID_CHARS)); return false; };
    const env = event.data as BridgeEnvelope;
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
    // The whole actual envelope must be a JSON value — extra fields
    // carrying binary or cyclic content cannot bypass the wire limit.
    if (!isJsonValue(env)) return drop('payload');
    const pendingKey = env.generation + ':' + env.requestId;
    if (this.#pending.has(pendingKey)) return drop('duplicate');
    // The total allowance renews per view generation — a long-lived page
    // keeps its budget; only in-flight concurrency is hard-bounded.
    if (env.generation !== this.#countedGeneration) { this.#total = 0; this.#countedGeneration = env.generation; }
    if (this.#total >= BRIDGE_MAX_TOTAL || this.#pending.size >= BRIDGE_MAX_PENDING) return drop('budget');
    this.#total++;
    this.#pending.set(pendingKey, {generation: env.generation});
    const fenced = () => this.options.generation() === env.generation && this.options.visible() && !this.#revoked && !this.#hidden;
    const respond = (envelope: BridgeEnvelope) => { if (fenced()) this.options.post(envelope); };
    try {
      const value = await this.options.invoke(env.method, env.payload);
      respond({contractVersion: bridgeContractVersion, nonce: this.options.nonce, documentKey: this.options.documentKey, instanceId: this.options.instanceId, generation: env.generation, requestId: env.requestId, kind: 'response', method: env.method, ok: true, payload: value});
      return true;
    } catch {
      // A stable public failure — no internal message is transmitted.
      respond({contractVersion: bridgeContractVersion, nonce: this.options.nonce, documentKey: this.options.documentKey, instanceId: this.options.instanceId, generation: env.generation, requestId: env.requestId, kind: 'response', method: env.method, ok: false, error: 'invoke_failed'});
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
