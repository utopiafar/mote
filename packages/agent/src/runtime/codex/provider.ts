import {isDeepStrictEqual} from 'node:util';
import type {PluginDefinition} from '@mote/plugin-host';
import type {Cancellation, ScopeIdentity, ServiceBinding} from '@mote/plugin-api/contracts';
import {ProviderFailure,errorDiagnostics} from '@mote/shared';
import {AgentNotConfiguredError, AgentProviderError, AgentResponseError, AgentTimeoutError, type AgentOptions} from '../../types.js';
import {AgentYieldError} from '../../host-controls.js';
import {ContextToolError} from '../../tool-errors.js';
import {CodexSession, type CodexTool, type CodexToolDelivery} from '../../codex-session.js';
import {createHostRunSession, type HostSessionAssembly} from '../../host/run-session.js';
import type {HostRunDependencies} from '../../host/run-contracts.js';
import {runtimeService, type HostRunPort, type ModelLease, type ResolvedRuntimeProfile, type RuntimeAttempt, type RuntimeHandle, type RuntimeOutcome, type RuntimeProvider, type RuntimeRunRequest} from '../contracts.js';
import type {ResolvedRunSelection, RuntimeProfileConfiguration} from '../profile.js';

export const CODEX_RUNTIME_ID = 'mote.runtime.codex';
export type CodexModelAdapter = Pick<AgentOptions, 'model' | 'contextWindow' | 'reasoningEffort' | 'serviceTier' | 'authorizeModelRequest'>;

export class CodexProfileError extends Error {
  constructor(readonly code: 'codex_profile_invalid') {
    super(code);
    this.name = 'CodexProfileError';
  }
}

function invalidProfile(): never {
  throw new CodexProfileError('codex_profile_invalid');
}

function validatePreparation(profile: ResolvedRuntimeProfile<RuntimeProfileConfiguration>, model: ModelLease<CodexModelAdapter>, host: HostRunPort): void {
  if (profile.runtimeId !== CODEX_RUNTIME_ID || profile.binding.service.id !== runtimeService.id || profile.binding.service.apiVersion !== runtimeService.apiVersion ||
      host.identity.runtime.id !== profile.runtimeId || host.identity.runtime.profileId !== profile.profileId || host.identity.runtime.profileRevision !== profile.profileRevision ||
      host.identity.runtime.assemblyFingerprint !== profile.assemblyFingerprint || profile.taskKind !== 'query' || !isDeepStrictEqual(model.selection, host.identity.model) ||
      model.selection.transport !== 'codex-app-server' || model.value.model !== model.selection.modelId || !model.value.model?.trim() ||
      model.value.authorizeModelRequest !== undefined && typeof model.value.authorizeModelRequest !== 'function' ||
      typeof host.systemPrompt !== 'string' || !host.systemPrompt.trim()) invalidProfile();
  const configuration = profile.configuration;
  if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration)) invalidProfile();
  const assembly = configuration.assembly, launch = configuration.launch;
  if (!assembly || !Array.isArray(assembly.packages) || !Array.isArray(assembly.hooks) || assembly.packages.length || assembly.hooks.length || assembly.factory ||
      !Array.isArray(configuration.allowedHostCapabilities) || configuration.allowedHostCapabilities.some(capability => !['tools', 'images', 'hostDelegation'].includes(capability)) ||
      !launch || typeof launch !== 'object' || Array.isArray(launch) || Object.keys(launch).some(key => key !== 'executable' && key !== 'home') ||
      launch.executable !== undefined && (typeof launch.executable !== 'string' || !launch.executable.trim()) ||
      launch.home !== undefined && (typeof launch.home !== 'string' || !launch.home.trim())) invalidProfile();
}

function cancellationCause(host: HostRunPort, fallback: Cancellation['kind']): Cancellation['kind'] {
  const reason = host.signal.reason as {kind?: unknown; code?: unknown} | undefined;
  const kind = reason?.kind ?? reason?.code;
  return kind === 'cancelled' || kind === 'deadline_exceeded' || kind === 'revoked' || kind === 'scope_stopped' ? kind : fallback;
}

