import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { InferenceProcess } from '../src/inference-process';

class FixtureChild extends EventEmitter {
  messages: { id: string; payload: unknown }[] = [];
  killed = false;
  postMessage(value: unknown) { this.messages.push(value as { id: string; payload: unknown }); }
  kill() { this.killed = true; this.emit('exit', 137); return true; }
  reply(result: unknown) { this.emit('message', { id: this.messages.at(-1)!.id, ok: true, result }); }
}

describe('isolated native inference lifecycle', () => {
  it('matches request IDs, reuses a healthy process, and rejects overlapping work', async () => {
    const child = new FixtureChild(), factory = vi.fn(() => child);
    const worker = new InferenceProcess(factory);
    const first = worker.request({ fixture: 1 }, 1000);
    child.emit('message', { id: 'stale-response', ok: true, result: 'ignored' });
    await expect(worker.request({ fixture: 2 }, 1000)).rejects.toThrow('上一张');
    child.reply({ score: 0.1 }); await expect(first).resolves.toEqual({ score: 0.1 });
    const second = worker.request({ fixture: 3 }, 1000); child.reply({ score: 0.2 });
    await expect(second).resolves.toEqual({ score: 0.2 }); expect(factory).toHaveBeenCalledTimes(1);
    worker.close(); expect(child.killed).toBe(true);
  });
  it('kills a timed-out native worker and starts a fresh process on the next sample', async () => {
    const children: FixtureChild[] = [];
    const worker = new InferenceProcess(() => { const child = new FixtureChild(); children.push(child); return child; });
    await expect(worker.request({ fixture: 'hang' }, 10)).rejects.toThrow('超时');
    expect(children[0].killed).toBe(true); expect(worker.getState()).toBe('error');
    const resumed = worker.request({ fixture: 'recover' }, 1000);
    children[0].reply({ score: 0.99 }); // A late result from a discarded native generation cannot authorize a new frame.
    children[1].reply({ score: 0.01 }); await expect(resumed).resolves.toEqual({ score: 0.01 });
    worker.close();
  });
  it('contains crashes, cancels in-flight requests, and forbids respawning after close', async () => {
    const children: FixtureChild[] = [];
    const worker = new InferenceProcess(() => { const child = new FixtureChild(); children.push(child); return child; });
    const crashed = worker.request({}, 1000); children[0].emit('exit', 139);
    await expect(crashed).rejects.toThrow('已退出');
    const abort = new AbortController(), canceled = worker.request({}, 1000, abort.signal); abort.abort();
    await expect(canceled).rejects.toThrow('取消'); expect(children[1].killed).toBe(true);
    worker.close(); await expect(worker.request({}, 1000)).rejects.toThrow('已关闭'); expect(children).toHaveLength(2);
  });
  it('does not expose child error contents and recycles failed workers', async () => {
    const child = new FixtureChild(), worker = new InferenceProcess(() => child);
    const run = worker.request({}, 1000);
    child.emit('message', { id: child.messages[0].id, ok: false, error: 'synthetic-private-text' });
    await expect(run).rejects.toThrow('本地模型推理失败'); expect(child.killed).toBe(true);
    worker.close();
  });
});
