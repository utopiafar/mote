import {createHash, randomUUID} from 'node:crypto';
import {PluginHost, PluginResourceScope} from '@mote/plugin-host';
import type {ServiceBinding, ServiceContract, ScopeIdentity} from '@mote/plugin-api/contracts';
import {toolInputSchema,toRuntimeToolDefinition} from './tools/runtime-schema.js';
import {DEFAULT_MODEL_MAX_TOKENS} from '@mote/shared/models';
import {ActiveExecutionBudget, DEFAULT_AGENT_EXECUTION_TIMEOUT_MS} from './active-budget.js';
import {contextToolDefinitions, pinContextTools,contextToolSnapshot,releaseContextTools} from './tool-contributions.js';
import {taskTools} from './task-context.js';
import {assembleHostContext, settleHostCleanup} from './host/run-session.js';
import {createHostOutputProvider} from './host/output.js';
import {hostOutputService, type HostRunEvent, type HostRunSession} from './host/run-contracts.js';
import {runtimeService, type RuntimeToolCall, type RuntimeToolDefinition} from './runtime/contracts.js';
import {resolveRunSelection} from './runtime/profile.js';
import {DSH_RUNTIME_ID, dshRuntimePlugin, dshModelConfigured, prepareDshRun, type DshModelAdapter} from './runtime/dsh/provider.js';
import {CODEX_RUNTIME_ID, codexRuntimePlugin, prepareCodexRun, type CodexModelAdapter} from './runtime/codex/provider.js';
import {contextToolPayload} from './runtime/dsh/context-plugin.js';
import {ContextToolError} from './tool-errors.js';
import {codexImageMetadata, type ImagePayload} from './tools/image-result.js';
import {startBridge} from './bridge.js';
import {displayTime} from './time.js';
import {validateModelOptions} from './models/provider-registry.js';
import {bundledSkills, SKILL_VERSION} from './skills.js';
import {AgentYieldError} from './host-controls.js';
import {AgentInputError, AgentNotConfiguredError, AgentResponseError, reportProgress, reportTrace, type AgentOptions, type AgentAnswer, type QueryInput, type QueryRunLease} from './types.js';

export {contextToolDefinitions} from './tool-contributions.js';
export {ToolRegistry} from './tools/registry.js';
export {defineToolDescriptor,type ToolDescriptor} from './tools/descriptor.js';
export {TaskRegistry} from './tasks/registry.js';
export {TASK_DESCRIPTOR_API_VERSION,TASK_OUTPUT_SCHEMA,TaskContractError,defineTaskDescriptor,defineSkillDescriptor,type TaskDescriptor,type SkillDescriptor,type TaskPack,type TaskSelection,type SkillAvailability} from './tasks/descriptor.js';
export {prepareTaskContext} from './tasks/context-assembly.js';
export {createOfficialReadPacks,type ReadPackRegistration,type DerivedNavigationInputs} from './tools/official-read-packs.js';
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
export {validateModelOptions} from './models/provider-registry.js';
export {SYSTEM_PROMPT, SOURCE_TIME_INSTRUCTIONS, ATTRIBUTION_CONTEXT_INSTRUCTIONS, systemInstructions} from './instructions.js';
export {createRuntimePatch} from './runtime/dsh/profile-compiler.js';
export {CodexSession} from './codex-session.js';

class AgentClosedError extends Error { constructor() { super('Agent is closed'); } }
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
// Private fixed-configuration adapter; the dynamic model plugin/transaction is A10/A09.
const fixedModelService: ServiceContract<DshModelAdapter | CodexModelAdapter> = {id: 'mote.agent.fixed-model', apiVersion: '1'};

/** Public fixed-settings facade. Both DSH and Codex execution use the same
 * official runtime contributions, Host tools and Host run session. */
