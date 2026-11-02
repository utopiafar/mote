import {createHash, randomUUID} from 'node:crypto';
import {PluginHost, PluginResourceScope} from '@mote/plugin-host';
import type {ServiceBinding, ServiceContract, ScopeIdentity} from '@mote/plugin-api/contracts';
import {parameterSchemaSpecToJsonSchema} from '@deepseek-ai/dsh-tools';
import {DEFAULT_MODEL_MAX_TOKENS} from '@mote/shared/models';
import {ActiveExecutionBudget, DEFAULT_AGENT_EXECUTION_TIMEOUT_MS} from './active-budget.js';
import {contextToolDefinitions, pinContextTools} from './tool-contributions.js';
import {taskTools} from './task-context.js';
import {assembleHostContext, settleHostCleanup} from './host/run-session.js';
import {createHostOutputProvider} from './host/output.js';
import {hostOutputService, type HostRunSession} from './host/run-contracts.js';
import {runtimeService} from './runtime/contracts.js';
import {resolveRunSelection} from './runtime/profile.js';
import {DSH_RUNTIME_ID, dshRuntimePlugin, dshModelConfigured, prepareDshRun, type DshModelAdapter} from './runtime/dsh/provider.js';
import {createCodexAgent} from './codex-agent.js';
import {startBridge} from './bridge.js';
import {displayTime} from './time.js';
import {validateModelOptions} from './model-runtime.js';
import {AgentInputError, AgentNotConfiguredError, AgentProviderError, reportProgress, reportTrace, type AgentOptions, type AgentAnswer, type QueryInput} from './types.js';

export {ContextToolRegistry, contextToolDefinitions, type ContextToolContribution} from './tool-contributions.js';
export {buildContextEnvelope, taskTools} from './task-context.js';
export {parseAnswer} from './answer-parser.js';
export {skillCatalog, SKILL_VERSION} from './skills.js';
export {createImportAgent, type ImportAgentInput} from './import-agent.js';
export * from './types.js';
export {AgentYieldError, hostControlDefinitions, hostControlInstructions, type HostControlChannel, type HostControlDefinition, type HostControlResult} from './host-controls.js';
export {ContextToolError} from './tool-errors.js';
export {originalEvidenceReceipt} from './bridge.js';
export {extractionSeedScopeValid} from './extraction-seed-scope.js';
export {validateInlineCitations} from './citations.js';
export {validateModelOptions} from './model-runtime.js';
export {SYSTEM_PROMPT, SOURCE_TIME_INSTRUCTIONS, ATTRIBUTION_CONTEXT_INSTRUCTIONS, systemInstructions} from './instructions.js';
export {createRuntimePatch} from './runtime/dsh/profile-compiler.js';
export {CodexSession} from './codex-session.js';

class AgentClosedError extends Error { constructor() { super('Agent is closed'); } }
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
// Private fixed-configuration adapter; the dynamic model plugin/transaction is A10/A09.
const fixedModelService: ServiceContract<DshModelAdapter> = {id: 'mote.runtime.dsh.fixed-model', apiVersion: '1'};

/** Public fixed-settings facade. All DSH execution uses the same official
 * runtime contribution and Host run session as explicitly selected profiles. */
