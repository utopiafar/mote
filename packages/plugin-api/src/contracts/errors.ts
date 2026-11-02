/** Public codes, not raw exceptions/messages/paths. Domain APIs may define their own error payloads. */
export const pluginErrorCodes = [
  'invalid_contract', 'unsupported_contract_version', 'api_incompatible',
  'dependency_unavailable', 'ambiguous_binding', 'conflict', 'not_found',
  'cancelled', 'deadline_exceeded', 'permission_denied', 'revoked', 'stale_scope',
  'requires_build', 'platform_unsupported', 'waiting_device', 'not_verified', 'result_unknown', 'internal',
] as const;
export type PluginErrorCode = typeof pluginErrorCodes[number];
export interface PluginFailure {
  readonly code: PluginErrorCode;
  /** A host-issued opaque operation identity, never exception text or a credential. */
  readonly operationId?: string;
}

/** Local validation error. Only code is suitable for a public failure projection. */
export class PluginContractError extends Error {
  constructor(readonly code: 'invalid_contract' | 'unsupported_contract_version', readonly field: string) {
    super('Plugin contract validation failed');
    this.name = 'PluginContractError';
  }
}
