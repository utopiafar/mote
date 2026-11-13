import {execFile, spawn, type ChildProcessWithoutNullStreams} from 'node:child_process';
import {access, mkdir, mkdtemp, rm, symlink, writeFile} from 'node:fs/promises';
import {homedir, tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import type {CodexServiceTier} from '@mote/shared/models';
import {AgentNotConfiguredError, AgentProviderError} from '../../types.js';

const execFileAsync = promisify(execFile);
export const CODEX_BUDGET_VERSION = 'mote-context-budget-v1';
// Explicit conservative input+output capacity for the pinned native model
// metadata. The native client rejects models without a verified output ceiling.
export const CODEX_CONSERVATIVE_CONTEXT_WINDOW = 272_000;

export const CODEX_APP_SERVER_ARGS = Object.freeze(['app-server', '--listen', 'stdio://']);
/** Native subagent/team producers stay off in every Mote App Server home. */
export const CODEX_NATIVE_DELEGATION_FEATURES = Object.freeze(['multi_agent', 'multi_agent_v2', 'collab'] as const);

export interface CodexLaunchOptions {
  readonly executable?: string;
  readonly home?: string;
  readonly workspace?: string;
  readonly serviceTier?: CodexServiceTier;
  readonly contextWindow?: number;
  readonly model?: string;
}

export type CodexAppServerConfigOptions = Pick<CodexLaunchOptions, 'workspace' | 'serviceTier'>;

/** Host-owned App Server policy. Never includes user plugins, MCP, hooks or history. */
export function codexAppServerConfig(options: CodexAppServerConfigOptions = {}): string {
  return [
    'cli_auth_credentials_store = "file"', 'approval_policy = "never"',
    ...(options.serviceTier ? [`service_tier = "${options.serviceTier}"`] : []),
    `sandbox_mode = "${options.workspace ? 'workspace-write' : 'read-only'}"`, 'web_search = "disabled"',
    'project_doc_max_bytes = 0', 'include_environment_context = false', 'include_apps_instructions = false',
    '[tools.update_plan]', 'enabled = false', '[tools.experimental_request_user_input]', 'enabled = false',
    '[orchestrator.skills]', 'enabled = false', '[orchestrator.mcp]', 'enabled = false', '[skills]', 'include_instructions = false', '[skills.bundled]', 'enabled = false',
    '[history]', 'persistence = "none"', '[analytics]', 'enabled = false',
    '[features]', ...['apps', 'connectors', 'plugins', 'hooks', 'codex_hooks', 'memories', 'goals', ...CODEX_NATIVE_DELEGATION_FEATURES, 'browser_use', 'computer_use', 'js_repl', 'code_mode', 'code_mode_only', 'image_generation', 'imagegenext', 'view_image', 'skill_mcp_dependency_install', 'tool_suggest', 'request_permissions_tool', 'shell_snapshot', 'remote_control'].map(key => `${key} = false`),
    ...(options.serviceTier === 'fast' ? ['fast_mode = true'] : []),
    `shell_tool = ${Boolean(options.workspace)}`, `unified_exec = ${Boolean(options.workspace)}`, `apply_patch_freeform = ${Boolean(options.workspace)}`,
  ].join('\n');
}

export interface CodexAppServerProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly root: string;
  readonly cwd: string;
}

/** The executable and login home are Host-owned values, never model or profile input. */
export async function launchCodexAppServer(options: CodexLaunchOptions = {}): Promise<CodexAppServerProcess> {
  const override = options.executable || process.env.MOTE_CODEX_BIN;
  const executable = override || fileURLToPath(new URL('../../../native/codex.mjs', import.meta.url));
  const command = override ? executable : process.execPath;
  const prefix = override ? [] : [executable];
  if (typeof executable !== 'string' || !executable.trim() || /[\0\r\n]/.test(executable)) throw new Error('Invalid Codex executable');
  const root = await mkdtemp(join(tmpdir(), 'mote-codex-'));
  try {
    const home = join(root, 'home'), cwd = options.workspace ?? join(root, 'workspace');
    await mkdir(home, {mode: 0o700});
    if (!options.workspace) await mkdir(cwd, {mode: 0o700});
    const env: NodeJS.ProcessEnv = {PATH: process.env.PATH, HOME: home, CODEX_HOME: home, TMPDIR: tmpdir(),
      MOTE_NATIVE_CONTEXT_WINDOW: String(options.contextWindow ?? CODEX_CONSERVATIVE_CONTEXT_WINDOW)};
    // Never silently run an installed CLI without the physical send gate. Probe
    // before linking credentials; it does not read personal configuration.
    try {
      const {stdout} = await execFileAsync(command, [...prefix, '--mote-context-budget-version'], {env, cwd, timeout: 5000, maxBuffer: 1024});
      if (stdout.trim() !== CODEX_BUDGET_VERSION) throw new Error('Unsupported native budget');
    } catch {
      throw new AgentProviderError({category: 'permanent', code: 'processing_limit'}, {source: 'runtime', stage: 'startup', code: 'native_budget_unavailable', modelId: options.model});
    }
    const authHome = resolve(options.home ?? process.env.MOTE_CODEX_HOME ?? process.env.CODEX_HOME ?? join(homedir(), '.codex'));
    try {
      await access(join(authHome, 'auth.json'));
      await symlink(join(authHome, 'auth.json'), join(home, 'auth.json'));
    } catch {
      throw new AgentNotConfiguredError();
    }
    await writeFile(join(home, 'config.toml'), codexAppServerConfig(options), {mode: 0o600});
    for (const key of ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'all_proxy', 'no_proxy', 'SystemRoot']) {
      if (process.env[key]) env[key] = process.env[key];
    }
    const child = spawn(command, [...prefix, ...CODEX_APP_SERVER_ARGS], {cwd, env, stdio: 'pipe'});
    return {child, root, cwd};
  } catch (error) {
    await rm(root, {recursive: true, force: true}).catch(() => {});
    throw error;
  }
}
