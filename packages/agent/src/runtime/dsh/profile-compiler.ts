import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {runtimeAssemblySchema, RUNTIME_HOST_CAPABILITIES, type RuntimeModuleReference} from '@mote/shared/agent-runtimes';
import {DEFAULT_MODEL_MAX_TOKENS} from '@mote/shared/models';
import {SYSTEM_PROMPT} from '../../instructions.js';
import {modelRuntimeEntries, harnessPrivacyEntries, validateModelOptions} from '../../models/provider-registry.js';
import type {AgentOptions} from '../../types.js';
import type {ResolvedRuntimeProfile} from '../contracts.js';
import type {RuntimeProfileConfiguration} from '../profile.js';
import {readNativeDshManifest, planNativeDshAssembly, type NativeDshAssemblyEntry} from './native-assembly.js';

export const DSH_RUNTIME_ID = 'mote.runtime.dsh';
/** Native subagent and child-workflow producers are disabled even when a profile
 * or the SDK default would otherwise load them. Delegation uses Host controls. */
export const DSH_NATIVE_DELEGATION_PLUGINS = Object.freeze([
  'subagent',
  'subagent-spawn-in-process',
  'subagent-fork-in-process',
  'tool-subagent',
  'tool-subagent-fork',
  'tool-subagent-control',
  'tool-subagent-list-agents',
  'workflow-ptc',
  'tool-workflow',
  'tool-ralph',
] as const);
export class DshProfileError extends Error {
  constructor(readonly code: 'dsh_profile_invalid' | 'dsh_module_unavailable' | 'dsh_dependency_missing' | 'dsh_factory_duplicate') {
    super(code); this.name = 'DshProfileError';
  }
}

/** Trusted installed-artifact projection from the Host, never a query/config DTO.
 * H07/A07 own verification and grant authority; selection is not a sandbox. */
export interface InstalledDshModule {
  readonly reference: RuntimeModuleReference;
  readonly packageRoot: string;
  readonly packageName: string;
  readonly packageVersion: string;
  readonly subpath: string;
  readonly grantedCapabilities: readonly string[];
  readonly requires?: readonly RuntimeModuleReference[];
}

function configurationValue(value: unknown): RuntimeProfileConfiguration {
  const object = (input: unknown, keys: readonly string[]): Record<string, unknown> => {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !keys.includes(key))) throw new DshProfileError('dsh_profile_invalid');
    return input as Record<string, unknown>;
  };
  const parsed = object(value, ['assembly', 'allowedHostCapabilities', 'launch']);
  const allowed = parsed.allowedHostCapabilities;
  if (!Array.isArray(allowed) || allowed.some(item => !RUNTIME_HOST_CAPABILITIES.includes(item)) || new Set(allowed).size !== allowed.length) throw new DshProfileError('dsh_profile_invalid');
  const launch = object(parsed.launch, ['executable', 'home']);
  if (Object.values(launch).some(item => typeof item !== 'string')) throw new DshProfileError('dsh_profile_invalid');
  return {assembly: runtimeAssemblySchema.parse(parsed.assembly), allowedHostCapabilities: allowed, launch};
}

/** Resolve exact installed refs through A03's real-loader planner. All errors
 * exposed here are value-free; package paths/source and secrets stay private. */
