export type SyncQueue = 'realtime' | 'history';

/** Weighted fair scheduling keeps backfill moving without delaying live files. */
export class PriorityScheduler {
  private realtimeBatches = 0;
  constructor(private readonly realtimeBurst = 4) {
    if (!Number.isInteger(realtimeBurst) || realtimeBurst < 1) throw new Error('Realtime scheduler burst is invalid');
  }
  next(realtimePending: number, historyPending: number): SyncQueue | undefined {
    if (!realtimePending && !historyPending) return undefined;
    if (!realtimePending || historyPending > 0 && this.realtimeBatches >= this.realtimeBurst) return 'history';
    return 'realtime';
  }
  committed(queue: SyncQueue, batches: number): void {
    if (queue === 'history') this.realtimeBatches = 0;
    else this.realtimeBatches += batches;
  }
}
