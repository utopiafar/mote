import { afterEach, expect, it, vi } from 'vitest';
import { imageFeatures, duplicateImage, type ImageDedupeMode } from '../src/image-dedupe';
import { UploadMeter, meteredBody } from '../src/upload-meter';
import { uploadCaptureBatch } from '../src/transport';
import { AskClient } from '../src/ask';
import { defaultConfig } from '../src/config';
import { captureAck,event, image } from './fixtures';

afterEach(() => vi.unstubAllGlobals());
const pixels = (value: number) => { const data = Buffer.alloc(32 * 32 * 4, value); for (let i = 3; i < data.length; i += 4) data[i] = 255; return data; };
it('uses Android perceptual thresholds and exact mode detects a one-channel pixel change', () => {
  const base = pixels(0), before = imageFeatures(base, 32, 32), changed = Buffer.from(base);
  changed[0] = 1;
  expect(duplicateImage(before, imageFeatures(changed, 32, 32), 'exact')).toBe(false);
  for (const mode of ['exact', 'conservative', 'balanced', 'aggressive'] as ImageDedupeMode[]) expect(duplicateImage(before, before, mode)).toBe(true);
  expect(duplicateImage(before, before, 'off')).toBe(false);
  for (let i = 0; i < 10; i++) for (let c = 0; c < 3; c++) changed[i * 4 + c] = 255;
  const after = imageFeatures(changed, 32, 32);
  expect(duplicateImage(before, after, 'conservative')).toBe(false);
  expect(duplicateImage(before, after, 'balanced')).toBe(true);
  expect(duplicateImage(before, imageFeatures(pixels(255), 32, 32), 'aggressive')).toBe(false);
  expect(duplicateImage(before, {...before, width: 31}, 'aggressive')).toBe(false);
});
it('protects row and block changes even when hash distance is zero', () => {
  const before = imageFeatures(pixels(0), 32, 32), thumb = new Uint8Array(1024);
  thumb.fill(63, 0, 32 * 8); // Below per-cell threshold but spans sixteen changed blocks.
  expect(duplicateImage(before, {...before, exactHash: 'changed', thumb}, 'aggressive')).toBe(false);
});
it('measures bytes in a rolling window and decays to zero during stalls', async () => {
  const meter = new UploadMeter(); meter.add(2048, 100); expect(meter.rate(100)).toBe(1024); expect(meter.rate(2100)).toBe(0);
  const payload = '生成数据'.repeat(40000); expect(await new Response(meteredBody(payload)).text()).toBe(payload);
});
it('validates every batch receipt before returning partial acknowledgements', async () => {
  const one = event(), two = {...event(), id: '00000000-0000-4000-8000-000000000099'};
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    const body = await new Response(init.body).json(); expect(body.captures).toHaveLength(2);
    return Response.json({results: [{...captureAck(one.id), status: 201}, {id: two.id, status: 503}]});
  }));
  const receipts = await uploadCaptureBatch({...defaultConfig(), token:'fixture'}, [{event: one, image}, {event: two}]);
  expect(receipts.get(one.id)).toBe(201); expect(receipts.get(two.id)).toBe(503);
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({results: [{id: one.id, status: 201}, {id: 'unknown', status: 201}]})));
  await expect(uploadCaptureBatch({...defaultConfig(), token:'fixture'}, [{event: one}])).rejects.toThrow('Invalid batch receipts');
});
it('keeps queued captures when a v2 batch route is unavailable', async () => {
  const capture = event(); const urls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async url => {
    urls.push(String(url)); return new Response('{}', {status:404});
  }));
  await expect(uploadCaptureBatch({...defaultConfig(), token:'fixture'}, [{event: capture}])).rejects.toMatchObject({httpStatus:404});
  expect(urls.map(url => new URL(url).pathname)).toEqual(['/api/captures/batch']);
});
it('keeps ask credentials scoped to one origin and blocks arbitrary endpoints', async () => {
  const client = new AskClient(), config = {...defaultConfig(), credentialScope:'collector' as const, token:'device'.repeat(8)};
  const fetcher = vi.fn(async () => Response.json({items:[]})); vi.stubGlobal('fetch', fetcher);
  await expect(client.request(config, 'history')).rejects.toThrow('所有者'); expect(fetcher).not.toHaveBeenCalled();
  await client.request(config, 'login', {token:'owner'.repeat(8)});
  await client.request(config, 'history'); expect(fetcher.mock.calls[0][1].headers.Authorization).toBe('Bearer ' + 'owner'.repeat(8));
  await expect(client.request(config, 'run', {id:'../configuration'})).rejects.toThrow('Invalid ID');
  await expect(client.request({...config, serverUrl:'https://other.example'}, 'history')).rejects.toThrow('所有者');
});
