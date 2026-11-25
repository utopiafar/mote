import {DeepSeekHarness, JsonRpcResponseError, RequestTimeoutError, type HarnessNotification} from '@deepseek-ai/dsh-sdk-client';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {fileURLToPath} from 'node:url';
import type {PluginDefinition} from '@mote/plugin-host';
import type {Cancellation, ScopeIdentity, ServiceBinding} from '@mote/plugin-api/contracts';
import {DEFAULT_MODEL_MAX_TOKENS,OPENCODE_GO_PROVIDER} from '@mote/shared/models';
import {ProviderFailure,errorDiagnostics,sanitizeFailureDiagnostics,type FailureDiagnostics} from '@mote/shared';
import {AgentProviderError, AgentResponseError, AgentTimeoutError} from '../../types.js';
import {createDshModelAdapter, type DshModelAdapter} from '../../models/dsh-adapter.js';
import {resolveModelCapabilities} from '../../models/provider-registry.js';
import {estimateSerializedTokens} from '../../models/context-budget.js';
import {observeHarness} from '../../usage.js';
import {runtimeService, type RuntimeProvider, type RuntimeHandle, type RuntimeRunRequest, type RuntimeOutcome, type RuntimeAttempt} from '../contracts.js';
import type {ResolvedRunSelection, RuntimeProfileConfiguration} from '../profile.js';
import {createHostRunSession, type HostSessionAssembly} from '../../host/run-session.js';
import type {HostRunDependencies} from '../../host/run-contracts.js';
import {createDshHostChannel} from './context-plugin.js';
import {AgentYieldError} from '../../host-controls.js';
import {ContextToolError} from '../../tool-errors.js';
import {DSH_RUNTIME_ID, compileNativeDshProfile, createRuntimePatch, DshProfileError, type InstalledDshModule} from './profile-compiler.js';
import type {NativeDshApplication} from './application-contracts.js';

export {DSH_RUNTIME_ID, DshProfileError, createRuntimePatch} from './profile-compiler.js';
export type {InstalledDshModule, NativeDshAssemblyBinding} from './profile-compiler.js';
export type {NativeDshApplication, NativeApplicationContext, NativeApplicationExposure} from './application-contracts.js';
export {readNativeDshManifest, nativeDshEntrySpecifier, planNativeDshAssembly} from './native-assembly.js';

export {dshModelConfigured, type DshModelAdapter} from '../../models/dsh-adapter.js';
export interface DshProviderOptions {
  readonly installedModules?: readonly InstalledDshModule[] | (() => readonly InstalledDshModule[] | Promise<readonly InstalledDshModule[]>);
  readonly applicationForRun?: (runId:string)=>NativeDshApplication|undefined;
  /** Safe lifecycle observation for selected local integration checks. */
  readonly resourceObserver?: (event: {type: 'created' | 'closed'; runId: string; root: string}) => void;
}

/** Assemble only an already resolved selection with real Host-owned leases.
 * Configuration admission/persistence and model adapter construction remain outside this provider. */
function sdkTerminalDiagnostics(reason: {kind?: unknown; error?: {code?: unknown; status?: unknown; requestId?: unknown}} | undefined): FailureDiagnostics {
  const failure = reason?.kind === 'error' ? reason.error : undefined;
  const diagnostic = sanitizeFailureDiagnostics({source:'runtime',stage:'model',sdkTerminal:reason?.kind,
    sdkErrorCode:failure?.code,httpStatus:failure?.status,upstreamRequestId:failure?.requestId});
  if (!diagnostic.sdkTerminal) diagnostic.code = reason ? 'sdk_end_unrecognized' : 'sdk_end_missing';
  return diagnostic;
}
function sdkExceptionDiagnostics(error: unknown, stage: 'startup' | 'model'): FailureDiagnostics {
  const diagnostic = errorDiagnostics(error);
  return sanitizeFailureDiagnostics({...diagnostic,source:diagnostic.source==='unknown'?'runtime':diagnostic.source,
    stage:diagnostic.stage??stage,...(error instanceof JsonRpcResponseError?{rpcCode:error.code}:{})});
}

