/** Fixed transport facts only. Never copy an exception message, stderr, URL or
 * provider body into a durable task or ordinary diagnostic event. */
export interface FailureDiagnostics {
  source: 'http' | 'codex' | 'process' | 'transport' | 'runtime' | 'unknown';
  errorType?: string;
  modelId?: string;
  lastTool?: string;
  code?: string;
  httpStatus?: number;
  rpcCode?: number;
  exitCode?: number;
  signal?: string;
  stage?: 'startup' | 'model' | 'tool' | 'validation' | 'cleanup';
}
const codes = new Set(['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'EPIPE', 'ENOENT', 'EACCES', 'EPERM', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'unauthorized', 'usageLimitExceeded', 'sessionBudgetExceeded', 'rateLimitExceeded', 'serverOverloaded', 'internalServerError', 'contextWindowExceeded', 'badRequest', 'cyberPolicy', 'misalignmentPolicyViolation', 'httpConnectionFailed', 'responseStreamConnectionFailed', 'responseStreamDisconnected', 'responseTooManyFailedAttempts', 'input_too_large', 'frame_limit', 'stream_limit', 'unexpected_native_tool', 'invalid_rpc', 'config_warning', 'model_mismatch', 'runtime_policy_mismatch', 'deadline_exceeded', 'request_timeout', 'unknown']);
const types = new Set(['Error', 'TypeError', 'RangeError', 'SyntaxError', 'AbortError', 'TimeoutError', 'AgentProviderError', 'AgentResponseError', 'AgentTimeoutError', 'RequestTimeoutError', 'ProviderFailure', 'unknown']);
export function sanitizeFailureDiagnostics(value: unknown): FailureDiagnostics {
  const v = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const out: FailureDiagnostics = {
    source: ['http', 'codex', 'process', 'transport', 'runtime'].includes(String(v.source)) ? v.source as FailureDiagnostics['source'] : 'unknown'
  };
  if (typeof v.modelId === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_./:@-]{0,199}$/.test(v.modelId)) out.modelId = v.modelId;
  if (['memories', 'material_catalog', 'material_read', 'timeline', 'search_context', 'evidence', 'activity', 'media_activity', 'devices', 'sources', 'source_items', 'source_history', 'file_chunks', 'attribution_context', 'read_image'].includes(String(v.lastTool))) out.lastTool = String(v.lastTool);
  if (types.has(String(v.errorType))) out.errorType = String(v.errorType);
  if (codes.has(String(v.code))) out.code = String(v.code);
  for (const key of ['httpStatus', 'rpcCode', 'exitCode'] as const) {
    const n = v[key];
    if (typeof n === 'number' && Number.isInteger(n) && (key === 'httpStatus' ? n >= 100 && n <= 599 : key === 'exitCode' ? n >= -1 && n <= 255 : n >= -32768 && n <= 32767)) out[key] = n;
  }
  if (['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGABRT', 'SIGSEGV', 'SIGBUS', 'SIGHUP', 'SIGPIPE'].includes(String(v.signal))) out.signal = String(v.signal);
  if (['startup', 'model', 'tool', 'validation', 'cleanup'].includes(String(v.stage))) out.stage = v.stage as FailureDiagnostics['stage'];
  return out;
}
export function errorDiagnostics(error: unknown): FailureDiagnostics {
  const e = error && typeof error === 'object' ? error as {
    diagnostic?: unknown;
    name?: unknown;
    code?: unknown;
    cause?: unknown;
  } : {};
  if (e.diagnostic) return sanitizeFailureDiagnostics({
    ...(e.diagnostic as object),
    errorType: (e.diagnostic as FailureDiagnostics).errorType ?? e.name
  });
  const cause = e.cause && typeof e.cause === 'object' ? e.cause as {
    code?: unknown;
  } : {};
  const code = codes.has(String(e.code)) ? String(e.code) : codes.has(String(cause.code)) ? String(cause.code) : undefined;
  return sanitizeFailureDiagnostics({
    source: code ? 'transport' : 'unknown',
    errorType: types.has(String(e.name)) ? e.name : 'unknown',
    code
  });
}
