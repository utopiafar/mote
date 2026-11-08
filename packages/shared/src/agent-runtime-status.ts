import {z} from 'zod';

/** Public agent-runtime settings/status receipt (AGR04), shared by Web, Mac
 * and Android. The serialized shape carries safe facts only: identifiers,
 * counters, configured-state booleans and the redacted configuration view —
 * never credentials, launch values or filesystem paths to runtime artifacts.
 * Strict objects fail closed on secret- or path-shaped fields; display
 * identifiers stay bounded strings so an unknown runtime provider or
 * capability renders instead of failing the whole receipt. */
const identifier = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const text = (min: number, max: number) => z.string().min(min).max(max);
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const source = z.enum(['file']);
const domainStatus = z.enum(['applied', 'restart-required', 'invalid']);

/** A model settings view minus credentials: secret material appears only as
 * configured-state booleans. Provider, protocol and effort stay displayable
 * strings so a newer preset still parses on an older client. */
const settings = z.object({
  provider: text(1, 128), protocol: text(1, 64), baseUrl: text(0, 4096), model: text(0, 512),
  reasoningEffort: text(1, 64), serviceTier: text(1, 64).optional(),
  maxTokens: z.number().int().min(1).max(1_000_000),
  modelRequestTimeoutMs: z.number().int().min(1).nullable(),
  agentTimeoutMs: z.number().int().min(1).nullable(),
  allowUnauthenticatedLocal: z.boolean(),
  apiKeyConfigured: z.boolean(), headersConfigured: z.boolean(), extraBodyConfigured: z.boolean(),
}).strict();
const profile = z.object({id: identifier, name: text(1, 100), settings,
  readOnly: z.boolean().optional(), source: source.optional()}).strict();
const saved = z.object({
  version: z.literal(1), revision, source,
  settings, profiles: z.array(profile),
  defaults: z.record(identifier, identifier), defaultModels: z.record(identifier, text(0, 512)),
}).strict();
export const agentRuntimeFeatureSelectionSchema = z.object({
  profileId: identifier, provider: text(1, 128), model: text(0, 512), configured: z.boolean(),
}).strict();
export type AgentRuntimeFeatureSelection = z.infer<typeof agentRuntimeFeatureSelectionSchema>;
const status = z.object({
  closed: z.boolean(), configured: z.boolean(), generation: count, activeRuns: count,
  retiringGenerations: count, releasedGenerations: count, preparedGenerations: count, closeErrors: count,
  lastCloseError: z.object({name: text(1, 200), code: text(1, 200).optional()}).strict().optional(),
  preparedAgents: count, pendingPreparations: count, pendingCleanupFailures: count, shuttingDown: z.boolean(),
}).strict();
const field = z.object({path: text(1, 500), label: text(1, 200).optional(), description: text(0, 2000).optional(),
  sensitive: z.boolean().optional(),
  effect: z.enum(['immediate', 'next-request', 'next-admission', 'restart', 'migration']).optional()}).strict();
const domain = z.object({id: identifier, saved: z.unknown(), effective: z.unknown(), fields: z.array(field),
  status: domainStatus, error: text(1, 200).optional()}).strict();
const configuration = z.object({
  version: z.literal(1), revision, configFile: text(0, 4096),
  domains: z.array(domain),
  lastError: z.object({code: text(1, 200), domain: identifier.optional()}).strict().nullable(),
  domain: domain.optional(),
}).strict();

export const agentRuntimeStatusReceiptSchema = z.object({
  revision, saved,
  features: z.record(identifier, agentRuntimeFeatureSelectionSchema),
  runtime: status,
  configuration,
}).strict();
export type AgentRuntimeStatusReceipt = z.infer<typeof agentRuntimeStatusReceiptSchema>;

export type AgentRuntimeReadiness = 'closed' | 'failed' | 'unconfigured' | 'restart-pending' | 'ready';
/** One deterministic readiness projection shared by every client. 'ready' is
 * possible only when the published generation actually reports configured and
 * the models domain applied; missing or rejected state never projects ready. */
export function agentRuntimeReadiness(receipt: AgentRuntimeStatusReceipt): AgentRuntimeReadiness {
  const domain = receipt.configuration.domain ?? receipt.configuration.domains.find(value => value.id === 'models');
  const lastError = receipt.configuration.lastError;
  if (receipt.runtime.closed || receipt.runtime.shuttingDown) return 'closed';
  if (!domain || domain.status === 'invalid' || (lastError && (!lastError.domain || lastError.domain === 'models'))) return 'failed';
  if (!receipt.runtime.configured) return 'unconfigured';
  if (domain?.status === 'restart-required') return 'restart-pending';
  return 'ready';
}
export type AgentRuntimeFeatureState = 'unknown' | 'unconfigured' | 'ready';
/** Per-capability display state: a missing selection is unknown, never ready. */
export function agentRuntimeFeatureState(receipt: AgentRuntimeStatusReceipt, capability: string): AgentRuntimeFeatureState {
  const selected = receipt.features[capability];
  if (!selected) return 'unknown';
  return selected.configured ? 'ready' : 'unconfigured';
}
