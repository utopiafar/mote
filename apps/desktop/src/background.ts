import type { WorkProgress } from './contracts/operations';
export type { WorkProgress } from './contracts/operations';
import { moteText, getLocale } from '@mote/shared/i18n';
import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import type { Rectangle } from './contracts';

export type BackgroundRequest =
  | {kind:'spool-original';path:string;directory:string;expected:import('./original-spool').OriginalIdentity}
  | {kind:'spool-bytes';bytes:Uint8Array;directory:string}
  | {kind:'original-part';spool:import('./original-spool').OriginalSpool;part:number}
  | {kind:'source-state';path:string;patches?:import('./source-state-store').StatePatch[];maximum?:number}
  | {kind:'coding-scan';root:string;provider:import('./coding-agents').CodingProvider;options:import('./source-types').SourceOptions;checkpoint?:import('./coding-agents').CodingCheckpoint}
  | { kind: 'compression-preview'; quality: number; maxSide: number }
  | { kind: 'json-write'; path: string; value: unknown; maximum?: number }
  | { kind: 'json-read'; path: string }
  | { kind: 'browse'; records: { id: string; at: string }[]; after: string; before: string; offset: number; limit: number }
  | { kind: 'hash'; bytes: Uint8Array }
  | { kind: 'mask'; bytes: Uint8Array; width: number; height: number; rectangles: Rectangle[] }
  | { kind: 'jpeg'; bytes: Uint8Array; width: number; height: number; quality: number }
  | { kind: 'preview'; bytes: Uint8Array; thumbnail: boolean }
  | { kind: 'archive-export'; directory: string; path: string }
  | { kind: 'archive-prepare'; path: string; staging: string };

type PendingWork = { resolve: (value: unknown) => void; reject: (error: Error) => void; progress?: (value: WorkProgress) => void; signal?:AbortSignal; cancellation?:Int32Array; commitAware:boolean; progressAck:boolean; cleanup:()=>void };
function cancellationWon(job: PendingWork): boolean {
  return Boolean(job.signal?.aborted && !(job.commitAware && job.cancellation && Atomics.load(job.cancellation,0)===2));
}

/** CPU work stays in a Node worker, including image codecs and bulk JSON. No Electron APIs here. */
export class BackgroundLane {
  private worker?: Worker;
  private nextId = 0;
  private pending = new Map<number, PendingWork>();
  run<T>(request: BackgroundRequest, progress?: (value: WorkProgress) => void, signal?:AbortSignal): Promise<T> {
    if(signal?.aborted)return Promise.reject(signal.reason);
    if (this.pending.size >= 32) return Promise.reject(new Error(moteText("后台任务繁忙，请稍后重试")));
    if (!this.worker) {
      // Source tests use tsx; packaged production loads only compiled CommonJS.
      const source = __filename.endsWith('.ts');
      const worker = this.worker = new Worker(source
        ? "require('tsx/cjs'); require(require('node:worker_threads').workerData.entry)"
        : join(__dirname, 'background-worker.js'), source ? { eval: true, workerData: { entry: join(__dirname, 'background-worker.ts') }, execArgv: [] } : { execArgv: [] });
      worker.on('message', (message: { id: number; progress?: WorkProgress; error?: string; value?: unknown }) => {
        const job = this.pending.get(message.id); if (!job) return;
        if (message.progress) {
          try { job.progress?.(message.progress); }
          finally {
            if(job.progressAck && job.cancellation){Atomics.add(job.cancellation,1,1);Atomics.notify(job.cancellation,1);}
          }
          return;
        }
        this.pending.delete(message.id);job.cleanup();
        // Once the export worker has reserved its final rename, a later abort
        // cannot truthfully turn a completed write into an AbortError.
        if(cancellationWon(job)){job.reject(job.signal!.reason);}
        else if (message.error) job.reject(new Error(message.error)); else job.resolve(message.value);
        if (!this.pending.size) worker.unref();
      });
      const failed = () => {
        if (this.worker !== worker) return;
        this.worker = undefined;
        for (const job of this.pending.values()){job.cleanup();job.reject(cancellationWon(job)?job.signal!.reason:new Error(moteText("后台处理进程已退出，请重试；原数据保留")));}
        this.pending.clear();
      };
      worker.on('error', failed); worker.on('exit', failed);
    }
    const id = ++this.nextId;
    this.worker.ref();
    return new Promise<T>((resolve, reject) => {
      const commitAware=request.kind==='archive-export';
      const cancellation=signal?new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT*2)):undefined;
      const progressAck=Boolean(commitAware && cancellation && progress);
      const abort=()=>{if(cancellation){if(commitAware)Atomics.compareExchange(cancellation,0,0,1);else Atomics.store(cancellation,0,1);}};
      signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
      const cleanup=()=>signal?.removeEventListener('abort',abort);
      this.pending.set(id, { resolve: value => resolve(value as T), reject, progress,signal,cancellation,commitAware,progressAck,cleanup });
      try { this.worker!.postMessage({ id, request, locale: getLocale(),cancellation:cancellation?.buffer,progressAck }); }
      catch (error) { this.pending.delete(id);cleanup(); if (!this.pending.size) this.worker!.unref(); reject(error); }
    });
  }
  async close(): Promise<void> { await this.worker?.terminate(); }
}
// A long archive job cannot delay screen filtering or visible thumbnails.
export const archiveWork = new BackgroundLane();
export const imageWork = new BackgroundLane();
export const previewWork = new BackgroundLane();

export const sourceWork = new BackgroundLane();
