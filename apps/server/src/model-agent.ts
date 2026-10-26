import { createAgent, AgentNotConfiguredError, AgentTimeoutError, AgentResponseError, type ContextReader, type AgentOptions } from '@mote/agent';
import { modelProvider, DEPLOYMENT_MODEL_PROFILE_ID, type ModelSettings, type ModelTestResult, type ModelProfile } from '@mote/shared/models';
import type { Config } from './config.js';
import type { QueryAgent } from './app.js';
import {deploymentModelSettingsSchema,type PreparedModelSettings} from './model-settings.js';

/** Trusted adapters must retain the host's admission and fresh transport fence. */
export type ModelAgentHostHooks=Readonly<Pick<AgentOptions,'runModel'|'authorizeModelRequest'>>;
export type ModelAgentIdentity={kind:'profile'|'file-service'|'probe';id:string};
export type ModelAgentFactory = (settings: ModelSettings, reader: ContextReader,host?:ModelAgentHostHooks,identity?:ModelAgentIdentity) => Promise<QueryAgent>;
export const createModelAgent = async (settings:ModelSettings, reader:ContextReader, codex?:AgentOptions['codex'],runModel?:AgentOptions['runModel'],authorizeModelRequest?:AgentOptions['authorizeModelRequest']):Promise<QueryAgent> => createAgent({ ...settings, reader, runModel, authorizeModelRequest, requestTimeoutMs: settings.modelRequestTimeoutMs, agentTimeoutMs: settings.agentTimeoutMs, codex });

/** A registry generation is immutable. ReloadableAgent leases it for the entire query. */
export async function createModelRegistry(profiles:ModelProfile[], reader:ContextReader, factory:ModelAgentFactory, initial?:QueryAgent,defaultProfileId=DEPLOYMENT_MODEL_PROFILE_ID):Promise<QueryAgent> {
  const agents=new Map<string,QueryAgent>();
  try {
    for(const profile of profiles)agents.set(profile.id,profile.id===defaultProfileId&&initial?initial:await factory(profile.settings,reader,undefined,{kind:'profile',id:profile.id}));
  } catch(error) {await Promise.allSettled([...agents.values()].map(agent=>agent.close()));throw error;}
  return {
    configured:[...agents.values()].some(agent=>agent.configured),
    configuredFor:id=>Boolean(agents.get(id)?.configured),
    async query(input){
      const id=input.modelProfileId??defaultProfileId,agent=agents.get(id),profile=profiles.find(p=>p.id===id);
      if(!agent||!profile||!agent.configured)throw new AgentNotConfiguredError();
      const {modelProfileId:_,modelOverride,...request}=input;
      const model=modelOverride??profile.settings.model;
      const temporary=model!==profile.settings.model?await factory({...profile.settings,model},reader,undefined,{kind:'profile',id:profile.id}):undefined;
      try {
        const result=await (temporary??agent).query(request);
        return {...result,modelSelection:{profileId:id,profileName:profile.name,provider:profile.settings.provider,model}};
      } finally {await temporary?.close();}
    },
    async close(){const results=await Promise.allSettled([...agents.values()].map(agent=>agent.close()));if(results.some(r=>r.status==='rejected'))throw new Error('Model registry cleanup failed');},
  };
}

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

type Generation = { agent: QueryAgent; active: number; retired: boolean; closing?: Promise<void> };

/** Each request leases one runtime. A committed setting only changes subsequent requests. */
export class ReloadableAgent implements QueryAgent {
  private current?: Generation;
  private generations = new Set<Generation>();
  private closed = false;
  constructor(private readonly onCloseError: () => void = () => {}) {}
  get configured(): boolean { return !this.closed && Boolean(this.current?.agent.configured); }
  configuredFor(id:string):boolean { return !this.closed && Boolean(this.current?.agent.configuredFor?.(id)??this.current?.agent.configured); }

  async prepare(agent: QueryAgent, activateConfig: () => void, rollbackConfig: () => void = () => {}): Promise<PreparedModelSettings> {
    if (this.closed) { await agent.close(); throw new Error('Agent is closed'); }
    const generation: Generation = { agent, active: 0, retired: false };
    let activated = false,completed=false,rolledBack=false;
    let previous:Generation|undefined;
    return {
      activate: () => {
        if (activated) return;
        activated = true;
        previous = this.current;
        this.generations.add(generation); this.current = generation; activateConfig();
      },
      rollback:()=>{
        if(!activated||completed||rolledBack)return;
        rolledBack=true;this.current=previous;rollbackConfig();generation.retired=true;
        if(!generation.active)void this.retire(generation);
      },
      complete:()=>{
        if(!activated||completed||rolledBack)return;
        completed=true;
        if(previous){previous.retired=true;if(!previous.active)void this.retire(previous);}
      },
      dispose: async () => { if (!activated) await agent.close(); },
    };
  }

  async query(args: Parameters<QueryAgent['query']>[0]) {
    const generation = this.current;
    if (this.closed) throw new Error('Agent is closed');
    if (!generation) throw new AgentNotConfiguredError();
    generation.active++;
    try { return await generation.agent.query(args); }
    finally { generation.active--; if (generation.retired && !generation.active) void this.retire(generation); }
  }

  private retire(generation: Generation): Promise<void> {
    return generation.closing ??= Promise.resolve().then(() => generation.agent.close())
      .catch(() => this.onCloseError()).finally(() => { this.generations.delete(generation); });
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.generations].map(generation => this.retire(generation)));
  }
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
