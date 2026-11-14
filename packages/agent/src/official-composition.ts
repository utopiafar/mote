import {createHash, randomUUID} from 'node:crypto';
import {PluginHost, PluginResourceScope, type PluginDefinition} from '@mote/plugin-host';
import type {ServiceBinding, ServiceContract, ScopeIdentity} from '@mote/plugin-api/contracts';
import {DEFAULT_MODEL_MAX_TOKENS, type ModelProfile} from '@mote/shared/models';
import type {RuntimeHostCapability} from '@mote/shared/agent-runtimes';
import {toolInputSchema, toRuntimeToolDefinition} from './tools/runtime-schema.js';
import {ActiveExecutionBudget, DEFAULT_AGENT_EXECUTION_TIMEOUT_MS} from './active-budget.js';
import {contextToolDefinitions, pinContextTools, contextToolSnapshot, releaseContextTools} from './tool-contributions.js';
import {taskTools} from './task-context.js';
import {assembleHostContext, settleHostCleanup} from './host/run-session.js';
import {createHostOutputProvider} from './host/output.js';
import {hostOutputService, type HostRunEvent, type HostRunSession} from './host/run-contracts.js';
import {createRuntimeUsageEvents} from './host/runtime-events.js';
import {HOST_DELEGATION_CONTROL_DEFINITIONS} from './host/host-delegation.js';
import {runtimeService, type RuntimeCapabilities, type RuntimeToolCall, type RuntimeToolDefinition} from './runtime/contracts.js';
import {resolveRunSelection, type ResolvedRunSelection, type TrustedRuntimeLaunch} from './runtime/profile.js';
import {DSH_RUNTIME_ID, dshRuntimePlugin, dshModelConfigured, prepareDshRun, type DshModelAdapter} from './runtime/dsh/provider.js';
import {CODEX_RUNTIME_ID, codexRuntimePlugin, prepareCodexRun, type CodexModelAdapter} from './runtime/codex/provider.js';
import {contextToolPayload} from './runtime/dsh/context-plugin.js';
import {ContextToolError} from './tool-errors.js';
import {codexImageMetadata, type ImagePayload} from './tools/image-result.js';
import {startBridge} from './bridge.js';
import {displayTime} from './time.js';
import {CODEX_CONSERVATIVE_CONTEXT_WINDOW} from './runtime/codex/launch.js';
import {harnessPrivacyEntries, resolveModelCapabilities, validateModelOptions} from './models/provider-registry.js';
import {estimateSerializedTokens} from './models/context-budget.js';
import {bundledSkills, SKILL_VERSION} from './skills.js';
import {AgentYieldError} from './host-controls.js';
import {createImportAgent as createRegisteredImportAgent, dshImportCapabilityDescriptor, defaultImportCapabilities} from './import-agent.js';
import {codexImportCapabilityDescriptor} from './codex-import.js';
import {defaultTaskRegistry} from './tasks/registry.js';
import {createRegisteredReadPacks} from './tools/registry.js';
import {AgentInputError, AgentNotConfiguredError, AgentProviderError, AgentResponseError, reportProgress, reportTrace, type AgentOptions, type AgentAnswer, type QueryInput, type QueryRunLease} from './types.js';
import type {ImportAgentLaunch, ImportCapability} from './runtime/import-capability.js';

export const OFFICIAL_AGENT_COMPOSITION_VERSION = '1.0.0' as const;

/** Trusted Host profile configuration shared by every official runtime. */
type RuntimeDependencies = Parameters<typeof prepareDshRun>[1];
type RuntimeAssembly = Parameters<typeof prepareDshRun>[2];

/** One official runtime contribution. A runtime owns the transport-specific
 * model adapter, profile settings, launch values and session preparation; the
 * composition selects it by declared capabilities, never by a protocol branch. */
export interface OfficialAgentRuntimeDescriptor {
  readonly id: string;
  readonly version: string;
  readonly profile: {readonly id: string; readonly name: string};
  readonly capabilities: RuntimeCapabilities;
  readonly configured: (options: AgentOptions) => boolean;
  readonly modelAdapter: (options: AgentOptions) => DshModelAdapter | CodexModelAdapter;
  readonly modelSettings: (options: AgentOptions) => ModelProfile['settings'];
  readonly launch: (options: AgentOptions) => TrustedRuntimeLaunch | undefined;
  /** Codex has no child trace channel; DSH emits its own runtime events. */
  readonly emitHostToolTrace: boolean;
  readonly plugin: (identity: ScopeIdentity, published: (binding: ServiceBinding) => void) => PluginDefinition;
  readonly prepare: (selection: ResolvedRunSelection, dependencies: RuntimeDependencies, assembly: RuntimeAssembly) => Promise<HostRunSession>;
}

