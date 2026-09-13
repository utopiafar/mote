import { randomUUID } from 'node:crypto';

export type InferenceProcessState = 'stopped' | 'starting' | 'ready' | 'running' | 'error';
export interface InferenceChild {
  postMessage(message: unknown): void;
  kill(): boolean;
  on(event: 'message', listener: (message: unknown) => void): this;
  on(event: 'exit', listener: (code: number) => void): this;
}
export interface InferenceReply { id: string; ok: boolean; result?: unknown; error?: string }

/** One bounded request at a time; a native crash never belongs to the Electron UI process. */
export class InferenceProcess {
  private child?: InferenceChild;
  private closed = false;
  private pending?: { id: string; resolve: (value: unknown) => void; reject: (error: Error) => void; cleanup: () => void };
  private state: InferenceProcessState = 'stopped';
  constructor(private readonly spawn: () => InferenceChild, private readonly onState: (state: InferenceProcessState, error?: string) => void = () => undefined) {}
  private publish(state: InferenceProcessState, error?: string): void { this.state = state; this.onState(state, error); }
  private start(): InferenceChild {
    if (this.child) return this.child;
    const child = this.spawn();
    this.child = child;
    this.publish('starting');
    child.on('message', value => {
      if (this.child !== child || !this.pending) return;
      const reply = value as InferenceReply;
      if (!reply || reply.id !== this.pending.id) return;
      if (typeof reply.ok !== 'boolean') { this.fail('本地推理进程返回无效结果；本次截图已跳过'); return; }
      const pending = this.pending;
      this.pending = undefined; pending.cleanup();
      if (reply.ok) { this.publish('ready'); pending.resolve(reply.result); }
      else {
        // Child messages never contain input pixels, OCR, model paths or user content.
        const message = '本地模型推理失败；已回收推理进程，下次采样重新加载';
        this.terminate(); this.publish('error', message); pending.reject(new Error(message));
      }
    });
    child.on('exit', () => {
      if (this.child !== child) return;
      this.child = undefined;
      this.fail('本地推理进程已退出；本次截图已跳过，下次采样自动恢复');
    });
    return child;
  }
  private terminate(): void {
    const child = this.child;
    this.child = undefined;
    child?.kill();
  }
  private fail(message: string, name = 'Error'): void {
    const pending = this.pending; this.pending = undefined;
    this.terminate(); this.publish('error', message);
    if (pending) { pending.cleanup(); pending.reject(Object.assign(new Error(message), { name })); }
  }
  request<T>(payload: unknown, timeoutMs: number, signal?: AbortSignal): Promise<T> {
    if (this.closed) return Promise.reject(new Error('本地推理客户端已关闭'));
    if (this.pending) return Promise.reject(new Error('本地推理正在处理上一张截图；本次已跳过'));
    if (signal?.aborted) return Promise.reject(new Error('本地推理已取消'));
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 180000) return Promise.reject(new Error('本地推理超时参数无效'));
    let child: InferenceChild;
    try { child = this.start(); } catch { this.publish('error', '无法启动本地推理进程'); return Promise.reject(new Error('无法启动本地推理进程；本次截图已跳过')); }
    return new Promise<T>((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => this.fail('本地推理超时；已终止独立进程，本次截图已跳过', 'TimeoutError'), timeoutMs);
      const abort = () => this.fail('本地推理已取消；本次截图已跳过', 'AbortError');
      this.pending = { id, resolve: value => resolve(value as T), reject, cleanup: () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); } };
      signal?.addEventListener('abort', abort, { once: true });
      this.publish('running');
      try { child.postMessage({ id, payload }); } catch { this.fail('无法发送本地推理请求；本次截图已跳过'); }
    });
  }
  reset(): void {
    const pending = this.pending; this.pending = undefined;
    this.terminate();
    if (pending) { pending.cleanup(); pending.reject(new Error('本地推理已重新加载；本次截图已跳过')); }
    this.publish('stopped');
  }
  close(): void { this.closed = true; this.reset(); }
  getState(): InferenceProcessState { return this.state; }
}