export async function compileNativeDshProfile(profile: ResolvedRuntimeProfile<RuntimeProfileConfiguration>, installed: readonly InstalledDshModule[]): Promise<readonly NativeDshAssemblyEntry[]> {
  let configuration: RuntimeProfileConfiguration;
  try { configuration = configurationValue(profile.configuration); }
  catch { throw new DshProfileError('dsh_profile_invalid'); }
  if (profile.runtimeId !== DSH_RUNTIME_ID || profile.binding.service.id !== 'mote.agent.runtime' || profile.binding.service.apiVersion !== '1') throw new DshProfileError('dsh_profile_invalid');
  const {assembly} = configuration;
  const refs = [...assembly.packages, ...assembly.hooks, ...(assembly.factory ? [assembly.factory] : [])];
  const keys = refs.map(reference => JSON.stringify([reference.contribution, reference.exportName]));
  if (new Set(keys).size !== keys.length) throw new DshProfileError('dsh_profile_invalid');
  const modules = refs.map(reference => {
    const found = installed.filter(item => isDeepStrictEqual(item.reference, reference));
    if (found.length !== 1) throw new DshProfileError('dsh_module_unavailable');
    return found[0]!;
  });
  for (const module of modules) if (module.requires?.some(required => !refs.some(ref => isDeepStrictEqual(ref, required)))) throw new DshProfileError('dsh_dependency_missing');
  const groups = new Map<string, InstalledDshModule[]>();
  for (const module of modules) groups.set(module.packageRoot, [...(groups.get(module.packageRoot) ?? []), module]);
  const entries = new Map<InstalledDshModule, NativeDshAssemblyEntry>();
  try {
    for (const [root, group] of groups) {
      const manifest = await readNativeDshManifest(root);
      if (group.some(item => item.packageName !== manifest.name || item.packageVersion !== manifest.version)) throw new DshProfileError('dsh_module_unavailable');
      // One installed package is one trusted grant scope; every selection must
      // agree, and A03 requires ALL package-level declarations to be granted.
      if (group.some(item => !isDeepStrictEqual([...item.grantedCapabilities].sort(), [...group[0]!.grantedCapabilities].sort()))) throw new DshProfileError('dsh_profile_invalid');
      const plan = planNativeDshAssembly(root, manifest, group.map(item => ({
        id: 'native-' + createHash('sha256').update(JSON.stringify(item.reference)).digest('hex').slice(0, 24),
        subpath: item.subpath, factory: assembly.factory !== undefined && isDeepStrictEqual(item.reference, assembly.factory),
      })), group[0]!.grantedCapabilities);
      group.forEach((item, index) => entries.set(item, plan.entries[index]!));
    }
  } catch (error) {
    if (error instanceof DshProfileError) throw error;
    throw new DshProfileError('dsh_module_unavailable');
  }
  const result = modules.map(module => entries.get(module)!);
  if (result.filter(entry => entry.factory).length > 1) throw new DshProfileError('dsh_factory_duplicate');
  return result;
}

/** Static ESM entrypoints only. No source rewriting, executable YAML or query paths. */
export function createRuntimePatch(
  pluginPath: string, model: string, baseUrl?: string,
  reasoningEffort?: AgentOptions['reasoningEffort'], maxTokens = DEFAULT_MODEL_MAX_TOKENS,
  connection: Pick<AgentOptions, 'protocol' | 'provider' | 'requestTimeoutMs'> = {}, systemPrompt = SYSTEM_PROMPT,
  native: readonly NativeDshAssemblyEntry[] = [],
): string {
  validateModelOptions({...connection, model, baseUrl, reasoningEffort, maxTokens});
  if (new Set(native.map(entry => entry.id)).size !== native.length || native.some(entry => entry.id.startsWith('mote-'))) throw new DshProfileError('dsh_profile_invalid');
  if (native.filter(entry => entry.factory).length > 1) throw new DshProfileError('dsh_factory_duplicate');
  return JSON.stringify([
    ...['persistent-bash', 'persistent-pwsh', 'terminal-bash', 'terminal-pwsh', 'pty', 'subprocess', 'mcp-resources', ...DSH_NATIVE_DELEGATION_PLUGINS].map(id => ({id, disabled: true})),
    ...harnessPrivacyEntries(),
    ...(native.some(entry => entry.factory) ? [{id: 'agent-loop', disabled: true}] : []),
    {id: 'system-prompt', config: {includeHarnessIdentity: false, includeRuntimeContext: false, personaPrefix: systemPrompt}},
    ...modelRuntimeEntries({...connection, model, baseUrl, reasoningEffort, maxTokens}),
    {id: 'sdk-jsonrpc-server', inject: ['sdkAppStartup', 'loader', 'moteReady']},
    {insert: [
      {id: 'mote-attachments', name: import.meta.resolve('@deepseek-ai/dsh-attachment-local'), config: {maxImageBytes: 8388608, maxMessageImageBytes: 33554432}},
      {id: 'mote-skills', name: import.meta.resolve('@deepseek-ai/dsh-skill')},
      ...native.map(entry => ({id: entry.id, name: entry.specifier})),
      {id: 'mote-context', name: pluginPath},
    ]},
  ], null, 2);
}
