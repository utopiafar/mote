import {DeepSeekHarness, RequestTimeoutError, type HarnessNotification} from '@deepseek-ai/dsh-sdk-client';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {fileURLToPath} from 'node:url';
import type {PluginDefinition} from '@mote/plugin-host';
import type {Cancellation, ScopeIdentity, ServiceBinding} from '@mote/plugin-api/contracts';
import {DEFAULT_MODEL_MAX_TOKENS} from '@mote/shared/models';
import {ProviderFailure} from '@mote/shared';
import {AgentProviderError, AgentResponseError, AgentTimeoutError} from '../../types.js';
import {createDshModelAdapter, type DshModelAdapter} from '../../models/dsh-adapter.js';
import {observeHarness} from '../../usage.js';
import {runtimeService, type RuntimeProvider, type RuntimeHandle, type RuntimeRunRequest, type RuntimeOutcome, type RuntimeAttempt} from '../contracts.js';
import type {ResolvedRunSelection, RuntimeProfileConfiguration} from '../profile.js';
import {createHostRunSession, type HostSessionAssembly} from '../../host/run-session.js';
import type {HostRunDependencies} from '../../host/run-contracts.js';
import {createDshHostChannel} from './context-plugin.js';
import {AgentYieldError} from '../../host-controls.js';
import {ContextToolError} from '../../tool-errors.js';
import {DSH_RUNTIME_ID, compileNativeDshProfile, createRuntimePatch, DshProfileError, type InstalledDshModule} from './profile-compiler.js';

export {DSH_RUNTIME_ID, DshProfileError, createRuntimePatch} from './profile-compiler.js';
export type {InstalledDshModule} from './profile-compiler.js';

export {dshModelConfigured, type DshModelAdapter} from '../../models/dsh-adapter.js';
export interface DshProviderOptions {
  readonly installedModules?: readonly InstalledDshModule[];
  /** Safe lifecycle observation for selected local integration checks. */
  readonly resourceObserver?: (event: {type: 'created' | 'closed'; runId: string; root: string}) => void;
}

