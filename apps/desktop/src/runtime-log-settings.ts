import {mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import type {RuntimeLogLevel,RuntimeLogPolicy} from './contracts/settings';

export const runtimeLogLevels = ['debug', 'info', 'warn', 'error'] as const;

/** A separate local preference keeps log changes independent of capture configuration. */
export class RuntimeLogSettings {
  private current: RuntimeLogPolicy;
  readonly directory: string;
  private readonly path: string;
  constructor(profileDirectory: string, development: boolean) {
    this.directory = join(profileDirectory, 'diagnostics');
    this.path = join(this.directory, 'runtime-log-settings.json');
    const defaults: RuntimeLogPolicy = {enabled: true, level: development ? 'debug' : 'info'};
    try {
      this.current = RuntimeLogSettings.validate(JSON.parse(readFileSync(this.path, 'utf8')));
    } catch (error) {
      // A damaged or unreadable preference never silently re-enables logging.
      this.current = (error as NodeJS.ErrnoException).code === 'ENOENT' ? defaults : {...defaults, enabled: false};
    }
  }
  static validate(value: unknown): RuntimeLogPolicy {
    if (!value || typeof value !== 'object') throw new Error('Invalid log settings');
    const input = value as Record<string, unknown>;
    if (typeof input.enabled !== 'boolean' || !runtimeLogLevels.includes(input.level as RuntimeLogLevel)) throw new Error('Invalid log settings');
    return {enabled: input.enabled, level: input.level as RuntimeLogLevel};
  }
  read() { return {...this.current, directory: this.directory}; }
  save(value: unknown) {
    const next = RuntimeLogSettings.validate(value);
    mkdirSync(this.directory, {recursive: true, mode: 0o700});
    writeFileSync(this.path + '.tmp', JSON.stringify(next), {mode: 0o600, flush: true});
    renameSync(this.path + '.tmp', this.path);
    this.current = next;
    return this.read();
  }
  allows(level: RuntimeLogLevel) { return this.current.enabled && runtimeLogLevels.indexOf(level) >= runtimeLogLevels.indexOf(this.current.level); }
}