function cancellationError(cause: Cancellation['kind']): Error {
  return cause === 'deadline_exceeded' ? new AgentTimeoutError() : new DOMException('Codex runtime cancelled', 'AbortError');
}

/** Official App Server runtime. It shares Host contracts with DSH, never DSH execution. */
export function createCodexRuntimeProvider() {
  let accepting = true, stopped = false;
  const handles = new Set<RuntimeHandle>(), preparations = new Set<Promise<RuntimeHandle>>(), abortPreparations = new Set<() => void>();
  let closing: Promise<void> | undefined;
  const provider: RuntimeProvider<RuntimeProfileConfiguration, CodexModelAdapter> = {
    capabilities: Object.freeze({modelTransports: ['codex-app-server'], taskKinds: ['query'], tools: true, images: true, importWorkspace: false, hostDelegation: true, nativeDelegation: false, recovery: 'same-process', replacement: 'restart'}),
    prepare(profile, model, host) {
      if (!accepting || stopped) return Promise.reject(new AgentProviderError({category: 'blocked', code: 'runtime_unavailable', executionStarted: false}));
      const preparing = (async (): Promise<RuntimeHandle> => {
        host.assertCurrent();
        model.assertCurrent();
        validatePreparation(profile, model, host);
        let active: RuntimeAttempt | undefined, task: Promise<RuntimeOutcome> | undefined, released = false, closed: Promise<void> | undefined;
        let cancellation: Cancellation | undefined;
        // App Server keeps a turn open after a tool call. A Host control yield
        // (or a stop-level tool rejection) must interrupt that turn immediately
        // instead of waiting for a completion the Host will never accept.
        let rejectHostFailure!: (error: Error) => void;
        const hostFailure = new Promise<never>((_resolve, reject) => {rejectHostFailure = reject;});
        void hostFailure.catch(() => {});
        const reportHostFailure = (error: unknown) => {
          if (error instanceof AgentYieldError || error instanceof AgentResponseError || error instanceof ContextToolError && error.recovery === 'stop') {
            try { rejectHostFailure(error); } catch { /* The run already settled. */ }
          }
        };
        const tools: CodexTool[] = host.tools.definitions.map(tool => ({type: 'function', name: tool.name, description: tool.description, inputSchema: tool.inputSchema}));
        const deliver = async (name: string, args: unknown, callId: string, send: CodexToolDelivery): Promise<unknown> => {
          const attempt = active;
          if (!attempt || released) throw new AgentProviderError();
          try {
            return await host.tools.deliver(attempt, {callId, name, arguments: args}, async payload => {
              let content: unknown;
              try { content = JSON.parse(payload.text); } catch { throw new AgentProviderError(); }
              if (payload.images?.length) {
                if (payload.images.length !== 1 || !content || typeof content !== 'object' || Array.isArray(content)) throw new AgentProviderError();
                content = {...content, image: payload.images[0]};
              }
              return send(content);
            });
          } catch (error) {
            reportHostFailure(error);
            throw error;
          }
        };
        const session = new CodexSession({model: model.value.model, contextWindow: model.value.contextWindow, reasoningEffort: model.value.reasoningEffort, serviceTier: model.value.serviceTier, agentTimeoutMs: null, codex: profile.configuration.launch, authorizeModelRequest: model.value.authorizeModelRequest},
          deliver, event => host.observe?.(event), usage => { if (active) host.emit({type: 'usage', usage}, active); });
        const closeResources = () => closed ??= (async () => {
          released = true;
          host.signal.removeEventListener('abort', abort);
          abortPreparations.delete(abort);
          await session.close();
          if (task) await Promise.allSettled([task]);
        })();
        const abort = () => {
          cancellation ??= {kind: cancellationCause(host, 'cancelled')};
          session.cancel(cancellationError(cancellation.kind));
          void session.close().catch(() => {});
        };
        abortPreparations.add(abort);
        host.signal.addEventListener('abort', abort, {once: true});
        if (host.signal.aborted) abort();
        try {
          await session.start(host.systemPrompt, tools);
          host.assertCurrent();
          model.assertCurrent();
          if (stopped) throw new AgentProviderError();
          host.emit({type: 'tools.ready', tools: host.tools.definitions.map(({name, version, fingerprint}) => ({name, version, fingerprint}))}, null);
          const drive = (request: RuntimeRunRequest): Promise<RuntimeOutcome> => {
            if (active || released || stopped) return Promise.reject(new AgentProviderError());
            host.assertCurrent();
            active = request.attempt;
            task = (async () => {
              try {
                const text = await host.runModel(request.attempt, () => Promise.race([session.run(request.prompt, request.outputSchema), hostFailure]));
                return {terminal: {kind: 'completed'}, candidate: {text}};
              } catch (error) {
                if (cancellation || host.signal.aborted) return {terminal: {kind: 'cancelled', cause: cancellation?.kind ?? cancellationCause(host, 'cancelled')}};
                if (error instanceof AgentYieldError) return {terminal: {kind: 'yielded'}};
                if (error instanceof AgentTimeoutError) throw error;
                if (error instanceof AgentResponseError || error instanceof ContextToolError && error.recovery === 'stop') {
                  return {terminal: {kind: 'failed', reason: error instanceof AgentResponseError && error.reason === 'tools_unverified' ? 'tools_unverified' : 'tool_failure'}};
                }
                // Preserve safe diagnostic facts on the original transport error.
                // Classification/recovery remain owned by the same ProviderFailure.
                if(error instanceof ProviderFailure)throw error;
                throw new AgentProviderError(undefined,errorDiagnostics(error));
              } finally {
                active = undefined;
              }
            })();
            return task;
          };
          const handle: RuntimeHandle = {
            run: drive,
            repair: drive,
            async cancel(cause) { cancellation ??= cause; session.cancel(cancellationError(cause.kind)); },
            async close() { try { await closeResources(); } finally { handles.delete(handle); } },
          };
          handles.add(handle);
          return handle;
        } catch (error) {
          await closeResources().catch(() => {});
          if (error instanceof AgentNotConfiguredError || error instanceof AgentTimeoutError || error instanceof AgentResponseError || error instanceof ProviderFailure || error instanceof CodexProfileError) throw error;
          throw new AgentProviderError();
        }
      })();
      preparations.add(preparing);
      void preparing.then(() => preparations.delete(preparing), () => preparations.delete(preparing));
      return preparing;
    },
  };
  return Object.assign(provider, {
    quiesce() { accepting = false; },
    close() {
      return closing ??= (async () => {
        accepting = false;
        stopped = true;
        for (const abort of abortPreparations) abort();
        await Promise.allSettled([...preparations]);
        const results = await Promise.allSettled([...handles].map(handle => handle.cancel({kind: 'scope_stopped'}).finally(() => handle.close())));
        if (results.some(result => result.status === 'rejected')) throw new AgentProviderError();
      })();
    },
  });
}