export function createAgent(original: AgentOptions) {
  validateModelOptions(original);
  if (original.protocol === 'codex-app-server') return createCodexAgent(original);
  const options = {...original, headers: original.headers && {...original.headers}, extraBody: original.extraBody && structuredClone(original.extraBody)};
  const {reader, runModel, contextToolMode, codex: _codex, ...adapter} = options;
  const configured = dshModelConfigured(adapter);
  const hostIdentity = {kind: 'central' as const, id: randomUUID()};
  const identity = (id: string): ScopeIdentity => ({packageId: id, installationId: hostIdentity.id, instanceId: id, activationId: randomUUID(), host: hostIdentity});
  const host = new PluginHost(hostIdentity);
  const runtimeIdentity = identity(DSH_RUNTIME_ID), foundationIdentity = identity('mote.agent.foundation');
  let closed = false, startup: Promise<void> | undefined;
  let runtimeBinding: ServiceBinding, modelBinding: ServiceBinding, outputBinding: ServiceBinding;
  const pending = new Set<Promise<AgentAnswer>>(), scopes = new Set<PluginResourceScope>();
  const initialize = () => startup ??= (async () => {
    await host.install(dshRuntimePlugin(runtimeIdentity, {}, binding => { runtimeBinding = binding; }));
    await host.install({identity: foundationIdentity, contributions: [fixedModelService, hostOutputService], factory(context) {
      return {prepare() {}, start() {
        modelBinding = context.provide(fixedModelService.id, fixedModelService, adapter);
        outputBinding = context.provide(hostOutputService.id, hostOutputService, createHostOutputProvider());
      }, quiesce() {}, stop() {}, dispose() {}};
    }});
  })();
  async function execute(raw: QueryInput): Promise<AgentAnswer> {
    const input = pinContextTools({...raw, ...(raw.evidenceReadRanges ? {evidenceReadRanges: Object.freeze(raw.evidenceReadRanges.map(range => Object.freeze({...range})))} : {}), ...(contextToolMode ? {hostContextToolMode: contextToolMode} : {})}, reader);
    input.signal?.throwIfAborted();
    if (closed) throw new AgentClosedError();
    if (!configured) throw new AgentNotConfiguredError();
    if (typeof input.question !== 'string' || !input.question.trim()) throw new AgentInputError();
    displayTime(new Date().toISOString(), input.timeZone);
    const runId = randomUUID(), resources = new PluginResourceScope(); scopes.add(resources);
    const scope = Object.assign(resources, {identity: identity('mote.agent.query')});
    const signal = AbortSignal.any([scope.signal, ...(input.signal ? [input.signal] : [])]);
    const assertCurrent = () => { signal.throwIfAborted(); if (closed) throw new AgentClosedError(); input.assertContextAuthority?.(); };
    const trace = (event: Parameters<typeof reportTrace>[1]) => reportTrace(input, {...event, runId});
    let session: HostRunSession | undefined, bridge: Awaited<ReturnType<typeof startBridge>> | undefined;
    let bridgeClosing: Promise<void> | undefined;
    const closeBridge = () => bridge ? bridgeClosing ??= bridge.close() : Promise.resolve();
    let primary = false;
    try {
      reportProgress(input, {stage: 'starting'});
      trace({type: 'run.started', stage: 'starting', payload: {model: options.model, provider: options.provider, protocol: options.protocol, skill: input.skill ?? null, responseMode: input.responseMode ?? 'answer', question: input.question, traceContext: input.traceContext ?? null}});
      await initialize(); assertCurrent();
      // Output availability is checked before bridge reads or runtime preparation.
      const output = await host.acquire(hostOutputService, outputBinding!, signal); scope.defer(() => output.release());
      const runtime = await host.acquire(runtimeService, runtimeBinding!, signal); scope.defer(() => runtime.release());
      const modelPort = await host.acquire(fixedModelService, modelBinding!, signal); scope.defer(() => modelPort.release());
      const selection = resolveRunSelection({revision: 0,
        profile: {id: 'fixed-dsh', name: 'DSH', revision: 0, runtimeProviderId: DSH_RUNTIME_ID, providerRef: {service: runtime.binding.service, revision: runtime.binding.revision, provider: {instance: {packageId: runtimeIdentity.packageId, installationId: runtimeIdentity.installationId, instanceId: runtimeIdentity.instanceId}, contributionId: runtime.binding.provider.contributionId}}, assembly: {packages: [], hooks: []}, allowedHostCapabilities: ['tools', 'images', 'hostDelegation']},
        providers: [{id: DSH_RUNTIME_ID, binding: runtime.binding, capabilities: runtime.value.capabilities, availability: {state: 'active'}}], installedModules: [],
        model: {profile: {id: 'fixed-model', name: 'Fixed model', settings: {provider: options.provider ?? 'custom', protocol: options.protocol ?? 'deepseek', baseUrl: options.baseUrl ?? '', model: options.model!, apiKey: options.apiKey ?? '', headers: options.headers ?? {}, extraBody: options.extraBody ?? {}, allowUnauthenticatedLocal: options.allowUnauthenticatedLocal ?? false, reasoningEffort: options.reasoningEffort ?? 'auto', maxTokens: options.maxTokens ?? DEFAULT_MODEL_MAX_TOKENS, modelRequestTimeoutMs: options.requestTimeoutMs ?? null, agentTimeoutMs: options.agentTimeoutMs ?? null}}, profileRevision: 0, modelRevision: 0, connectionFingerprint: hash(adapter), capabilities: {tools: true, images: true}},
        requirements: {taskKind: 'query', capabilities: taskTools(input).length ? ['tools'] : []},
      });
      bridge = await startBridge(reader, {...input, signal, onTrace: trace}, options.maxToolCalls); assertCurrent();
      const definitions = contextToolDefinitions(input).filter(([name]) => taskTools(input).includes(name)).map(([name, description, fields]) => {
        const pin = input.contextCapabilitySnapshot?.find(tool => tool.name === name);
        return {name, description, inputSchema: {...parameterSchemaSpecToJsonSchema(fields as unknown as Parameters<typeof parameterSchemaSpecToJsonSchema>[0]), additionalProperties: false}, version: pin?.version ?? '1', fingerprint: pin?.fingerprint ?? hash([description, fields])};
      });
      const {system, prompt, metrics} = assembleHostContext(input, bridge.seedEvidence, options.maxTokens ?? DEFAULT_MODEL_MAX_TOKENS, options.maxToolCalls);
      trace({type: 'instructions.assembled', stage: 'starting', payload: {system, tools: definitions}});
      trace({type: 'context.assembled', stage: 'starting', payload: {prompt, metrics, seedEvidence: bridge.seedEvidence}});
      session = await prepareDshRun(selection, {runId, scope, input, runtime, model: {...modelPort, selection: selection.modelSelection}, output,
        tools: {definitions, bindings: [], assertCurrent}, commitFence: {assertCurrent},
        budget: {activeTimeoutMs: options.agentTimeoutMs === undefined ? DEFAULT_AGENT_EXECUTION_TIMEOUT_MS : options.agentTimeoutMs},
        activeBudget: new ActiveExecutionBudget(options.agentTimeoutMs === undefined ? DEFAULT_AGENT_EXECUTION_TIMEOUT_MS : options.agentTimeoutMs),
      }, {
        systemPrompt: system, prompt, contextUsage: {...metrics, toolResults: 0}, maxTokens: options.maxTokens,
        evidence: () => bridge!,
        // The stable A08 staged read is connected here before this facade is published.
        readTool: async () => { throw new AgentProviderError(); },
        admit: (task, admissionSignal) => runModel ? runModel(task, admissionSignal) : task(),
        close: closeBridge,
        observe: ({event}) => { if (event.type === 'usage') input.onUsage?.(event.usage); else if (event.type === 'progress') reportProgress(input, event.progress); },
        cleanupFailed: errors => trace({type: 'run.cleanup_failed', status: 'failed', payload: {count: errors.length}}),
      });
      return await session.execute();
    } catch (error) { primary = true; throw error; }
    finally {
      try {
        await settleHostCleanup([() => session?.close(), closeBridge, () => scope.close()], primary, errors => trace({type: 'run.cleanup_failed', status: 'failed', payload: {count: errors.length}}));
      } finally { scopes.delete(resources); }
    }
  }
  return {configured,
    query(input: QueryInput) { const task = execute(input); pending.add(task); void task.then(() => pending.delete(task), () => pending.delete(task)); return task; },
    async close() {
      closed = true; for (const scope of scopes) scope.stop();
      await Promise.allSettled([...pending]);
      await host.close();
    },
  };
}