export function createAgent(original: AgentOptions): {
  readonly configured: boolean;
  query(input: QueryInput, lease?: QueryRunLease): Promise<AgentAnswer>;
  close(): Promise<void>;
} {
  validateModelOptions(original);
  const options = {...original, headers: original.headers && {...original.headers}, extraBody: original.extraBody && structuredClone(original.extraBody)};
  const codex = options.protocol === 'codex-app-server';
  const {reader, runModel, contextToolMode, codex: codexLaunch, ...dshAdapter} = options;
  // A Codex login is not an HTTP model: it is configured only by its model ID.
  const modelAdapter: CodexModelAdapter | DshModelAdapter = codex
    ? {model: options.model, reasoningEffort: options.reasoningEffort, serviceTier: options.serviceTier, ...(options.authorizeModelRequest ? {authorizeModelRequest: options.authorizeModelRequest} : {})}
    : dshAdapter;
  const configured = codex ? Boolean(options.model?.trim()) : dshModelConfigured(dshAdapter);
  const runtimeId = codex ? CODEX_RUNTIME_ID : DSH_RUNTIME_ID;
  const launch = codex ? Object.fromEntries(Object.entries({executable: codexLaunch?.executable, home: codexLaunch?.home}).filter(([, value]) => value !== undefined)) as {executable?: string; home?: string} : undefined;
  const skills = Object.freeze(bundledSkills.filter(skill => skill.availability !== 'import').map(skill => Object.freeze({...skill})));
  const skillTool = Object.freeze({name: 'skill', version: SKILL_VERSION, fingerprint: hash(skills),
    description: 'Load the full instructions for a Host-granted bundled skill. Available skills:\n' + skills.map(skill => `${skill.name}: ${skill.description}`).join('\n'),
    inputSchema: {type: 'object', properties: {name: {type: 'string', enum: skills.map(skill => skill.name)}}, required: ['name'], additionalProperties: false},
  });
  const hostIdentity = {kind: 'central' as const, id: randomUUID()};
  const identity = (id: string): ScopeIdentity => ({packageId: id, installationId: hostIdentity.id, instanceId: id, activationId: randomUUID(), host: hostIdentity});
  const host = new PluginHost(hostIdentity);
  const runtimeIdentity = identity(runtimeId), foundationIdentity = identity('mote.agent.foundation');
  let closed = false, startup: Promise<void> | undefined;
  let runtimeBinding: ServiceBinding, modelBinding: ServiceBinding, outputBinding: ServiceBinding;
  const pending = new Set<Promise<AgentAnswer>>(), scopes = new Set<PluginResourceScope>();
  const initialize = () => startup ??= (async () => {
    await host.install(codex ? codexRuntimePlugin(runtimeIdentity, binding => { runtimeBinding = binding; }) : dshRuntimePlugin(runtimeIdentity, {}, binding => { runtimeBinding = binding; }));
    await host.install({identity: foundationIdentity, contributions: [fixedModelService, hostOutputService], factory(context) {
      return {prepare() {}, start() {
        modelBinding = context.provide(fixedModelService.id, fixedModelService, modelAdapter);
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
    scope.defer(()=>releaseContextTools(input));
    const signal = AbortSignal.any([scope.signal, ...(input.signal ? [input.signal] : [])]);
    const assertCurrent = () => { input.signal?.throwIfAborted(); if (closed) throw new AgentClosedError(); signal.throwIfAborted(); input.assertContextAuthority?.(); };
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
        profile: {id: codex ? 'fixed-codex' : 'fixed-dsh', name: codex ? 'Codex' : 'DSH', revision: 0, runtimeProviderId: runtimeId, providerRef: {service: runtime.binding.service, revision: runtime.binding.revision, provider: {instance: {packageId: runtimeIdentity.packageId, installationId: runtimeIdentity.installationId, instanceId: runtimeIdentity.instanceId}, contributionId: runtime.binding.provider.contributionId}}, assembly: {packages: [], hooks: []}, allowedHostCapabilities: ['tools', 'images', 'hostDelegation']},
        providers: [{id: runtimeId, binding: runtime.binding, capabilities: runtime.value.capabilities, availability: {state: 'active'}}], installedModules: [],
        model: {profile: {id: 'fixed-model', name: 'Fixed model', settings: {provider: options.provider ?? (codex ? 'codex' : 'custom'), protocol: options.protocol ?? (codex ? 'codex-app-server' : 'deepseek'), baseUrl: options.baseUrl ?? '', model: options.model!, apiKey: options.apiKey ?? '', headers: options.headers ?? {}, extraBody: options.extraBody ?? {}, allowUnauthenticatedLocal: codex ? false : options.allowUnauthenticatedLocal ?? false, reasoningEffort: options.reasoningEffort ?? 'auto', ...(codex && options.serviceTier ? {serviceTier: options.serviceTier} : {}), maxTokens: options.maxTokens ?? DEFAULT_MODEL_MAX_TOKENS, modelRequestTimeoutMs: codex ? null : options.requestTimeoutMs ?? null, agentTimeoutMs: options.agentTimeoutMs ?? null}}, profileRevision: 0, modelRevision: 0, connectionFingerprint: hash(modelAdapter), capabilities: {tools: true, images: true}},
        // This fixed-settings facade mirrors the existing model adapter's
        // declared tool and text/image surface. Catalogue discovery and dynamic
        // model/configuration revisions remain with A10/A09.
        requirements: {taskKind: 'query', capabilities: ['tools']},
        ...(codex ? {launch: launch ?? {}} : {}),
      });
      bridge = await startBridge(reader, {...input, signal, onTrace: trace}, options.maxToolCalls); assertCurrent();
      const toolSnapshot=contextToolSnapshot(input);
      const assertToolPins=()=>{assertCurrent();for(const pin of toolSnapshot.entries)try{toolSnapshot.assertActive(pin);}catch{throw new ContextToolError('stale_tool_pin','The registered tool was revoked or replaced.','stop');}};
      const definitions: RuntimeToolDefinition[] = contextToolDefinitions(input).filter(([name]) => taskTools(input).includes(name)).map(([name, description, fields]) => {
        const pin=toolSnapshot.entries.find(tool=>tool.name===name);
        return pin?toRuntimeToolDefinition(pin):{name,description,inputSchema:toolInputSchema(fields),version:'1',fingerprint:hash([description,fields])};
      });
      definitions.push(skillTool);
      const {system, prompt, metrics, outputSchema} = assembleHostContext(input, bridge.seedEvidence, options.maxTokens ?? DEFAULT_MODEL_MAX_TOKENS, options.maxToolCalls, definitions);
      trace({type: 'instructions.assembled', stage: 'starting', payload: {system, tools: definitions}});
      trace({type: 'context.assembled', stage: 'starting', payload: {prompt, metrics, seedEvidence: bridge.seedEvidence}});
      // Codex has no child trace channel of its own; its protocol diagnostics are
      // observed through the same Host run. DSH keeps its existing runtime events.
      const traceTool = (event: Parameters<typeof reportTrace>[1]) => { if (codex) trace(event); };
      const readHostTool = async (call: RuntimeToolCall, toolSignal: AbortSignal) => {
        traceTool({type: 'tool.started', stage: 'tool', phase: 'started', tool: call.name, payload: {arguments: call.arguments}});
        try {
          if (!call.arguments || typeof call.arguments !== 'object' || Array.isArray(call.arguments)) throw new ContextToolError('invalid_tool_arguments', 'Expected object arguments.', 'correct_arguments');
          if (call.name === skillTool.name) {
            const args = call.arguments as Record<string, unknown>, skill = skills.find(skill => skill.name === args.name);
            if (Object.keys(args).some(key => key !== 'name') || !skill) throw new ContextToolError('invalid_tool_arguments', 'Use an exact Host-granted skill name.', 'correct_arguments');
            const result = {name: skill.name, content: skill.content};
            traceTool({type: 'tool.completed', stage: 'tool', phase: 'completed', tool: call.name, status: 'succeeded', payload: {result}});
            return {payload: {text: skill.content}, confirm() {}, discard() {}};
          }
          const staged = await bridge!.prepareDelivery(call.name, call.arguments as Record<string, unknown>, toolSignal);
          try {
            const payload = contextToolPayload(staged.value);
            // The model receives the image, but diagnostics only need its identity
            // and size. Copying base64 into traces duplicates private originals and
            // can overwhelm the log viewer even when the read itself is bounded.
            const image = call.name === 'read_image' && (staged.value as ImagePayload | undefined)?.image;
            const result = image ? {...codexImageMetadata(staged.value as ImagePayload), image: {mimeType: image.mimeType, encodedCharacters: image.data.length}} : staged.value;
            traceTool({type: 'tool.completed', stage: 'tool', phase: 'completed', tool: call.name, status: 'succeeded', payload: {result}});
            return {payload, confirm: staged.confirm, discard: staged.discard};
          } catch (error) {
            try { staged.discard(); }
            catch { trace({type: 'run.cleanup_failed', status: 'failed', payload: {count: 1, resource: 'tool_delivery'}}); }
            throw error;
          }
        } catch (error) {
          traceTool({type: 'tool.completed', stage: 'tool', phase: 'completed', tool: call.name, status: 'failed', payload: {errorName: error instanceof Error ? error.name : 'UnknownError'}});
          throw error;
        }
      };
      const observeHostRun = (envelope: HostRunEvent) => {
        try { input.onHostRunEvent?.(structuredClone(envelope)); } catch { /* Observation cannot change execution or suppress legacy observers. */ }
        const {event} = envelope;
        if (event.type === 'usage') input.onUsage?.(event.usage);
        else if (event.type === 'progress') reportProgress(input, event.progress);
        else if (event.type === 'tools.ready') trace({type: 'bridge.ready', stage: 'starting', status: 'succeeded', payload: {tools: event.tools.length}});
      };
      const dependencies = {runId, scope, input, runtime, model: {...modelPort, selection: selection.modelSelection}, output,
        tools: {definitions, bindings: [], assertCurrent:assertToolPins}, commitFence: {assertCurrent:assertToolPins},
        budget: {activeTimeoutMs: options.agentTimeoutMs === undefined ? DEFAULT_AGENT_EXECUTION_TIMEOUT_MS : options.agentTimeoutMs},
        activeBudget: new ActiveExecutionBudget(options.agentTimeoutMs === undefined ? DEFAULT_AGENT_EXECUTION_TIMEOUT_MS : options.agentTimeoutMs),
      };
      const assembly = {systemPrompt: system, prompt, outputSchema, contextUsage: {...metrics, toolResults: 0}, maxTokens: options.maxTokens,
        evidence: () => bridge!, readTool: readHostTool,
        admit: <T>(task: () => Promise<T>, admissionSignal: AbortSignal) => runModel ? runModel(task, admissionSignal) : task(),
        close: closeBridge, observe: observeHostRun, trace,
        cleanupFailed: (errors: readonly unknown[]) => trace({type: 'run.cleanup_failed', status: 'failed', payload: {count: errors.length}}),
      };
      session = codex ? await prepareCodexRun(selection, dependencies, assembly) : await prepareDshRun(selection, dependencies, assembly);
      const answer = await session.execute();
      trace({type: 'run.completed', stage: 'validating', phase: 'completed', status: 'succeeded', payload: {citations: answer.citations.map(citation => citation.id), toolCalls: answer.trace}});
      return answer;
    } catch (error) {
      primary = true;
      if (!session) {
        if (input.signal?.aborted) error = input.signal.reason;
        else if (closed) error = new AgentClosedError();
      }
      if (error instanceof AgentYieldError) trace({type: 'run.yielded', status: 'waiting'});
      else trace({type: 'run.failed', status: 'failed', payload: {errorName: error instanceof Error ? error.name : 'UnknownError', reason: error instanceof AgentResponseError ? error.reason : undefined}});
      throw error;
    }
    finally {
      try {
        await settleHostCleanup([() => session?.close(), closeBridge, () => scope.close()], primary, errors => trace({type: 'run.cleanup_failed', status: 'failed', payload: {count: errors.length}}));
      } finally { scopes.delete(resources); }
    }
  }
  return {configured,
    query(input: QueryInput, lease?: QueryRunLease) {
      lease?.onFinalizer?.('host');
      const task = execute(input); pending.add(task); void task.then(() => pending.delete(task), () => pending.delete(task)); return task;
    },
    async close() {
      closed = true; for (const scope of scopes) scope.stop();
      await Promise.allSettled([...pending]);
      await host.close();
    },
  };
}
