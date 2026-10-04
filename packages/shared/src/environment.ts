import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseEnv } from 'node:util';

/** Load only explicitly selected files; inherited variables never trigger implicit file reads. */
export function loadEnvironment(baseDirectory: string, options: {env?:NodeJS.ProcessEnv} = {}) {
  const inherited = options.env ?? process.env;
  const selected = inherited.MOTE_ENV_FILE;
  if (selected !== undefined && !selected.trim()) throw new Error('MOTE_ENV_FILE must name an existing environment file');
  const envFile = selected === undefined ? undefined : resolve(selected);
  const baseDir = envFile === undefined ? resolve(baseDirectory) : dirname(envFile);
  if (envFile !== undefined && !existsSync(envFile)) throw new Error('The selected MOTE_ENV_FILE does not exist');
  const fileValues = envFile ? parseEnv(readFileSync(envFile, 'utf8')) : {};
  // A file cannot redirect itself or retroactively select a different profile file.
  delete fileValues.MOTE_ENV_FILE;
  const explicit = Object.fromEntries(Object.entries(inherited).filter((entry):entry is [string,string] => entry[1] !== undefined));
  return {env:{...fileValues,...explicit},baseDir,envFile};
}
