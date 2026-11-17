import { dirname, resolve } from 'node:path';
import { readConfigDocument } from './config-file.js';

/** CLI/device connections derive from the selected YAML; this is not server configuration precedence. */
export function loadEnvironment(baseDirectory: string, options: {env?:NodeJS.ProcessEnv} = {}): { env: NodeJS.ProcessEnv; baseDir: string; configFile: string | undefined } {
  const inherited = options.env ?? process.env;
  if (inherited.MOTE_ENV_FILE !== undefined) throw new Error('MOTE_ENV_FILE is unsupported; select the authoritative mote.yaml with MOTE_CONFIG_FILE');
  const selected = inherited.MOTE_CONFIG_FILE;
  if (selected !== undefined && !selected.trim()) throw new Error('MOTE_CONFIG_FILE must name an existing YAML configuration');
  const explicit = Object.fromEntries(Object.entries(inherited).filter((entry):entry is [string,string] => entry[1] !== undefined));
  if (selected === undefined) return { env: explicit, baseDir: resolve(baseDirectory), configFile: undefined };
  const loaded = readConfigDocument(selected, inherited), server = loaded.document.server as Record<string, unknown> | undefined, storage = loaded.document.storage as Record<string, unknown> | undefined;
  const host = ['0.0.0.0', '::'].includes(String(server?.host)) ? '127.0.0.1' : String(server?.host ?? '127.0.0.1');
  const url = `http://${host.includes(':') ? `[${host}]` : host}:${server?.port ?? 47832}`;
  // The selected file wins over ambient ordinary connection values too. Device bridges
  // are already derived by the profile launcher and remain a convenience for Electron.
  const env = { ...explicit, MOTE_CONFIG_FILE: loaded.configFile, MOTE_PROFILE: String(server?.profile ?? 'default'), MOTE_URL: url,
    MOTE_PORT: String(server?.port ?? 47832), MOTE_DATA_DIR: String(storage?.dataDir ?? './data'), MOTE_TOKEN: String(server?.token ?? '') };
  return { env, baseDir: dirname(loaded.configFile), configFile: loaded.configFile };
}
