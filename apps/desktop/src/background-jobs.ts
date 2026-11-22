import type { BackgroundJob } from './contracts/operations';
export type { BackgroundJob } from './contracts/operations';
import { moteText, statusMessage } from '@mote/shared/i18n';
import type { WorkProgress } from './contracts/operations';

/** Snapshot reads never join the operation chain. Repeated clicks cannot queue duplicate mutations. */
export class BackgroundJobs {
  private rows = new Map<string, BackgroundJob>();
  private running = new Map<string, Promise<unknown>>();
  snapshot(): BackgroundJob[] {
    const now = Date.now();
    return [...this.rows.values()].filter(row => row.state === 'running' || now - (this.finishedAt.get(row.id) ?? now) < 10_000).map(row => ({
      ...row,
      // These are app-authored progress labels, rendered in the current language.
      message: statusMessage(row.message) + (row.state === 'completed' ? moteText(" · 操作已结束") : row.state === 'failed' ? moteText(" · 未完成，重试") : ''),
    }));
  }
  private finishedAt = new Map<string, number>();
  progress(id: string, value: WorkProgress): void {
    const prior = this.rows.get(id); if (prior?.state === 'running') this.rows.set(id, { ...prior, ...value });
  }
  run<T>(id: string, label: string, work: () => T | Promise<T>): Promise<T> {
    if (this.running.has(id)) return Promise.reject(new Error(moteText("这项后台操作正在进行，等待完成")));
    this.rows.set(id, { id, message: label, startedAt: Date.now(), state: 'running' });
    const result = Promise.resolve().then(work);
    this.running.set(id, result);
    void result.then(() => this.finish(id, 'completed'), () => this.finish(id, 'failed'));
    return result;
  }
  private finish(id: string, state: BackgroundJob['state']): void {
    this.running.delete(id); this.finishedAt.set(id, Date.now());
    const row = this.rows.get(id)!;
    this.rows.set(id, { ...row, state });
  }
}