export type OfficialAgentContributionId =
  | 'host.output'
  | 'host.usage'
  | 'host.privacy'
  | 'model.adapters'
  | 'runtime.dsh'
  | 'runtime.codex'
  | 'tools.official'
  | 'tasks.official'
  | 'skills.official'
  | 'import.capabilities'
  | 'host.delegation';

export interface OfficialAgentContribution {
  readonly id: OfficialAgentContributionId;
  readonly version: string;
  readonly requires: readonly OfficialAgentContributionId[];
  /** Actual registration/contract check, not a claim that an object exists. */
  readonly verify: () => void;
  readonly runtime?: OfficialAgentRuntimeDescriptor;
}

function dshAdapter(options: AgentOptions): DshModelAdapter {
  const {reader: _reader, runModel: _runModel, contextToolMode: _contextToolMode, codex: _codex, ...adapter} = options;
  return adapter;
}

function codexAdapter(options: AgentOptions): CodexModelAdapter {
  return {model: options.model, contextWindow: options.contextWindow, reasoningEffort: options.reasoningEffort, serviceTier: options.serviceTier,
    ...(options.authorizeModelRequest ? {authorizeModelRequest: options.authorizeModelRequest} : {})};
}

function codexLaunch(options: AgentOptions): TrustedRuntimeLaunch | undefined {
  const launch = Object.fromEntries(Object.entries({executable: options.codex?.executable, home: options.codex?.home}).filter(([, value]) => value !== undefined));
  return Object.keys(launch).length ? launch as TrustedRuntimeLaunch : undefined;
}

export const DSH_OFFICIAL_RUNTIME: OfficialAgentRuntimeDescriptor = Object.freeze<OfficialAgentRuntimeDescriptor>({
  id: DSH_RUNTIME_ID,
  version: '1.0.0',
  profile: {id: 'fixed-dsh', name: 'DSH'},
  capabilities: Object.freeze({modelTransports: ['deepseek', 'openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai'], taskKinds: ['query'], tools: true, images: true, importWorkspace: false, hostDelegation: true, nativeDelegation: false, recovery: 'same-process', replacement: 'restart'}),
  configured: options => dshModelConfigured(dshAdapter(options)),
  modelAdapter: dshAdapter,
  modelSettings: options => ({
    provider: options.provider ?? 'custom', protocol: options.protocol ?? 'deepseek', baseUrl: options.baseUrl ?? '', model: options.model!,
    apiKey: options.apiKey ?? '', headers: options.headers ?? {}, extraBody: options.extraBody ?? {},
    allowUnauthenticatedLocal: options.allowUnauthenticatedLocal ?? false, reasoningEffort: options.reasoningEffort ?? 'auto',
    maxTokens: options.maxTokens ?? DEFAULT_MODEL_MAX_TOKENS, modelRequestTimeoutMs: options.requestTimeoutMs ?? null,
    agentTimeoutMs: options.agentTimeoutMs ?? null,
  }),
  launch: () => undefined,
  emitHostToolTrace: false,
  plugin: (identity, published) => dshRuntimePlugin(identity, {}, published),
  prepare: (selection, dependencies, assembly) => prepareDshRun(selection, dependencies, assembly),
});

export const CODEX_OFFICIAL_RUNTIME: OfficialAgentRuntimeDescriptor = Object.freeze<OfficialAgentRuntimeDescriptor>({
  id: CODEX_RUNTIME_ID,
  version: '1.0.0',
  profile: {id: 'fixed-codex', name: 'Codex'},
  capabilities: Object.freeze({modelTransports: ['codex-app-server'], taskKinds: ['query'], tools: true, images: true, importWorkspace: false, hostDelegation: true, nativeDelegation: false, recovery: 'same-process', replacement: 'restart'}),
  configured: options => Boolean(options.model?.trim()),
  modelAdapter: codexAdapter,
  modelSettings: options => ({
    provider: options.provider ?? 'codex', protocol: options.protocol ?? 'codex-app-server', baseUrl: options.baseUrl ?? '', model: options.model!,
    apiKey: options.apiKey ?? '', headers: options.headers ?? {}, extraBody: options.extraBody ?? {}, allowUnauthenticatedLocal: false,
    reasoningEffort: options.reasoningEffort ?? 'auto', ...(options.serviceTier ? {serviceTier: options.serviceTier} : {}),
    maxTokens: options.maxTokens ?? DEFAULT_MODEL_MAX_TOKENS, modelRequestTimeoutMs: null, agentTimeoutMs: options.agentTimeoutMs ?? null,
  }),
  launch: codexLaunch,
  emitHostToolTrace: true,
  plugin: (identity, published) => codexRuntimePlugin(identity, published),
  prepare: (selection, dependencies, assembly) => prepareCodexRun(selection, dependencies, assembly),
});