export function prepareDshRun(selection: ResolvedRunSelection, dependencies: Omit<HostRunDependencies, 'profile' | 'identity'> & {readonly runId: string}, assembly: HostSessionAssembly) {
  if (selection.runtime.runtimeId !== DSH_RUNTIME_ID || !isDeepStrictEqual(selection.modelSelection, dependencies.model.selection)) throw new DshProfileError('dsh_profile_invalid');
  const {runId, ...ports} = dependencies, profile = selection.runtime;
  return createHostRunSession({...ports, profile, identity: {runId, runtime: {id: profile.runtimeId, revision: profile.binding.revision, profileId: profile.profileId, profileRevision: profile.profileRevision, assemblyFingerprint: profile.assemblyFingerprint}, model: selection.modelSelection}}, assembly);
}

/** One real SDK child per handle. Runtime/provider objects own all private resources;
 * Host keeps model/output leases, data authority, active budget and result construction. */
export function createDshRuntimeProvider(options: DshProviderOptions = {}) {
  let accepting = true, stopped = false;
  const handles = new Set<RuntimeHandle>(), preparations = new Set<Promise<RuntimeHandle>>(), abortPreparations = new Set<() => void>();
  let closing: Promise<void> | undefined;
  const observe = (event: Parameters<NonNullable<DshProviderOptions['resourceObserver']>>[0]) => { try { options.resourceObserver?.(event); } catch { /* Observation is not authority. */ } };
  const provider: RuntimeProvider<RuntimeProfileConfiguration, DshModelAdapter> = {
    capabilities: Object.freeze({modelTransports: ['deepseek', 'openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai'], taskKinds: ['query'], tools: true, images: true, importWorkspace: false, hostDelegation: true, nativeDelegation: false, recovery: 'same-process', replacement: 'restart'}),
    prepare(profile, model, host) {
      if (!accepting || stopped) return Promise.reject(new AgentProviderError({category: 'blocked', code: 'runtime_unavailable', executionStarted: false}));
      const preparing = (async (): Promise<RuntimeHandle> => {
        if (typeof host.systemPrompt !== 'string' || !host.systemPrompt.trim()) throw new DshProfileError('dsh_profile_invalid');
        const modelAdapter = createDshModelAdapter(model, host), adapter = modelAdapter.value;
        if (adapter.model !== model.selection.modelId || (adapter.protocol ?? 'deepseek') !== model.selection.transport || !isDeepStrictEqual(model.selection, host.identity.model) ||
            host.identity.runtime.id !== profile.runtimeId || host.identity.runtime.profileId !== profile.profileId || host.identity.runtime.profileRevision !== profile.profileRevision || host.identity.runtime.assemblyFingerprint !== profile.assemblyFingerprint || !provider.capabilities.taskKinds.includes(profile.taskKind)) throw new DshProfileError('dsh_profile_invalid');
        const installed = typeof options.installedModules === 'function' ? await options.installedModules() : options.installedModules ?? [];
        const native = await compileNativeDshProfile(profile, installed);
        const application=options.applicationForRun?.(host.identity.runId),sessionId=application?.sessionId??host.identity.runId;
        host.assertCurrent();
        const root = await mkdtemp(join(tmpdir(), 'mote-dsh-runtime-'));
        observe({type: 'created', runId: host.identity.runId, root});
        let channel: Awaited<ReturnType<typeof createDshHostChannel>> | undefined, observer: Awaited<ReturnType<typeof modelAdapter.start>> | undefined, harness: DeepSeekHarness | undefined;
        let active: RuntimeAttempt | undefined, cancellation: Cancellation | undefined, released = false;
        let task: Promise<RuntimeOutcome> | undefined, closed: Promise<void> | undefined;
        const turns = new Map<number, RuntimeAttempt>();
        const connection = modelAdapter.connection;
        const closeResources = () => closed ??= (async () => {
          released = true;
          const results = await Promise.allSettled([Promise.resolve().then(() => harness?.close()), Promise.resolve().then(() => channel?.close()), modelAdapter.dispose()]);
          await Promise.allSettled(task ? [task] : []);
          host.signal.removeEventListener('abort', abort);
          abortPreparations.delete(abort);
          const removed = await Promise.allSettled([rm(root, {recursive: true, force: true})]);
          observe({type: 'closed', runId: host.identity.runId, root});
          const failures = [...results, ...removed].flatMap(result => result.status === 'rejected' ? [result.reason] : []);
          if (failures.length) throw failures.find(error => error instanceof AgentResponseError) ?? new AgentProviderError();
        })();
        const abort = () => { cancellation ??= {kind: 'cancelled'}; void harness?.close().catch(() => {}); };
        abortPreparations.add(abort);
        host.signal.addEventListener('abort', abort, {once: true});
        try {
          channel = await createDshHostChannel(host,sessionId);
          observer = await modelAdapter.start(adapter.provider === OPENCODE_GO_PROVIDER.id ? usage => {
            if (active) host.emit({type: 'opencode.request_usage', usage}, active);
          } : undefined);
          const workspace=application?.workspace??join(root,'workspace'),home=application?.home??join(root,'home');
          await mkdir(workspace,{recursive:true});
          const patch = join(root, 'runtime.patch.json');
          const entry = fileURLToPath(new URL('../../plugin.mjs', import.meta.url));
          await writeFile(patch, createRuntimePatch(entry, adapter.model!, adapter.baseUrl, adapter.reasoningEffort, adapter.maxTokens, adapter, host.systemPrompt, native,Boolean(application)), {mode: 0o600});
          host.assertCurrent(); if (stopped) throw new AgentProviderError();
          harness = new DeepSeekHarness({profile: 'sdk-minimal', patches: [patch], dshHome: home, cwd: workspace, processCwd: workspace,
            provider: connection.route, model: adapter.model!, maxTokens: adapter.maxTokens ?? DEFAULT_MODEL_MAX_TOKENS, initializeTimeoutMs: 30_000, requestTimeoutMs: adapter.requestTimeoutMs ?? 120_000,
            env: {PATH: process.env.PATH, TMPDIR: tmpdir(), HOME: home, DEEPSEEK_API_KEY: adapter.apiKey || 'mote-local-no-auth', DEEPSEEK_BASE_URL: connection.baseUrl, MOTE_MODEL_API_KEY: adapter.apiKey || 'mote-local-no-auth',
              MOTE_HOST_RUN: JSON.stringify(channel.configuration), MOTE_MODEL_OBSERVER: JSON.stringify(observer.configuration),
              MOTE_MODEL_TRANSPORT: JSON.stringify({
                baseUrl: connection.baseUrl, protocol: connection.protocol, sessionId,
                reasoningEffort: connection.effort, provider: adapter.provider,
                headers: adapter.headers, extraBody: adapter.extraBody,
                contextWindow: resolveModelCapabilities(adapter).contextWindow,
                maxTokens: resolveModelCapabilities(adapter).maxOutputTokens,
              }),
              ...Object.fromEntries((['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'all_proxy', 'no_proxy', 'NODE_USE_ENV_PROXY', 'SystemRoot'] as const).filter(key => process.env[key]).map(key => [key, process.env[key]!])),
            },
          });
          await Promise.race([harness.start(), channel.failure, observer.failure]);
          host.assertCurrent(); if (stopped) throw new AgentProviderError();
          const usage = observeHarness({question: '', onUsage(value) { if (active) host.emit({type: 'usage', usage: value}, active); }, onProgress(value) { if (active) host.emit({type: 'progress', progress: value}, active); }}, sessionId, connection.protocol !== 'deepseek');
          const notification = (value: HarnessNotification) => {
            if (value.method !== 'session.event' || value.params.sessionId !== sessionId) return;
            const event = value.params.event as {type: string; data?: {
              turn?: number; callId?: string; name?: string; arguments?: string;
              message?: {content?: readonly {type?: string; text?: string}[]};
            }};
            if (event.type === 'turn/start' && active && Number.isSafeInteger(event.data?.turn)) turns.set(event.data!.turn!, active);
            if (event.type === 'assistant/message' && active && turns.get(event.data?.turn ?? -1) === active) {
              const content = event.data?.message?.content;
              if (Array.isArray(content)) {
                // Tool names and arguments are charged when the Host prepares the call.
                const text = content.filter(block => (block?.type === 'text' || block?.type === 'reasoning') && typeof block.text === 'string');
                if (text.length) {
                  try { host.reserveAssistantContext?.(active, estimateSerializedTokens(text).tokens); }
                  catch { /* A settled attempt cannot charge a later read. */ }
                }
              }
            }
            if (event.type === 'tool/call' && typeof event.data?.callId === 'string' && typeof event.data.name === 'string') {
              const attempt = turns.get(event.data.turn!);
              if (attempt) {
                try { channel!.bindCall(event.data.turn!, event.data.callId, event.data.name, attempt, JSON.parse(event.data.arguments!)); }
                catch { /* Invalid native JSON cannot acquire a matching Host call. */ }
              }
            }
            try { usage(value); } catch { /* Host rejects late observations after an attempt settles. */ }
          };
          const drive = (request: RuntimeRunRequest): Promise<RuntimeOutcome> => {
            if (active || released || stopped) return Promise.reject(new AgentProviderError());
            host.assertCurrent(); active = request.attempt;
            task = (async () => {
              try {
                const result = await host.runModel(request.attempt, () => Promise.race([harness!.run(request.prompt, {sessionId, onNotification: notification}), channel!.failure, observer!.failure]));
                const end = result.events && [...result.events].reverse().find(event => event.type === 'turn/end');
                const reason = (end?.data as {reason?: {kind?: unknown; error?: {code?: unknown; status?: unknown; requestId?: unknown}}} | undefined)?.reason;
                if (reason?.kind === 'completed') return {terminal: {kind: 'completed'}, candidate: {text: result.finalResponse}};
                if (reason?.kind === 'aborted') return {terminal: {kind: 'cancelled', cause: cancellation?.kind ?? 'cancelled'}};
                const diagnostic = sdkTerminalDiagnostics(reason);
                if (reason?.kind === 'max-tokens') return {terminal: {kind: 'output_limit'}, candidate: {text: result.finalResponse}, diagnostic};
                return {terminal: {kind: 'failed', reason: 'provider_error'}, diagnostic};
              } catch (error) {
                if (cancellation || host.signal.aborted) return {terminal: {kind: 'cancelled', cause: cancellation?.kind ?? 'cancelled'}};
                if (error instanceof AgentYieldError) return {terminal: {kind: 'yielded'}};
                if(error instanceof AgentTimeoutError)throw error;
                if(error instanceof RequestTimeoutError)throw new AgentTimeoutError({source:'http',code:'request_timeout',errorType:'RequestTimeoutError',stage:'model'});
                // Host admission and validation failures stay primary and keep
                // their identity; the run terminal must not replace them with a
                // generic provider or tool failure.
                if (error instanceof ProviderFailure || error instanceof AgentResponseError) throw error;
                if (error instanceof ContextToolError && error.recovery === 'stop') return {terminal: {kind: 'failed', reason: 'tool_failure'}};
                throw new AgentProviderError(undefined,sdkExceptionDiagnostics(error, 'model'));
              } finally { active = undefined; }
            })();
            return task;
          };
          const handle: RuntimeHandle = {run: drive, repair: drive,
            async cancel(cause) { cancellation ??= cause; await harness?.close(); },
            async close() { try { await closeResources(); } finally { handles.delete(handle); } },
          };
          handles.add(handle); return handle;
        } catch (error) {
          await closeResources().catch(() => {});
          if (error instanceof AgentResponseError || error instanceof AgentTimeoutError || error instanceof DshProfileError || error instanceof ProviderFailure) throw error;
          if (error instanceof RequestTimeoutError) throw new AgentTimeoutError();
          throw new AgentProviderError(undefined,sdkExceptionDiagnostics(error, 'startup'));
        }
      })();
      preparations.add(preparing); void preparing.then(() => preparations.delete(preparing), () => preparations.delete(preparing)); return preparing;
    },
  };
  return Object.assign(provider, {
    quiesce() { accepting = false; },
    close() { return closing ??= (async () => { accepting = false; stopped = true; for (const abort of abortPreparations) abort(); await Promise.allSettled([...preparations]); const results = await Promise.allSettled([...handles].map(handle => handle.cancel({kind: 'scope_stopped'}).finally(() => handle.close()))); if (results.some(result => result.status === 'rejected')) throw new AgentProviderError(); })(); },
  });
}

/** Official contribution factory; creation, publishing and teardown share one owner. */
export function dshRuntimePlugin(identity: ScopeIdentity, options: DshProviderOptions = {}, published?: (binding: ServiceBinding) => void): PluginDefinition {
  return {identity, contributions: [runtimeService], restartRequired: true, factory(context) {
    const provider = createDshRuntimeProvider(options);
    context.scope.defer(() => provider.close());
    return {prepare() {}, start() { const binding = context.provide(runtimeService.id, runtimeService, provider); published?.(binding); }, quiesce() { provider.quiesce(); }, stop() { return provider.close(); }, dispose() { return provider.close(); }};
  }};
}
