/** Explicit owner privacy rules only; never infer intent or content value. */
export interface UploadGateConfig {
  enabled: boolean;
  blockedText: string[];
  failureAction: 'drop' | 'hold' | 'allow';
}
export type GateDecision = 'allow' | 'drop' | 'hold';
export const defaultUploadGate: UploadGateConfig = { enabled: true, blockedText: [], failureAction: 'hold' };
/** Reserved integration boundary. No VLM implementation is activated in this release. */
export interface VisualReviewProvider { review(image: Uint8Array, signal: AbortSignal): Promise<'allow' | 'deny' | 'uncertain'> }
export function uploadGateConfig(value: unknown): UploadGateConfig {
  if (value === undefined) return structuredClone(defaultUploadGate);
  const v = value as UploadGateConfig;
  if (!v || typeof v.enabled !== 'boolean' || !['drop','hold','allow'].includes(v.failureAction) || !Array.isArray(v.blockedText) || v.blockedText.length > 100 || v.blockedText.some(t => typeof t !== 'string' || !t.trim() || t.length > 256)) throw Error('Invalid upload review settings');
  return {enabled:v.enabled, failureAction:v.failureAction, blockedText:[...new Set(v.blockedText)]};
}
export async function reviewUpload(config: UploadGateConfig, recognize: () => Promise<string>): Promise<GateDecision> {
  if (!config.enabled || !config.blockedText.length) return 'allow';
  try { const text = await recognize(); return config.blockedText.some(rule => text.includes(rule)) ? 'drop' : 'allow'; }
  catch { return config.failureAction; }
}