function assertRegistered(value: unknown, message: string): void {
  if (!value) throw new Error(message);
}

export const OFFICIAL_AGENT_CONTRIBUTIONS: readonly OfficialAgentContribution[] = Object.freeze([
  {id: 'host.output', version: '1', requires: [], verify: () => assertRegistered(typeof createHostOutputProvider().evaluate === 'function', 'Host output provider is not registered.')},
  {id: 'host.usage', version: '1', requires: ['host.output'], verify: () => assertRegistered(typeof createRuntimeUsageEvents === 'function', 'Host usage normalization is not registered.')},
  {id: 'host.privacy', version: '1', requires: ['model.adapters'], verify: () => {
    const entries = harnessPrivacyEntries() as {id?: unknown}[];
    assertRegistered(entries.some(entry => entry?.id === 'session-log-deepseek') && entries.some(entry => entry?.id === 'plugin-package-inventory-deepseek'), 'Host privacy entries are not registered.');
  }},
  {id: 'model.adapters', version: '1', requires: [], verify: () => {
    assertRegistered(typeof DSH_OFFICIAL_RUNTIME.modelAdapter === 'function' && typeof CODEX_OFFICIAL_RUNTIME.modelAdapter === 'function', 'Model adapters are not registered.');
  }},
  {id: 'runtime.dsh', version: DSH_OFFICIAL_RUNTIME.version, requires: ['model.adapters', 'host.output', 'tools.official', 'tasks.official', 'skills.official', 'host.delegation'], verify: () => assertRegistered(DSH_OFFICIAL_RUNTIME.capabilities.taskKinds.includes('query') && typeof DSH_OFFICIAL_RUNTIME.plugin === 'function', 'DSH runtime is not registered.'), runtime: DSH_OFFICIAL_RUNTIME},
  {id: 'runtime.codex', version: CODEX_OFFICIAL_RUNTIME.version, requires: ['model.adapters', 'host.output', 'tools.official', 'tasks.official', 'skills.official', 'host.delegation'], verify: () => assertRegistered(CODEX_OFFICIAL_RUNTIME.capabilities.taskKinds.includes('query') && typeof CODEX_OFFICIAL_RUNTIME.plugin === 'function', 'Codex runtime is not registered.'), runtime: CODEX_OFFICIAL_RUNTIME},
  {id: 'tools.official', version: '1', requires: [], verify: () => assertRegistered(createRegisteredReadPacks({}).length > 0, 'Official read packs are not registered.')},
  {id: 'tasks.official', version: '1', requires: [], verify: () => assertRegistered(defaultTaskRegistry.prepare({question: 'Generated official composition probe'}).id.length > 0, 'Official task packs are not registered.')},
  {id: 'skills.official', version: SKILL_VERSION, requires: ['tasks.official'], verify: () => {
    assertRegistered(bundledSkills.length >= 9, 'Official skills are not registered.');
    for (const skill of bundledSkills) defaultTaskRegistry.skill(skill.id);
  }},
  {id: 'import.capabilities', version: '1', requires: ['model.adapters', 'host.output', 'tasks.official', 'skills.official'], verify: () => {
    assertRegistered(dshImportCapabilityDescriptor.protocols.length > 0 && codexImportCapabilityDescriptor.protocols.length > 0, 'Official import capabilities are not registered.');
    defaultImportCapabilities.descriptor('deepseek');
    defaultImportCapabilities.descriptor('codex-app-server');
  }},
  {id: 'host.delegation', version: '1', requires: ['tools.official', 'tasks.official'], verify: () => assertRegistered(HOST_DELEGATION_CONTROL_DEFINITIONS.length > 0, 'Host delegation controls are not registered.')},
]);

