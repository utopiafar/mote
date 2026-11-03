import {spawn, type ChildProcessWithoutNullStreams} from 'node:child_process';
import {access, mkdir, mkdtemp, rm, symlink, writeFile} from 'node:fs/promises';
import {homedir, tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import type {CodexServiceTier} from '@mote/shared/models';
import {AgentNotConfiguredError} from '../../types.js';

export const CODEX_APP_SERVER_ARGS = Object.freeze(['app-server', '--listen', 'stdio://']);

export interface CodexLaunchOptions {
  readonly executable?: string;
  readonly home?: string;
  readonly workspace?: string;
  readonly serviceTier?: CodexServiceTier;
}

export interface CodexAppServerProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly root: string;
  readonly cwd: string;
}

/** The executable and login home are Host-owned values, never model or profile input. */
export async function launchCodexAppServer(options: CodexLaunchOptions = {}): Promise<CodexAppServerProcess> {
  const executable = options.executable || process.env.MOTE_CODEX_BIN || 'codex';
  if (typeof executable !== 'string' || !executable.trim() || /[\0\r\n]/.test(executable)) throw new Error('Invalid Codex executable');
  const root = await mkdtemp(join(tmpdir(), 'mote-codex-'));
  try {
    const home = join(root, 'home'), cwd = options.workspace ?? join(root, 'workspace');
    await mkdir(home, {mode: 0o700});
    if (!options.workspace) await mkdir(cwd, {mode: 0o700});
    const authHome = resolve(options.home ?? process.env.MOTE_CODEX_HOME ?? process.env.CODEX_HOME ?? join(homedir(), '.codex'));
    try {
      await access(join(authHome, 'auth.json'));
      await symlink(join(authHome, 'auth.json'), join(home, 'auth.json'));
    } catch {
      throw new AgentNotConfiguredError();
    }
    const config = [
      'cli_auth_credentials_store = "file"', 'approval_policy = "never"',
      ...(options.serviceTier ? [`service_tier = "${options.serviceTier}"`] : []),
      `sandbox_mode = "${options.workspace ? 'workspace-write' : 'read-only'}"`, 'web_search = "disabled"',
      'project_doc_max_bytes = 0', 'include_environment_context = false', 'include_apps_instructions = false',
      '[tools.update_plan]', 'enabled = false', '[tools.experimental_request_user_input]', 'enabled = false',
      '[orchestrator.skills]', 'enabled = false', '[orchestrator.mcp]', 'enabled = false', '[skills]', 'include_instructions = false', '[skills.bundled]', 'enabled = false',
      '[history]', 'persistence = "none"', '[analytics]', 'enabled = false',
      '[features]', ...['apps', 'connectors', 'plugins', 'hooks', 'codex_hooks', 'memories', 'goals', 'multi_agent', 'multi_agent_v2', 'collab', 'browser_use', 'computer_use', 'js_repl', 'code_mode', 'code_mode_only', 'image_generation', 'imagegenext', 'view_image', 'skill_mcp_dependency_install', 'tool_suggest', 'request_permissions_tool', 'shell_snapshot', 'remote_control'].map(key => `${key} = false`),
      ...(options.serviceTier === 'fast' ? ['fast_mode = true'] : []),
      `shell_tool = ${Boolean(options.workspace)}`, `unified_exec = ${Boolean(options.workspace)}`, `apply_patch_freeform = ${Boolean(options.workspace)}`,
    ].join('\n');
    await writeFile(join(home, 'config.toml'), config, {mode: 0o600});
    const env: NodeJS.ProcessEnv = {PATH: process.env.PATH, HOME: home, CODEX_HOME: home, TMPDIR: tmpdir()};
    for (const key of ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'all_proxy', 'no_proxy', 'SystemRoot']) {
      if (process.env[key]) env[key] = process.env[key];
    }
    const child = spawn(executable, [...CODEX_APP_SERVER_ARGS], {cwd, env, stdio: 'pipe'});
    return {child, root, cwd};
  } catch (error) {
    await rm(root, {recursive: true, force: true}).catch(() => {});
    throw error;
  }
}
