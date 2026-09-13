import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseEnv } from 'node:util';

/** Explicit files replace legacy .env loading; this never mutates process.env. */
export function loadEnvironment(legacyBaseDir: string, options: {env?:NodeJS.ProcessEnv} = {}) {
  const inherited = options.env ?? process.env;
  const selected = inherited.MOTE_ENV_FILE;
  if (selected !== undefined && !selected.trim()) throw new Error('MOTE_ENV_FILE must name an existing environment file');
  const envFile = selected === undefined ? resolve(legacyBaseDir, '.env') : resolve(selected);
  const baseDir = selected === undefined ? resolve(legacyBaseDir) : dirname(envFile);
  if (selected !== undefined && !existsSync(envFile)) throw new Error('The selected MOTE_ENV_FILE does not exist');
  const fileValues = existsSync(envFile) ? parseEnv(readFileSync(envFile, 'utf8')) : {};
  // A file cannot redirect itself or retroactively select a different profile file.
  delete fileValues.MOTE_ENV_FILE;
  const explicit = Object.fromEntries(Object.entries(inherited).filter((entry):entry is [string,string] => entry[1] !== undefined));
  return {env:{...fileValues,...explicit},baseDir,envFile:existsSync(envFile)?envFile:undefined};
}
