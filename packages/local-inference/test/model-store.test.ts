import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { ModelStore, VisionModelStore, parseVisionDecision, validateModelUrl, QWEN_MODEL } from '../dist/index.js';

const body = Buffer.from('synthetic-model-for-downloader-tests');
const manifest = { ...QWEN_MODEL.files[0], size: body.length, sha256: createHash('sha256').update(body).digest('hex') };
const directories: string[] = [];
async function setup(fetcher: typeof fetch) {
  const dir = await mkdtemp(join(tmpdir(), 'mote-model-test-')); directories.push(dir);
  return { dir, store: new ModelStore(dir, manifest, fetcher, 1) };
}
afterEach(async () => { await Promise.all(directories.splice(0).map(p => rm(p, { force: true, recursive: true }))); });
describe('verified model delivery', () => {
  it('persists only verified complete files and verifies same-size tampering', async () => {
    let calls = 0;
    const { store } = await setup(async () => { calls++; return new Response(body); });
    expect((await store.inspect()).state).toBe('missing');
    await store.download({ source: 'official' });
    expect((await store.inspect()).state).toBe('ready');
    expect(await store.verifiedPath()).toBe(store.path);
    await store.download({ source: 'official' }); expect(calls).toBe(1);
    await writeFile(store.path, Buffer.alloc(body.length));
    expect((await store.inspect()).state).toBe('invalid');
    await expect(store.verifiedPath()).rejects.toThrow('校验失败');
  });
  it('resumes an interrupted transfer after restart with validated Content-Range', async () => {
    const { dir, store } = await setup(async (_url, init) => {
      expect((init?.headers as Record<string,string>).Range).toBe('bytes=7-');
      return new Response(body.subarray(7), { status: 206, headers: { 'Content-Range': `bytes 7-${body.length-1}/${body.length}` } });
    });
    await writeFile(join(dir, manifest.fileName + '.part'), body.subarray(0, 7));
    expect((await store.inspect()).state).toBe('partial');
    await store.download({ source: 'official' });
    expect(await readFile(store.path)).toEqual(body);
  });
  it('restarts if a CDN ignores Range and falls back from a failed mirror', async () => {
    const seen: string[] = [];
    const { store } = await setup(async url => {
      seen.push(String(url));
      return String(url).includes('modelscope') ? new Response('', { status: 503 }) : new Response(body);
    });
    await writeFile(store.path + '.part', body.subarray(0, 7));
    await store.download({ source: 'auto' });
    expect(seen.filter(url => url.includes('modelscope'))).toHaveLength(3);
    expect(await readFile(store.path)).toEqual(body);
  });
  it('rejects incorrect Content-Range without corrupting the partial', async () => {
    const { store } = await setup(async () => new Response(body.subarray(7), { status: 206, headers: { 'Content-Range': `bytes 8-${body.length-1}/${body.length}` } }));
    await writeFile(store.path + '.part', body.subarray(0, 7));
    await expect(store.download({ source: 'official' })).rejects.toThrow('下载或校验失败');
    expect(await readFile(store.path + '.part')).toEqual(body.subarray(0, 7));
  });
  it('rejects corrupt, oversized, and truncated responses', async () => {
    for (const response of [Buffer.alloc(body.length), Buffer.alloc(body.length + 1), body.subarray(0, 7)]) {
      const { store } = await setup(async () => new Response(response));
      await expect(store.download({ source: 'official' })).rejects.toThrow('下载或校验失败');
      await expect(store.verifiedPath()).rejects.toThrow();
    }
  });
  it('follows HTTPS mirrors but refuses redirects to plaintext', async () => {
    const { store } = await setup(async url => String(url).includes('modelscope')
      ? new Response(null, { status: 308, headers: { location: manifest.urls.official } }) : new Response(body));
    await store.download({ source: 'mirror' }); expect((await store.inspect()).state).toBe('ready');
    const bad = await setup(async () => new Response(null, { status: 302, headers: { location: 'http://example.test/model.onnx' } }));
    await expect(bad.store.download({ source: 'official' })).rejects.toThrow();
  });
  it('keeps the last valid model when an offline import is invalid', async () => {
    const { dir, store } = await setup(async () => new Response(body));
    await store.download({ source: 'official' });
    const source = join(dir, 'import.onnx'); await writeFile(source, Buffer.alloc(body.length));
    await expect(store.importFile(source)).rejects.toThrow('SHA-256');
    expect((await store.inspect()).state).toBe('ready');
    await writeFile(source, body); await store.importFile(source);
    expect(await readFile(store.path)).toEqual(body);
  });
  it('cancels without installing a model, preserving a resumable partial', async () => {
    const controller = new AbortController();
    const { store } = await setup(async () => new Response(body));
    await expect(store.download({ source: 'official', signal: controller.signal, onProgress: ({ bytes }) => {
      if (bytes) controller.abort(new Error('user cancel'));
    } })).rejects.toThrow('user cancel');
    expect((await store.inspect()).state).toBe('partial');
    expect(await readFile(store.path + '.part')).toEqual(body);
    await store.download({ source: 'official' }); expect((await store.inspect()).state).toBe('ready');
  });
  it('does not allow concurrent downloads through another store instance', async () => {
    let release!: (r: Response) => void;
    const { dir, store } = await setup(async () => new Promise(resolve => { release = resolve; }));
    const downloading = store.download({ source: 'official' });
    while (!release) await new Promise(resolve => setTimeout(resolve, 1));
    await expect(new ModelStore(dir, manifest).download({ source: 'official' })).rejects.toThrow('正在下载');
    release(new Response(body)); await downloading;
  });
});
describe('explicit model decision contract', () => {
  it('requires a complete strict model decision without keyword or confidence fallback', () => {
    expect(parseVisionDecision('{"allow":false,"reason":"explicit image","labels":["nsfw"]}')).toEqual({allow:false, reason:'explicit image', labels:['nsfw']});
    expect(parseVisionDecision('{"allow":true}')).toEqual({allow:true});
    for (const raw of ['yes', '```json\n{"allow":true}\n```', '{"allow":"true"}', '{"allow":true,"score":0.9}', '{}', 'null', '[]', '{"allow":false', '{"allow":true,"labels":[1]}', JSON.stringify({allow:true,reason:'x'.repeat(241)})]) expect(() => parseVisionDecision(raw)).toThrow();
  });
  it('permits explicit HTTPS NAS or ModelScope source but never plaintext or credentials', () => {
    expect(validateModelUrl('https://nas.example/model.onnx')).toContain('nas.example');
    for (const url of ['file:///secret', 'http://localhost/model', 'https://user:pass@example.com/a', 'https://example.com/a#fragment']) expect(() => validateModelUrl(url)).toThrow();
  });
});
