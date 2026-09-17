import {DEFAULT_MODEL_MAX_TOKENS,type ModelProtocol} from '@mote/shared/models';
import {AgentConfigurationError, type AgentOptions} from './types.js';

const protocols: ModelProtocol[] = ['deepseek', 'openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai', 'codex-app-server'];
const defaults: Record<ModelProtocol, string> = {
  'codex-app-server': '',
  deepseek: 'https://api.deepseek.com',
  'openai-completions': 'https://api.openai.com/v1',
  'openai-responses': 'https://api.openai.com/v1',
  'anthropic-messages': 'https://api.anthropic.com',
  'google-generative-ai': 'https://generativelanguage.googleapis.com/v1beta',
};
// These providers document the newer Chat Completions output limit field.
// MiniMax: https://platform.minimax.cn/docs/api-reference/text-chat-openai
// Select by explicit provider configuration, never by model-name guessing.
const completionTokenProviders = new Set(['openai', 'azure-openai', 'minimax']);
const forbiddenHeaders = new Set(['host', 'content-length', 'content-type', 'connection', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'keep-alive', 'proxy-authorization', 'proxy-authenticate', 'accept-encoding']);
const forbiddenBody = new Set([
  'model', 'messages', 'input', 'prompt', 'instructions', 'system', 'systeminstruction', 'contents',
  'tools', 'toolchoice', 'toolconfig', 'functions', 'functioncall', 'stream', 'streamoptions',
  'maxtokens', 'maxcompletiontokens', 'maxoutputtokens', 'n', 'candidatecount',
  'store', 'background', 'previousresponseid', 'conversation', 'include', 'serviceaccount',
  'apikey', 'baseurl', 'url', 'headers', 'httpoptions', 'fetch',
]);
const normalizedKey = (key: string) => key.toLowerCase().replace(/[_-]/g, '');
type ConnectionOptions = Pick<AgentOptions, 'protocol' | 'provider' | 'model' | 'baseUrl' | 'reasoningEffort' | 'maxTokens' | 'headers' | 'extraBody' | 'requestTimeoutMs' | 'timeoutMs'>;

