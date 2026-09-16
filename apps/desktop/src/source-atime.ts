import type { Stats } from 'node:fs';
import { atomicSourceJson, sourceHash } from './source-sync';
import { readLocalContent } from './local-content';
interface Entry { identity: string; readAtimeMs: number; reportedAtimeMs: number }
/** Private local scanner markers. They describe file-system timestamps, never proof of human access. */
export class FileAccessMarkers {
  private entries: Record<string, Entry> = {};
  private observed: Record<string, Entry> = {};
  constructor(private readonly path?: string) {}
  async initialize(): Promise<void> {
    if (!this.path) return;
    try {
      const value = JSON.parse((await readLocalContent(this.path)).toString('utf8')) as { version: number; entries: Record<string, Entry> };
      if (value.version !== 1 || !value.entries || Object.keys(value.entries).length > 5000) throw new Error('invalid markers');
      for (const [key, entry] of Object.entries(value.entries)) {
        if (!/^[a-f0-9]{64}$/.test(key) || !entry || typeof entry.identity !== 'string' || !/^[a-f0-9]{64}$/.test(entry.identity) || !Number.isFinite(entry.readAtimeMs) || !Number.isFinite(entry.reportedAtimeMs)) throw new Error('invalid markers');
      }
      this.entries = value.entries;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('文件访问时间标记无法读取，请保留来源状态并修复'); }
  }
  record(key: string, before: Stats, after: Stats): number {
    const id = sourceHash(key);
    const identity = sourceHash(JSON.stringify([before.dev, before.ino, before.size, before.mtimeMs, before.ctimeMs, before.birthtimeMs]));
    const prior = this.entries[id];
    const reportedAtimeMs = prior?.identity === identity && prior.readAtimeMs === before.atimeMs ? prior.reportedAtimeMs : before.atimeMs;
    this.observed[id] = { identity, readAtimeMs: after.atimeMs, reportedAtimeMs };
    return reportedAtimeMs;
  }
  async persist(complete: boolean): Promise<void> {
    // A partial scan retains unseen markers; a complete scan removes old entries to stay bounded.
    const entries = complete ? this.observed : { ...this.entries, ...this.observed };
    const bounded = Object.fromEntries(Object.entries(entries).slice(-5000));
    if (this.path) await atomicSourceJson(this.path, { version: 1, entries: bounded });
    this.entries = bounded;
  }
}
