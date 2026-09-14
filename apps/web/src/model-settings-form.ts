import type {ModelSettingsPublic, ModelSettingsView, ModelSettingsUpdate} from '@mote/shared/models';
/** Only a status is returned for existing credentials; new values stay in page memory. */
export type CredentialAction = 'keep' | 'replace' | 'clear';
export interface ModelSettingsDraft {
  provider: string;
  protocol: ModelSettingsPublic['protocol'];
  baseUrl: string;
  model: string;
  reasoningEffort: ModelSettingsPublic['reasoningEffort'];
  maxTokens: string;
  timeoutSeconds: string;
  allowUnauthenticatedLocal: boolean;
  apiKeyAction: CredentialAction;
  apiKey: string;
  headersAction: CredentialAction;
  headers: string;
  extraBodyAction: CredentialAction;
  extraBody: string;
  allowCredentialReuse: boolean;
}
export function createModelDraft(settings: ModelSettingsPublic): ModelSettingsDraft {
  return {
    provider: settings.provider,
    protocol: settings.protocol,
    baseUrl: settings.baseUrl,
    model: settings.model,
    reasoningEffort: settings.reasoningEffort,
    maxTokens: String(settings.maxTokens),
    timeoutSeconds: String(settings.timeoutMs / 1000),
    allowUnauthenticatedLocal: settings.allowUnauthenticatedLocal,
    apiKeyAction: 'keep', apiKey: '', headersAction: 'keep', headers: '',
    extraBodyAction: 'keep', extraBody: '',
    allowCredentialReuse: false,
  };
}
export function modelDraftChanged(draft: ModelSettingsDraft, settings: ModelSettingsPublic): boolean {
  return JSON.stringify(draft) !== JSON.stringify(createModelDraft(settings));
}
export function changedCredentialDestination(draft: ModelSettingsDraft, settings: ModelSettingsPublic): boolean {
  return draft.provider !== settings.provider || draft.protocol !== settings.protocol || draft.baseUrl.trim() !== settings.baseUrl;
}
export function retainedCredentialsNeedConfirmation(draft: ModelSettingsDraft, settings: ModelSettingsPublic): boolean {
  return changedCredentialDestination(draft, settings) &&
    ((settings.apiKeyConfigured && draft.apiKeyAction === 'keep') || (settings.headersConfigured && draft.headersAction === 'keep') || (settings.extraBodyConfigured && draft.extraBodyAction === 'keep'));
}
function objectJson(value: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = value.trim() ? JSON.parse(value) : {}; } catch { throw new Error(`${label}须为有效的 JSON 对象。`); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${label}须为 JSON 对象，不能是数组或空值。`);
  return parsed as Record<string, unknown>;
}
export function modelSettingsRequest(snapshot: ModelSettingsView, draft: ModelSettingsDraft): ModelSettingsUpdate {
  let address: URL;
  try { address = new URL(draft.baseUrl.trim()); } catch { throw new Error('模型服务地址须为完整的 HTTP(S) 地址。'); }
  if (!['https:', 'http:'].includes(address.protocol) || address.username || address.password || address.search || address.hash) throw new Error('模型服务地址不能含凭据、查询参数或片段。');
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(address.hostname);
  if (address.protocol === 'http:' && !local) throw new Error('远程模型服务须使用 HTTPS；本机回环地址可使用 HTTP。');
  if (draft.allowUnauthenticatedLocal && !local) throw new Error('免密访问仅适用于本机回环地址。');
  const maxTokens = Number(draft.maxTokens), timeoutMs = Number(draft.timeoutSeconds) * 1000;
  if (!draft.maxTokens || !Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > 128000) throw new Error('输出 token 上限须为 1–128000 之间的整数。');
  if (!draft.timeoutSeconds || !Number.isSafeInteger(timeoutMs) || timeoutMs < 5000 || timeoutMs > 600000) throw new Error('最长等待时间须为 5–600 秒。');
  if (retainedCredentialsNeedConfirmation(draft, snapshot.settings) && !draft.allowCredentialReuse) throw new Error('服务或地址已改变。请填写新凭据、清除旧凭据，或明确允许在新地址复用。');
  const settings: ModelSettingsUpdate['settings'] = {
    provider: draft.provider,
    protocol: draft.protocol,
    baseUrl: draft.baseUrl.trim(),
    model: draft.model.trim(),
    reasoningEffort: draft.reasoningEffort,
    maxTokens, timeoutMs,
    allowUnauthenticatedLocal: draft.allowUnauthenticatedLocal,
  };
  if (draft.apiKeyAction === 'replace') {
    if (!draft.apiKey.trim()) throw new Error('请填写新 API key，或选择清除已有密钥。');
    if (/[\u0000-\u001f\u007f]/.test(draft.apiKey)) throw new Error('API key 不能包含换行或控制字符。');
    settings.apiKey = draft.apiKey.trim();
  } else if (draft.apiKeyAction === 'clear') settings.apiKey = null;
  if (draft.headersAction === 'replace') {
    const headers = objectJson(draft.headers, '自定义请求头');
    if (Object.entries(headers).some(([key, value]) => !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) || typeof value !== 'string' || /[\r\n\0]/.test(value))) throw new Error('请求头名称须为合法 HTTP 字段，值须为不含换行的字符串。');
    settings.headers = headers as Record<string, string>;
  } else if (draft.headersAction === 'clear') settings.headers = null;
  if (draft.extraBodyAction === 'replace') settings.extraBody = objectJson(draft.extraBody, '高级请求参数');
  else if (draft.extraBodyAction === 'clear') settings.extraBody = null;
  return { revision: snapshot.revision, ...(draft.allowCredentialReuse ? {allowCredentialReuse: true} : {}), settings };
}