/** Assemble only an already resolved selection with real Host-owned leases.
 * Configuration admission/persistence and model adapter construction remain outside this provider. */
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
    capabilities: Object.freeze({modelTransports: ['deepseek', 'openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai'], taskKinds: ['query'], tools: true, images: true, importWorkspace: false, hostDelegation: true, recovery: 'same-process', replacement: 'restart'}),
    prepare(profile, model, host) {
      if (!accepting || stopped) return Promise.reject(new AgentProviderError({category: 'blocked', code: 'runtime_unavailable', executionStarted: false}));
      const preparing = (async (): Promise<RuntimeHandle> => {
        if (typeof host.systemPrompt !== 'string' || !host.systemPrompt.trim()) throw new DshProfileError('dsh_profile_invalid');
        const modelAdapter = createDshModelAdapter(model, host), adapter = modelAdapter.value;
        if (adapter.model !== model.selection.modelId || (adapter.protocol ?? 'deepseek') !== model.selection.transport || !isDeepStrictEqual(model.selection, host.identity.model) ||
            host.identity.runtime.id !== profile.runtimeId || host.identity.runtime.profileId !== profile.profileId || host.identity.runtime.profileRevision !== profile.profileRevision || host.identity.runtime.assemblyFingerprint !== profile.assemblyFingerprint || !provider.capabilities.taskKinds.includes(profile.taskKind)) throw new DshProfileError('dsh_profile_invalid');
        const native = await compileNativeDshProfile(profile, options.installedModules ?? []);
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
          channel = await createDshHostChannel(host);
          observer = await modelAdapter.start();
          await mkdir(join(root, 'workspace'));
          const patch = join(root, 'runtime.patch.json');
          const entry = fileURLToPath(new URL('../../plugin.mjs', import.meta.url));
          await writeFile(patch, createRuntimePatch(entry, adapter.model!, adapter.baseUrl, adapter.reasoningEffort, adapter.maxTokens, adapter, host.systemPrompt, native), {mode: 0o600});
          host.assertCurrent(); if (stopped) throw new AgentProviderError();
          harness = new DeepSeekHarness({profile: 'sdk-minimal', patches: [patch], dshHome: join(root, 'home'), cwd: join(root, 'workspace'), processCwd: join(root, 'workspace'),
            provider: connection.route, model: adapter.model!, maxTokens: adapter.maxTokens ?? DEFAULT_MODEL_MAX_TOKENS, initializeTimeoutMs: 30_000, requestTimeoutMs: adapter.requestTimeoutMs ?? 120_000,
            env: {PATH: process.env.PATH, TMPDIR: tmpdir(), HOME: join(root, 'home'), DEEPSEEK_API_KEY: adapter.apiKey || 'mote-local-no-auth', DEEPSEEK_BASE_URL: connection.baseUrl, MOTE_MODEL_API_KEY: adapter.apiKey || 'mote-local-no-auth',
              MOTE_HOST_RUN: JSON.stringify(channel.configuration), MOTE_MODEL_OBSERVER: JSON.stringify(observer.configuration),
              MOTE_MODEL_TRANSPORT: JSON.stringify({baseUrl: connection.baseUrl, protocol: connection.protocol, reasoningEffort: connection.effort, provider: adapter.provider, headers: adapter.headers, extraBody: adapter.extraBody}),
            },
          });
          await Promise.race([harness.start(), channel.failure, observer.failure]);
          host.assertCurrent(); if (stopped) throw new AgentProviderError();
          const usage = observeHarness({question: '', onUsage(value) { if (active) host.emit({type: 'usage', usage: value}, active); }, onProgress(value) { if (active) host.emit({type: 'progress', progress: value}, active); }}, host.identity.runId, connection.protocol !== 'deepseek');
          const notification = (value: HarnessNotification) => {
            if (value.method !== 'session.event' || value.params.sessionId !== host.identity.runId) return;
            const event = value.params.event as {type: string; data?: {turn?: number; callId?: string; name?: string; arguments?: string}};
            if (event.type === 'turn/start' && active && Number.isSafeInteger(event.data?.turn)) turns.set(event.data!.turn!, active);
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
                const result = await host.runModel(request.attempt, () => Promise.race([harness!.run(request.prompt, {sessionId: host.identity.runId, onNotification: notification}), channel!.failure, observer!.failure]));
                const end = result.events && [...result.events].reverse().find(event => event.type === 'turn/end');
                const reason = (end?.data as {reason?: {kind?: string}} | undefined)?.reason;
                if (reason?.kind === 'max-tokens') return {terminal: {kind: 'output_limit'}, candidate: {text: result.finalResponse}};
                if (reason?.kind === 'aborted') return {terminal: {kind: 'cancelled', cause: cancellation?.kind ?? 'cancelled'}};
                if (reason?.kind !== 'completed') return {terminal: {kind: 'failed', reason: 'provider_error'}};
                return {terminal: {kind: 'completed'}, candidate: {text: result.finalResponse}};
              } catch (error) {
                if (cancellation || host.signal.aborted) return {terminal: {kind: 'cancelled', cause: cancellation?.kind ?? 'cancelled'}};
                if (error instanceof AgentYieldError) return {terminal: {kind: 'yielded'}};
                if (error instanceof AgentTimeoutError || error instanceof RequestTimeoutError) throw new AgentTimeoutError();
                if (error instanceof AgentResponseError || error instanceof ContextToolError && error.recovery === 'stop') return {terminal: {kind: 'failed', reason: error instanceof AgentResponseError && error.reason === 'tools_unverified' ? 'tools_unverified' : 'tool_failure'}};
                return {terminal: {kind: 'failed', reason: 'provider_error', ...(error instanceof ProviderFailure ? {providerFailure: error.details} : {})}};
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
          throw new AgentProviderError();
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
