export type SyncQueue = 'realtime' | 'history';

/** Weighted work accounting; callers may use bytes or bounded legacy work units. */
export class PriorityScheduler {
  private realtimeWork = 0;
  constructor(private readonly realtimeBurst = 4) {
    if (!Number.isInteger(realtimeBurst) || realtimeBurst < 1) throw new Error('Realtime scheduler burst is invalid');
  }
  next(realtimePending: number, historyPending: number): SyncQueue | undefined {
    if (!realtimePending && !historyPending) return undefined;
    if (!realtimePending || historyPending > 0 && this.realtimeWork >= this.realtimeBurst) return 'history';
    return 'realtime';
  }
  committed(queue: SyncQueue, units: number): void {
    if(!Number.isFinite(units)||units<0)throw new Error('Invalid scheduler work');
    if(units===0)return; // A slice yielding before admission did not serve this queue.
    if (queue === 'history') this.realtimeWork = 0;
    else this.realtimeWork += units;
  }
}
