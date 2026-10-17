import {createAgent,AgentNotConfiguredError,AgentTimeoutError,AgentResponseError,type ContextReader} from '@mote/agent';
import type {ModelSettings,ModelTestResult} from '@mote/shared/models';
import type {QueryAgent} from './app.js';
import type {ModelAgentFactory} from './model-agent.js';

/** This reader is intentionally independent from the archive, source store and indexer. */
export async function testModelConnection(settings: ModelSettings, factory: ModelAgentFactory = async(settings,reader)=>createAgent({...settings,reader,requestTimeoutMs:settings.modelRequestTimeoutMs,agentTimeoutMs:settings.agentTimeoutMs})): Promise<ModelTestResult> {
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