export interface OfficialAgentCompositionSelection {
  /** Exact enabled base contributions. Omitted means the complete official set. */
  readonly available?: readonly OfficialAgentContributionId[];
}

export type OfficialAgentCompositionResolution =
  | {readonly available: true; readonly contributions: readonly OfficialAgentContribution[]; readonly runtimes: readonly OfficialAgentRuntimeDescriptor[]}
  | {readonly available: false; readonly code: 'official_composition_unavailable'; readonly missing: readonly OfficialAgentContributionId[]; readonly reason: string};

export class OfficialCompositionUnavailableError extends Error {
  readonly statusCode = 503;
  readonly code = 'official_composition_unavailable' as const;
  constructor(readonly missing: readonly string[], message = 'The official agent composition is unavailable.') {
    super(message);
    this.name = 'OfficialCompositionUnavailableError';
  }
}

/** Pure static resolution. There is no fallback list: any missing base
 * contribution makes the whole official composition unavailable. */
export function resolveOfficialAgentComposition(selection: OfficialAgentCompositionSelection = {}): OfficialAgentCompositionResolution {
  const declared = OFFICIAL_AGENT_CONTRIBUTIONS.map(contribution => contribution.id);
  const enabled = new Set(selection.available ?? declared);
  const missing = declared.filter(id => !enabled.has(id));
  if (missing.length) return {available: false, code: 'official_composition_unavailable', missing, reason: 'A required official base contribution is not enabled.'};
  const unknown = [...enabled].filter(id => !declared.includes(id));
  if (unknown.length) return {available: false, code: 'official_composition_unavailable', missing: unknown, reason: 'The selection contains an unknown official contribution.'};
  for (const contribution of OFFICIAL_AGENT_CONTRIBUTIONS) {
    const absent = contribution.requires.filter(id => !enabled.has(id));
    if (absent.length) return {available: false, code: 'official_composition_unavailable', missing: absent, reason: `Contribution ${contribution.id} has a missing base dependency.`};
  }
  try {
    for (const contribution of OFFICIAL_AGENT_CONTRIBUTIONS) contribution.verify();
  } catch (error) {
    return {available: false, code: 'official_composition_unavailable', missing: [], reason: error instanceof Error ? error.message : 'Official registration verification failed.'};
  }
  const runtimes = OFFICIAL_AGENT_CONTRIBUTIONS.flatMap(contribution => contribution.runtime ? [contribution.runtime] : []);
  return {available: true, contributions: OFFICIAL_AGENT_CONTRIBUTIONS, runtimes};
}

function selectOfficialRuntime(runtimes: readonly OfficialAgentRuntimeDescriptor[], options: AgentOptions): OfficialAgentRuntimeDescriptor {
  const protocol = options.protocol ?? 'deepseek';
  const matches = runtimes.filter(runtime => runtime.capabilities.modelTransports.includes(protocol) && runtime.capabilities.taskKinds.includes('query'));
  if (matches.length !== 1) throw new OfficialCompositionUnavailableError([`runtime:${protocol}`],
    matches.length ? 'The official agent composition has an ambiguous runtime for this model transport.' : 'No official runtime supports this model transport.');
  return matches[0]!;
}

class AgentClosedError extends Error { constructor() { super('Agent is closed'); } }
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
// Private fixed-configuration adapter; the dynamic model plugin/transaction is A10/A09.
const fixedModelService: ServiceContract<DshModelAdapter | CodexModelAdapter> = {id: 'mote.agent.fixed-model', apiVersion: '1'};

/** Public fixed-settings facade. The official composition installs every
 * registered runtime and resolves one by its declared model transport. */
export function createAgent(original: AgentOptions): {
  readonly configured: boolean;
  query(input: QueryInput, lease?: QueryRunLease): Promise<AgentAnswer>;
  close(): Promise<void>;
} {
  return createOfficialAgent(original);
}

