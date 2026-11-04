import { createAgent, AgentNotConfiguredError, AgentTimeoutError, AgentResponseError, type ContextReader, type AgentOptions } from '@mote/agent';
import { modelProvider, type ModelSettings, type ModelTestResult } from '@mote/shared/models';
import type { Config } from './config.js';
import type { QueryAgent } from './query-agent.js';
import {deploymentModelSettingsSchema} from './model-settings.js';

/** Trusted adapters must retain the host's admission and fresh transport fence. */
export type ModelAgentHostHooks=Readonly<Pick<AgentOptions,'runModel'|'authorizeModelRequest'>>;
export type ModelAgentIdentity={kind:'profile'|'file-service'|'probe';id:string};
export type ModelAgentFactory = (settings: ModelSettings, reader: ContextReader,host?:ModelAgentHostHooks,identity?:ModelAgentIdentity) => Promise<QueryAgent>;
export const createModelAgent = async (settings:ModelSettings, reader:ContextReader, codex?:AgentOptions['codex'],runModel?:AgentOptions['runModel'],authorizeModelRequest?:AgentOptions['authorizeModelRequest']):Promise<QueryAgent> => createAgent({ ...settings, reader, runModel, authorizeModelRequest, requestTimeoutMs: settings.modelRequestTimeoutMs, agentTimeoutMs: settings.agentTimeoutMs, codex });

export function modelSettingsFromConfig(config: Config): ModelSettings {
  const protocol=config.modelProtocol??modelProvider(config.modelProvider??'deepseek')?.protocol;
  const value={
    provider:config.modelProvider,protocol,baseUrl:config.modelBaseUrl||modelProvider(config.modelProvider??'deepseek')?.baseUrl||'',model:config.model,
    apiKey:config.apiKey,headers:config.modelHeaders,extraBody:config.modelExtraBody,reasoningEffort:config.modelReasoningEffort,
    maxTokens:config.modelMaxTokens,modelRequestTimeoutMs:config.modelRequestTimeoutMs,agentTimeoutMs:config.agentTimeoutMs,
    serviceTier:protocol==='codex-app-server'?'default':undefined,allowUnauthenticatedLocal:config.allowUnauthenticatedLocal,
  };
  return deploymentModelSettingsSchema.parse(Object.fromEntries(Object.entries(value).filter(([,field])=>field!==undefined)));
}

export function applyModelSettings(config: Config, settings: ModelSettings): void {
  config.modelProvider = settings.provider; config.modelProtocol = settings.protocol;
  config.modelBaseUrl = settings.baseUrl; config.model = settings.model; config.apiKey = settings.apiKey;
  config.modelHeaders = structuredClone(settings.headers); config.modelExtraBody = structuredClone(settings.extraBody);
  config.modelReasoningEffort = settings.reasoningEffort; config.modelMaxTokens = settings.maxTokens;
  config.modelRequestTimeoutMs = settings.modelRequestTimeoutMs; config.agentTimeoutMs = settings.agentTimeoutMs;
  config.allowUnauthenticatedLocal = settings.allowUnauthenticatedLocal;
}

/** This reader is intentionally independent from the archive, source store and indexer. */
export async function testModelConnection(settings: ModelSettings, factory: ModelAgentFactory = (settings,reader)=>createModelAgent(settings,reader)): Promise<ModelTestResult> {
  const started = Date.now(), id = '7a8f56d1-45de-47b7-90bb-5e84d411c3d6';
  const record = { id, capturedAt: '2026-01-01T00:00:00.000Z', appName: 'Mote synthetic connection test', ocrText: 'This generated test record confirms a read-only model tool round trip. No personal archive is connected.' };
  const reader: ContextReader = {
    search: async () => [record], timeline: async () => ({ items: [record], nextCursor: null, totalCount: 1 }),
    evidence: async args => args.ids.includes(id) ? [record] : [], activity: async () => ({ captures: 0 }), devices: async () => [],
    sources: async () => [], sourceItems: async () => ({ items: [], nextCursor: null, totalCount: 0 }),
    sourceHistory: async () => [], memories: async () => ({ items: [] }),
  };
  let candidate: QueryAgent | undefined;
  let code: ModelTestResult['code'];
  try {
    candidate = await factory({ ...settings,
      modelRequestTimeoutMs: settings.modelRequestTimeoutMs === null ? null : Math.min(settings.modelRequestTimeoutMs, 30_000),
      agentTimeoutMs: 30_000,
    }, reader);
    if (!candidate.configured) code = 'not_configured';
    else {
      const result = await candidate.query({ question: 'Run a connection test using only the generated fixture in the connected reader. Call search to find the test record, then evidence to read it. Briefly state what the record confirms and cite its complete ID. Follow the required final answer JSON format.' });
      code = result.citations.some(citation => citation.id === id) && result.trace.some(call => call.tool === 'evidence') ? 'ok' : 'invalid_response';
    }
  } catch (error) {
    code = error instanceof AgentNotConfiguredError ? 'not_configured' : error instanceof AgentTimeoutError ? 'timeout' : error instanceof AgentResponseError ? 'invalid_response' : 'provider_error';
  } finally { try { await candidate?.close(); } catch { /* Never disclose provider or filesystem errors. */ } }
  return { ok: code === 'ok', code, message: '', durationMs: Math.max(0, Date.now() - started) };
}