export function prepareCodexRun(selection: ResolvedRunSelection, dependencies: Omit<HostRunDependencies, 'profile' | 'identity'> & {readonly runId: string}, assembly: HostSessionAssembly) {
  if (selection.runtime.runtimeId !== CODEX_RUNTIME_ID || !isDeepStrictEqual(selection.modelSelection, dependencies.model.selection)) throw new CodexProfileError('codex_profile_invalid');
  const {runId, ...ports} = dependencies, profile = selection.runtime;
  return createHostRunSession({...ports, profile, identity: {runId, runtime: {id: profile.runtimeId, revision: profile.binding.revision, profileId: profile.profileId, profileRevision: profile.profileRevision, assemblyFingerprint: profile.assemblyFingerprint}, model: selection.modelSelection}}, assembly);
}

export function codexRuntimePlugin(identity: ScopeIdentity, published?: (binding: ServiceBinding) => void): PluginDefinition {
  return {identity, contributions: [runtimeService], restartRequired: true, factory(context) {
    const provider = createCodexRuntimeProvider();
    context.scope.defer(() => provider.close());
    return {prepare() {}, start() { const binding = context.provide(runtimeService.id, runtimeService, provider); published?.(binding); }, quiesce() { provider.quiesce(); }, stop() { return provider.close(); }, dispose() { return provider.close(); }};
  }};
}