export function createOfficialAgent(original: AgentOptions, selection: OfficialAgentCompositionSelection = {}): {
  readonly configured: boolean;
  query(input: QueryInput, lease?: QueryRunLease): Promise<AgentAnswer>;
  close(): Promise<void>;
} {
  const composition = resolveOfficialAgentComposition(selection);
  if (!composition.available) throw new OfficialCompositionUnavailableError(composition.missing, composition.reason);
  const runtimes = composition.runtimes;
  validateModelOptions(original);
  const options = {...original, headers: original.headers && {...original.headers}, extraBody: original.extraBody && structuredClone(original.extraBody)};
  const selectedRuntime = selectOfficialRuntime(runtimes, options);
  const modelAdapter = selectedRuntime.modelAdapter(options);
  const configured = selectedRuntime.configured(options);
  const skills = Object.freeze(bundledSkills.filter(skill => skill.availability !== 'import').map(skill => Object.freeze({...skill})));
  const skillTool = Object.freeze({name: 'skill', version: SKILL_VERSION, fingerprint: hash(skills),
    description: 'Load the full instructions for a Host-granted bundled skill. Available skills:\n' + skills.map(skill => `${skill.name}: ${skill.description}`).join('\n'),
    inputSchema: {type: 'object', properties: {name: {type: 'string', enum: skills.map(skill => skill.name)}}, required: ['name'], additionalProperties: false},
  });
  const hostIdentity = {kind: 'central' as const, id: randomUUID()};
  const identity = (id: string): ScopeIdentity => ({packageId: id, installationId: hostIdentity.id, instanceId: id, activationId: randomUUID(), host: hostIdentity});
  const host = new PluginHost(hostIdentity);
  const runtimeIdentities = new Map(runtimes.map(runtime => [runtime.id, identity(runtime.id)]));
  const runtimeBindings = new Map<string, ServiceBinding>();
  const foundationIdentity = identity('mote.agent.foundation');
  let closed = false, startup: Promise<void> | undefined;
  let modelBinding: ServiceBinding, outputBinding: ServiceBinding;
  const pending = new Set<Promise<AgentAnswer>>(), scopes = new Set<PluginResourceScope>();
  const initialize = () => startup ??= (async () => {
    for (const runtime of runtimes) {
      const runtimeIdentity = runtimeIdentities.get(runtime.id)!;
      await host.install(runtime.plugin(runtimeIdentity, binding => { runtimeBindings.set(runtime.id, binding); }));
    }
    if (!runtimeBindings.has(selectedRuntime.id)) throw new OfficialCompositionUnavailableError([selectedRuntime.id], 'The selected official runtime did not publish its service.');
    await host.install({identity: foundationIdentity, contributions: [fixedModelService, hostOutputService], factory(context) {
      return {prepare() {}, start() {
        modelBinding = context.provide(fixedModelService.id, fixedModelService, modelAdapter);
        outputBinding = context.provide(hostOutputService.id, hostOutputService, createHostOutputProvider());
      }, quiesce() {}, stop() {}, dispose() {}};
    }});
  })();
  async function execute(raw: QueryInput): Promise<AgentAnswer> {
    const input = pinContextTools({...raw, ...(raw.evidenceReadRanges ? {evidenceReadRanges: Object.freeze(raw.evidenceReadRanges.map(range => Object.freeze({...range})))} : {}), ...(options.contextToolMode ? {hostContextToolMode: options.contextToolMode} : {})}, options.reader);
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
      const runtime = await host.acquire(runtimeService, runtimeBindings.get(selectedRuntime.id)!, signal); scope.defer(() => runtime.release());
      const modelPort = await host.acquire(fixedModelService, modelBinding!, signal); scope.defer(() => modelPort.release());
      const selectedIdentity = runtimeIdentities.get(selectedRuntime.id)!;
      const allowedHostCapabilities: RuntimeHostCapability[] = ['tools', ...(selectedRuntime.capabilities.images ? ['images' as const] : []), ...(selectedRuntime.capabilities.hostDelegation ? ['hostDelegation' as const] : [])];
      const launch = selectedRuntime.launch(options);
      const selection = resolveRunSelection({revision: 0,
        profile: {id: selectedRuntime.profile.id, name: selectedRuntime.profile.name, revision: 0, runtimeProviderId: selectedRuntime.id, providerRef: {service: runtime.binding.service, revision: runtime.binding.revision, provider: {instance: {packageId: selectedIdentity.packageId, installationId: selectedIdentity.installationId, instanceId: selectedIdentity.instanceId}, contributionId: runtime.binding.provider.contributionId}}, assembly: {packages: [], hooks: []}, allowedHostCapabilities},
        providers: runtimes.map(candidate => ({id: candidate.id, binding: runtimeBindings.get(candidate.id)!, capabilities: candidate.capabilities, availability: {state: 'active' as const}})), installedModules: [],
        model: {profile: {id: 'fixed-model', name: 'Fixed model', settings: selectedRuntime.modelSettings(options)}, profileRevision: 0, modelRevision: 0, connectionFingerprint: hash(modelAdapter), capabilities: {tools: true, images: true}},
        // This fixed-settings facade mirrors the existing model adapter's
        // declared tool and text/image surface. Catalogue discovery and dynamic
        // model/configuration revisions remain with A10/A09.
        requirements: {taskKind: 'query', capabilities: ['tools']},
        ...(launch ? {launch} : {}),
      });
      bridge = await startBridge(options.reader, {...input, signal, onTrace: trace}, options.maxToolCalls); assertCurrent();
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
      const traceTool = (event: Parameters<typeof reportTrace>[1]) => { if (selectedRuntime.emitHostToolTrace) trace(event); };
      // Both an explicit conservative conversation budget and a background run
      // without a per-run budget use the same native default. Applying the HTTP
      // fallback here can reject full Memory targets before App Server starts.
      // The native gate still intersects this window with the actual catalog;
      // configured per-run and model windows remain pinned.
      const codexConservative=selectedRuntime.id===CODEX_RUNTIME_ID&&(input.modelBudget?.contextWindowSource==='conservative'||!input.modelBudget&&options.contextWindow===undefined);
      const capacity=input.modelBudget??resolveModelCapabilities(options);
      const window=codexConservative?CODEX_CONSERVATIVE_CONTEXT_WINDOW:capacity.contextWindow,outputReserve='maxOutputTokens' in capacity?capacity.maxOutputTokens:capacity.maxTokens;
      // This is a conservative pre-delivery allowance. The HTTP adapter checks
      // its complete, actual serialized body again for every provider turn.
      const initialEstimate=estimateSerializedTokens({system,tools:definitions,prompt}).tokens;
      // Early Host allowance only. The required Mote native dependency checks
      // each complete provider request again, including internal continuations,
      // using its documented model output ceiling rather than Host maxTokens.
      if(selectedRuntime.id===CODEX_RUNTIME_ID&&initialEstimate+outputReserve>window)throw new AgentProviderError({category:'permanent',code:'processing_limit',executionStarted:false},{source:'runtime',stage:'startup',code:'contextWindowExceeded',modelId:options.model});
      let toolRemaining=Math.max(0,window-outputReserve-initialEstimate-2048);
      const controlled=new Set((input.hostControlChannel?.definitions??[]).map(tool=>tool.name));
      const paged=new Set(['evidence','context_evidence','material_read','attribution_context']);
      const omitted=()=>({text:JSON.stringify({budgetCoverage:{truncated:true,delivered:false,reason:'The tool result did not fit the remaining model context. No result content was delivered. Request a smaller page or use already delivered evidence.'}})});

      const readHostTool = async (call: RuntimeToolCall, toolSignal: AbortSignal) => {
        traceTool({type: 'tool.started', stage: 'tool', phase: 'started', tool: call.name, payload: {arguments: call.arguments}});
        try {
          if (!call.arguments || typeof call.arguments !== 'object' || Array.isArray(call.arguments)) throw new ContextToolError('invalid_tool_arguments', 'Expected object arguments.', 'correct_arguments');
          toolRemaining=Math.max(0,toolRemaining-estimateSerializedTokens({name:call.name,arguments:call.arguments}).tokens-128);
          if (call.name === skillTool.name) {
            const args = call.arguments as Record<string, unknown>, skill = skills.find(skill => skill.name === args.name);
            if (Object.keys(args).some(key => key !== 'name') || !skill) throw new ContextToolError('invalid_tool_arguments', 'Use an exact Host-granted skill name.', 'correct_arguments');
            const result = {name: skill.name, content: skill.content};
            traceTool({type: 'tool.completed', stage: 'tool', phase: 'completed', tool: call.name, status: 'succeeded', payload: {result}});
            const payload={text:skill.content},tokens=estimateSerializedTokens(payload).tokens;
            if(tokens>toolRemaining)return {payload:omitted(),confirm(){},discard(){}};
            return {payload, confirm(){toolRemaining-=tokens;}, discard() {}};
          }
          const original=call.arguments as Record<string, unknown>;
          let args=original,truncated=false;
          let staged = await bridge!.prepareDelivery(call.name, args, toolSignal);
          try {
            let payload = contextToolPayload(staged.value);
            // First measure the actual staged result. Only if it cannot fit do
            // we discard its private receipt and reread a smaller real page.
            // The replay is the same logical tool call and never grants the
            // discarded page's ranges or consumes an extra tool-call allowance.
            for(let attempt=0;attempt<3&&paged.has(call.name)&&estimateSerializedTokens(payload).tokens>toolRemaining;attempt++){
              const prior=typeof args.length==='number'?args.length:(call.name==='attribution_context'?8000:call.name==='evidence'?2000:4000);
              const measured=estimateSerializedTokens(payload).tokens;
              const length=Math.max(1,Math.min(prior-1,Math.floor(prior*Math.max(0,toolRemaining-256)/Math.max(1,measured)*0.75)));
              if(prior<=1)break;
              staged.discard();args={...original,length};truncated=true;
              staged=await bridge!.prepareDelivery(call.name,args,toolSignal,{replay:true});
              payload=contextToolPayload(staged.value);
            }
            if(truncated){
              const value=JSON.parse(payload.text) as Record<string,unknown>;
              payload={...payload,text:JSON.stringify({...value,budgetCoverage:{truncated:true,requestedLength:original.length??null,deliveredLength:args.length,instruction:'The host shortened this page for the model context budget. Follow the returned continuation to inspect more; the unread tail is not evidence.'}})};
            }
            const payloadTokens=estimateSerializedTokens(payload).tokens;
            if(!controlled.has(call.name)&&payloadTokens>toolRemaining){
              staged.discard();
              return {payload:omitted(),confirm(){},discard(){}};
            }
            // The model receives the image, but diagnostics only need its identity
            // and size. Copying base64 into traces duplicates private originals and
            // can overwhelm the log viewer even when the read itself is bounded.
            const image = call.name === 'read_image' && (staged.value as ImagePayload | undefined)?.image;
            const result = image ? {...codexImageMetadata(staged.value as ImagePayload), image: {mimeType: image.mimeType, encodedCharacters: image.data.length}} : staged.value;
            traceTool({type: 'tool.completed', stage: 'tool', phase: 'completed', tool: call.name, status: 'succeeded', payload: {result}});
            return {payload, confirm(){staged.confirm();toolRemaining=Math.max(0,toolRemaining-payloadTokens);}, discard: staged.discard};
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
      // The saved conversation preference is per run, not a mutable change to
      // the shared model service or its configured output limit.
      const modelValue = input.modelBudget
        ? {...modelPort.value, contextWindow: codexConservative ? CODEX_CONSERVATIVE_CONTEXT_WINDOW : input.modelBudget.contextWindow}
        : modelPort.value;
      const dependencies = {runId, scope, input, runtime, model: {...modelPort, value: modelValue, selection: selection.modelSelection}, output,
        tools: {definitions, bindings: [], assertCurrent:assertToolPins}, commitFence: {assertCurrent:assertToolPins},
        budget: {activeTimeoutMs: options.agentTimeoutMs === undefined ? DEFAULT_AGENT_EXECUTION_TIMEOUT_MS : options.agentTimeoutMs},
        activeBudget: new ActiveExecutionBudget(options.agentTimeoutMs === undefined ? DEFAULT_AGENT_EXECUTION_TIMEOUT_MS : options.agentTimeoutMs),
      };
      const assembly = {systemPrompt: system, prompt, outputSchema, contextUsage: {...metrics, toolResults: 0}, maxTokens: options.maxTokens,
        evidence: () => bridge!, readTool: readHostTool,
        admit: <T>(task: () => Promise<T>, admissionSignal: AbortSignal) => options.runModel ? options.runModel(task, admissionSignal) : task(),
        close: closeBridge, observe: observeHostRun, trace,
        cleanupFailed: (errors: readonly unknown[]) => trace({type: 'run.cleanup_failed', status: 'failed', payload: {count: errors.length}}),
      };
      session = await selectedRuntime.prepare(selection, dependencies, assembly);
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

/** Official fixed-settings import facade. The registered capabilities select a
 * transport; the caller never imports a provider branch. */
export function createOfficialImportAgent(options: Omit<AgentOptions, 'reader'>, prepareLaunch?: ImportAgentLaunch, selection: OfficialAgentCompositionSelection = {}): ImportCapability {
  const composition = resolveOfficialAgentComposition(selection);
  if (!composition.available) throw new OfficialCompositionUnavailableError(composition.missing, composition.reason);
  return createRegisteredImportAgent(options, prepareLaunch);
}

export {createOfficialImportAgent as createImportAgent};
