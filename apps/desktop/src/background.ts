import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import type { Rectangle } from './contracts';

export interface WorkProgress { message: string; completed?: number; total?: number }
export type BackgroundRequest =
  | { kind: 'json-write'; path: string; value: unknown; maximum?: number }
  | { kind: 'json-read'; path: string }
  | { kind: 'browse'; records: { id: string; at: string }[]; after: string; before: string; offset: number; limit: number }
  | { kind: 'hash'; bytes: Uint8Array }
  | { kind: 'vision'; bytes: Uint8Array; width: number; height: number; maxSide: number }
  | { kind: 'mask'; bytes: Uint8Array; width: number; height: number; rectangles: Rectangle[] }
  | { kind: 'jpeg'; bytes: Uint8Array; width: number; height: number; quality: number }
  | { kind: 'preview'; bytes: Uint8Array; thumbnail: boolean }
  | { kind: 'archive-export'; directory: string; path: string }
  | { kind: 'archive-prepare'; path: string; staging: string };

/** CPU work stays in a Node worker, including image codecs and bulk JSON. No Electron APIs here. */
export class BackgroundLane {
  private worker?: Worker;
  private nextId = 0;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; progress?: (value: WorkProgress) => void }>();
  run<T>(request: BackgroundRequest, progress?: (value: WorkProgress) => void): Promise<T> {
    if (this.pending.size >= 32) return Promise.reject(new Error('后台任务繁忙，请稍后重试'));
    if (!this.worker) {
      // Source tests use tsx; packaged production loads only compiled CommonJS.
      const source = __filename.endsWith('.ts');
      const worker = this.worker = new Worker(source
        ? "require('tsx/cjs'); require(require('node:worker_threads').workerData.entry)"
        : join(__dirname, 'background-worker.js'), source ? { eval: true, workerData: { entry: join(__dirname, 'background-worker.ts') }, execArgv: [] } : { execArgv: [] });
      worker.on('message', (message: { id: number; progress?: WorkProgress; error?: string; value?: unknown }) => {
        const job = this.pending.get(message.id); if (!job) return;
        if (message.progress) { job.progress?.(message.progress); return; }
        this.pending.delete(message.id);
        if (message.error) job.reject(new Error(message.error)); else job.resolve(message.value);
        if (!this.pending.size) worker.unref();
      });
      const failed = () => {
        if (this.worker !== worker) return;
        this.worker = undefined;
        for (const job of this.pending.values()) job.reject(new Error('后台处理进程已退出，请重试；原数据保留'));
        this.pending.clear();
      };
      worker.on('error', failed); worker.on('exit', failed);
    }
    const id = ++this.nextId;
    this.worker.ref();
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: value => resolve(value as T), reject, progress });
      try { this.worker!.postMessage({ id, request }); }
      catch (error) { this.pending.delete(id); if (!this.pending.size) this.worker!.unref(); reject(error); }
    });
  }
  async close(): Promise<void> { await this.worker?.terminate(); }
}
// A long archive job cannot delay screen filtering or visible thumbnails.
export const archiveWork = new BackgroundLane();
export const imageWork = new BackgroundLane();
export const previewWork = new BackgroundLane();

export const sourceWork = new BackgroundLane();
