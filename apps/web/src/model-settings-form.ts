import { moteText } from '@mote/shared/i18n';
import {MAX_AGENT_TIMEOUT_MS, MAX_MODEL_REQUEST_TIMEOUT_MS, type ModelSettingsPublic, type ModelSettingsView, type ModelSettingsUpdate} from '@mote/shared/models';
/** Only a status is returned for existing credentials; new values stay in page memory. */
export type CredentialAction = 'keep' | 'replace' | 'clear';
export interface ModelSettingsDraft {
  provider: string;
  protocol: ModelSettingsPublic['protocol'];
  baseUrl: string;
  model: string;
  reasoningEffort: ModelSettingsPublic['reasoningEffort'];
  maxTokens: string;
  modelRequestTimeoutSeconds: string;
  agentTimeoutSeconds: string;
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
    modelRequestTimeoutSeconds: settings.modelRequestTimeoutMs === null ? '' : String(settings.modelRequestTimeoutMs / 1000),
    agentTimeoutSeconds: settings.agentTimeoutMs === null ? '' : String(settings.agentTimeoutMs / 1000),
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
  if(draft.protocol==='codex-app-server')return false; // This transport clears HTTP credentials.
  return changedCredentialDestination(draft, settings) &&
    ((settings.apiKeyConfigured && draft.apiKeyAction === 'keep') || (settings.headersConfigured && draft.headersAction === 'keep') || (settings.extraBodyConfigured && draft.extraBodyAction === 'keep'));
}
function objectJson(value: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = value.trim() ? JSON.parse(value) : {}; } catch { throw new Error(moteText("{0}须为有效的 JSON 对象。", label)); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(moteText("{0}须为 JSON 对象，不能是数组或空值。", label));
  return parsed as Record<string, unknown>;
}
export function modelSettingsRequest(snapshot: ModelSettingsView, draft: ModelSettingsDraft): ModelSettingsUpdate {
  if(draft.protocol!=='codex-app-server'&&(draft.baseUrl.trim()||draft.model.trim())){
  let address: URL;
  try { address = new URL(draft.baseUrl.trim()); } catch { throw new Error(moteText("模型服务地址须为完整的 HTTP(S) 地址。")); }
  if (!['https:', 'http:'].includes(address.protocol) || address.username || address.password || address.search || address.hash) throw new Error(moteText("模型服务地址不能含凭据、查询参数或片段。"));
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(address.hostname);
  if (address.protocol === 'http:' && !local) throw new Error(moteText("远程模型服务须使用 HTTPS；本机回环地址可使用 HTTP。"));
  if (draft.allowUnauthenticatedLocal && !local) throw new Error(moteText("免密访问仅适用于本机回环地址。"));
  }
  const maxTokens = draft.protocol==='codex-app-server'?snapshot.settings.maxTokens:Number(draft.maxTokens);
  const modelRequestTimeoutMs = draft.protocol==='codex-app-server' ? null : Number(draft.modelRequestTimeoutSeconds) * 1000;
  const agentTimeoutMs = draft.agentTimeoutSeconds.trim() ? Number(draft.agentTimeoutSeconds) * 1000 : null;
  const modelRequestTimeoutValid = typeof modelRequestTimeoutMs === 'number' && Number.isSafeInteger(modelRequestTimeoutMs) && modelRequestTimeoutMs >= 5000 && modelRequestTimeoutMs <= MAX_MODEL_REQUEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > 128000) throw new Error(moteText("输出 token 上限须为 1–128000 之间的整数。"));
  if (draft.protocol !== 'codex-app-server' && (!draft.modelRequestTimeoutSeconds || !modelRequestTimeoutValid)) throw new Error(moteText("单次模型请求超时须为 5–600 秒。"));
  if (draft.protocol !== 'codex-app-server' && (agentTimeoutMs === null || !Number.isSafeInteger(agentTimeoutMs) || agentTimeoutMs < 5000 || agentTimeoutMs > MAX_AGENT_TIMEOUT_MS)) throw new Error(moteText("Agent 总运行超时须为 5–3600 秒。"));
  if (draft.protocol === 'codex-app-server' && agentTimeoutMs !== null && (!Number.isSafeInteger(agentTimeoutMs) || agentTimeoutMs < 5000 || agentTimeoutMs > MAX_AGENT_TIMEOUT_MS)) throw new Error(moteText("Agent 总运行超时须为空，或为 5–3600 秒。"));
  if (retainedCredentialsNeedConfirmation(draft, snapshot.settings) && !draft.allowCredentialReuse) throw new Error(moteText("服务或地址已改变。请填写新凭据、清除旧凭据，或明确允许在新地址复用。"));
  const settings: ModelSettingsUpdate['settings'] = {
    provider: draft.provider,
    protocol: draft.protocol,
    baseUrl: draft.baseUrl.trim(),
    model: draft.model.trim(),
    reasoningEffort: draft.reasoningEffort,
    maxTokens, modelRequestTimeoutMs, agentTimeoutMs,
    allowUnauthenticatedLocal: draft.allowUnauthenticatedLocal,
  };
  if(draft.protocol==='codex-app-server')return {revision:snapshot.revision,settings:{...settings,baseUrl:'',apiKey:null,headers:null,extraBody:null,allowUnauthenticatedLocal:false}};
  if (draft.apiKeyAction === 'replace') {
    if (!draft.apiKey.trim()) throw new Error(moteText("请填写新 API key，或选择清除已有密钥。"));
    if (/[\u0000-\u001f\u007f]/.test(draft.apiKey)) throw new Error(moteText("API key 不能包含换行或控制字符。"));
    settings.apiKey = draft.apiKey.trim();
  } else if (draft.apiKeyAction === 'clear') settings.apiKey = null;
  if (draft.headersAction === 'replace') {
    const headers = objectJson(draft.headers, moteText("自定义请求头"));
    if (Object.entries(headers).some(([key, value]) => !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) || typeof value !== 'string' || /[\r\n\0]/.test(value))) throw new Error(moteText("请求头名称须为合法 HTTP 字段，值须为不含换行的字符串。"));
    settings.headers = headers as Record<string, string>;
  } else if (draft.headersAction === 'clear') settings.headers = null;
  if (draft.extraBodyAction === 'replace') settings.extraBody = objectJson(draft.extraBody, moteText("高级请求参数"));
  else if (draft.extraBodyAction === 'clear') settings.extraBody = null;
  return { revision: snapshot.revision, ...(draft.allowCredentialReuse ? {allowCredentialReuse: true} : {}), settings };
}
