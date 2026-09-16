import type { WorkProgress } from './background';

export interface BackgroundJob extends WorkProgress { id: string; startedAt: number; state: 'running' | 'completed' | 'failed' }
/** Snapshot reads never join the operation chain. Repeated clicks cannot queue duplicate mutations. */
export class BackgroundJobs {
  private rows = new Map<string, BackgroundJob>();
  private running = new Map<string, Promise<unknown>>();
  snapshot(): BackgroundJob[] {
    const now = Date.now();
    return [...this.rows.values()].filter(row => row.state === 'running' || now - (this.finishedAt.get(row.id) ?? now) < 10_000).map(row => ({ ...row }));
  }
  private finishedAt = new Map<string, number>();
  progress(id: string, value: WorkProgress): void {
    const prior = this.rows.get(id); if (prior?.state === 'running') this.rows.set(id, { ...prior, ...value });
  }
  run<T>(id: string, label: string, work: () => T | Promise<T>): Promise<T> {
    if (this.running.has(id)) return Promise.reject(new Error('这项后台操作正在进行，请等待完成'));
    this.rows.set(id, { id, message: label, startedAt: Date.now(), state: 'running' });
    const result = Promise.resolve().then(work);
    this.running.set(id, result);
    void result.then(() => this.finish(id, 'completed'), () => this.finish(id, 'failed'));
    return result;
  }
  private finish(id: string, state: BackgroundJob['state']): void {
    this.running.delete(id); this.finishedAt.set(id, Date.now());
    const row = this.rows.get(id)!;
    this.rows.set(id, { ...row, state, message: state === 'completed' ? row.message + ' · 操作已结束' : row.message + ' · 未完成，请重试' });
  }
}
