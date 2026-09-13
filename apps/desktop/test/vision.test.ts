import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { NsfwController } from '../src/nsfw';
import { defaultConfig } from '../src/config';
import { prepareVisionImage } from '../src/vision-image';
import type { InferenceChild } from '../src/inference-process';
class Child extends EventEmitter {
  killed = false; payload?: any;
  constructor(private result: any) { super(); }
  kill() { this.killed = true; return true; }
  postMessage(value: any) { this.payload = value.payload; queueMicrotask(() => this.emit('message', { id: value.id, ok: true, result: this.result })); }
}
const config = defaultConfig();
const image = { bitmap: Buffer.from([1, 2, 3, 255]), width: 1, height: 1 };
const store = { inspect: async () => ({ state: 'ready' as const, bytes: 2, totalBytes: 2, path: '/fixture' }), verifiedPaths: async () => ({ modelPath: '/fixture/model', projectorPath: '/fixture/projector' }), download: async () => ({ modelPath: '/fixture/model', projectorPath: '/fixture/projector' }), importFiles: async () => undefined };
const output = (text: string, status = 'eos') => ({ text, status, backend: 'cpu', durationMs: 1, loadMs: 2, visionMs: 1, tokens: 10 });
describe('offline Qwen gate', () => {
  it('sends bounded RGB and user policy to the isolated process and keeps private model text out of telemetry', async () => {
    const child = new Child(output('{"allow":false,"reason":"private generated fixture","labels":["fixture"]}'));
    const gate = new NsfwController('/fixture', '/never/run', () => {}, { store, spawn: () => child as InferenceChild });
    expect(await gate.classify(image, config)).toEqual({ allow: false, blocked: true });
    expect(Buffer.from(child.payload.rgbBase64, 'base64')).toEqual(Buffer.from([3, 2, 1]));
    expect(child.payload.prompt).toBe(config.reviewPolicy);
    expect(child.payload).not.toHaveProperty('bitmap');
    expect(JSON.stringify(gate.status())).not.toContain('private generated');
    expect(gate.status().blockedCount).toBe(1); gate.close(); expect(child.killed).toBe(true);
  });
  it.each(['```json\n{"allow":true}\n```', '{"allow":"true"}', '{"allow":true,"score":0}', '{"allow":true,"reason":"' + 'a'.repeat(241) + '"}'])('rejects malformed model output and recreates the worker: %s', async text => {
    const first = new Child(output(text)), second = new Child(output('{"allow":true}'));
    let calls = 0;
    const gate = new NsfwController('/fixture', '/never/run', () => {}, { store, spawn: () => (++calls === 1 ? first : second) as InferenceChild });
    await expect(gate.classify(image, config)).rejects.toThrow('JSON'); expect(first.killed).toBe(true);
    expect(await gate.classify(image, config)).toEqual({ allow: true, blocked: false }); gate.close();
  });
  it('rejects a token-limited response even when its partial text parses', async () => {
    const child = new Child(output('{"allow":true}', 'max_tokens'));
    const gate = new NsfwController('/fixture', '/never/run', () => {}, { store, spawn: () => child as InferenceChild });
    await expect(gate.classify(image, config)).rejects.toThrow('JSON'); gate.close();
  });
  it('does not spawn any native process if either model is unavailable', async () => {
    let calls = 0;
    const gate = new NsfwController('/fixture', '/never/run', () => {}, { store: { ...store, verifiedPaths: async () => { throw new Error('missing'); } }, spawn: () => { calls++; throw new Error('should not spawn'); } });
    await expect(gate.classify(image, config)).rejects.toThrow('缺失'); expect(calls).toBe(0); gate.close();
  });
});
describe('bounded RGB preprocessing', () => {
  it('keeps aspect ratio and performs bilinear averaging with RGB order', () => {
    const result = prepareVisionImage(Buffer.from([0,0,255,255, 255,0,0,255]), 2, 1, 1);
    expect(result.width).toBe(1); expect(result.height).toBe(1); expect([...Buffer.from(result.rgbBase64, 'base64')]).toEqual([128,0,128]);
  });
  it('rejects inconsistent byte lengths', () => { expect(() => prepareVisionImage(Buffer.alloc(2), 2, 2, 512)).toThrow(); });
});