/** Keep errors value-free: advanced fields can contain credentials. */
export function validateModelOptions(options: ConnectionOptions): void {
  if(options.protocol==='codex-app-server'&&(options.baseUrl||Object.keys(options.headers??{}).length||Object.keys(options.extraBody??{}).length))throw new AgentConfigurationError('Codex uses its local login and does not accept HTTP endpoints or advanced request parameters.');
  if (options.protocol !== undefined && !protocols.includes(options.protocol)) throw new AgentConfigurationError('Unsupported model protocol.');
  if (options.reasoningEffort !== undefined && !['auto', 'off', 'low', 'high', 'max'].includes(options.reasoningEffort)) throw new AgentConfigurationError('Unsupported reasoning effort.');
  if (options.maxTokens !== undefined && (!Number.isInteger(options.maxTokens) || options.maxTokens < 1 || options.maxTokens > 128_000)) throw new AgentConfigurationError('Model output limit must be between 1 and 128000 tokens.');
  const requestTimeoutMs = options.requestTimeoutMs !== undefined ? options.requestTimeoutMs : options.timeoutMs === undefined ? undefined : Math.max(options.timeoutMs, 5_000);
  if (requestTimeoutMs !== undefined && requestTimeoutMs !== null && (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 5_000 || requestTimeoutMs > 600_000)) throw new AgentConfigurationError('Model request timeout must be between 5000 and 600000 milliseconds.');
  if (options.baseUrl) {
    let url: URL;
    try { url = new URL(options.baseUrl); } catch { throw new AgentConfigurationError('Model endpoint must be an absolute HTTP or HTTPS URL.'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new AgentConfigurationError('Model endpoint must use HTTP or HTTPS without credentials, query or fragment.');
    if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new AgentConfigurationError('Remote model endpoints must use HTTPS. HTTP is allowed only on loopback.');
  }
  if (options.headers !== undefined) {
    if (!options.headers || typeof options.headers !== 'object' || Array.isArray(options.headers) || Object.keys(options.headers).length > 32) throw new AgentConfigurationError('Custom headers must be a JSON object with at most 32 entries.');
    for (const [key, value] of Object.entries(options.headers)) {
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) || forbiddenHeaders.has(key.toLowerCase()) || key.toLowerCase().startsWith('sec-') || key.toLowerCase().startsWith('proxy-') || typeof value !== 'string' || value.length > 8192 || /[^\x20-\x7e\x80-\xff]/.test(value)) throw new AgentConfigurationError('Custom headers contain an invalid or protected transport header.');
    }
    if (Buffer.byteLength(JSON.stringify(options.headers)) > 32_768) throw new AgentConfigurationError('Custom headers exceed 32 KiB.');
  }
  if (options.extraBody !== undefined) {
    if (!options.extraBody || typeof options.extraBody !== 'object' || Array.isArray(options.extraBody)) throw new AgentConfigurationError('Extra model parameters must be a JSON object.');
    let count = 0;
    const visit = (value: unknown, depth: number): void => {
      if (++count > 4096 || depth > 12) throw new AgentConfigurationError('Extra model parameters exceed the structure limit.');
      if (value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return;
      if (!value || typeof value !== 'object') throw new AgentConfigurationError('Extra model parameters must contain JSON values only.');
      if (Array.isArray(value)) { for (const item of value) visit(item, depth + 1); return; }
      if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new AgentConfigurationError('Extra model parameters must contain JSON values only.');
      for (const [key, item] of Object.entries(value)) {
        if (['__proto__', 'prototype', 'constructor'].includes(key) || forbiddenBody.has(normalizedKey(key))) throw new AgentConfigurationError('Extra model parameters cannot replace agent input, tools, transport or response limits.');
        visit(item, depth + 1);
      }
    };
    visit(options.extraBody, 0);
    if (Buffer.byteLength(JSON.stringify(options.extraBody)) > 32_768) throw new AgentConfigurationError('Extra model parameters exceed 32 KiB.');
  }
}

export function modelConnection(options: ConnectionOptions) {
  validateModelOptions(options);
  const protocol = options.protocol ?? 'deepseek';
  const baseUrl = (options.baseUrl || defaults[protocol]).replace(/\/+$/, '');
  const effort = options.reasoningEffort ?? (protocol === 'deepseek' ? 'high' : 'auto');
  const route = protocol === 'deepseek' ? 'deepseek-official' : protocol === 'google-generative-ai' ? 'google' : 'mote-model';
  return {protocol, baseUrl, effort, route};
}

/** Route selection is explicit protocol configuration, never semantic dispatch. */
export function modelRuntimeEntries(options: ConnectionOptions): unknown[] {
  if(options.protocol==='codex-app-server')throw new AgentConfigurationError('Codex requires the App Server runtime.');
  const {protocol, baseUrl, effort, route} = modelConnection(options);
  const maxTokens = options.maxTokens ?? DEFAULT_MODEL_MAX_TOKENS;
  const requestTimeoutMs = options.requestTimeoutMs !== undefined ? options.requestTimeoutMs : options.timeoutMs === undefined ? undefined : Math.max(options.timeoutMs, 5_000);
  const model = {id: options.model!, name: options.model!, contextWindow: 128_000, maxTokens};
  if (protocol === 'deepseek') return [{id: 'llm-deepseek', config: {
    ...(effort === 'auto' ? {thinking: 'disabled'} : {thinking: effort === 'off' ? 'disabled' : 'enabled', reasoningEffort: effort}),
    maxTokens, streamIdleTimeoutMs: Math.max(30_000, requestTimeoutMs ?? 30_000), baseURL: baseUrl, models: [model],
  }}];
  return [
    {id: 'llm-deepseek', disabled: true},
    {insert: [{id: 'mote-llm', name: import.meta.resolve('@deepseek-ai/dsh-llm-pi-ai'), config: {providers: {
      [route]: {
        ...(protocol === 'google-generative-ai' ? {} : {api: protocol}),
        apiKeyEnv: 'MOTE_MODEL_API_KEY', baseURL: baseUrl,
        models: [{...model, input: ['text'], reasoningEfforts: effort === 'auto' ? false : {off: null, low: 'low', high: 'high', max: 'max'}}],
        ...(effort === 'auto' ? {} : {reasoning: effort}),
        ...(protocol === 'openai-completions' ? {compat: {supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: effort !== 'auto', maxTokensField: completionTokenProviders.has(options.provider ?? '') ? 'max_completion_tokens' : 'max_tokens'}} : {}),
        transport: 'sse', streamIdleTimeoutMs: Math.max(30_000, requestTimeoutMs ?? 30_000),
      },
    }}}]},
  ];
}
