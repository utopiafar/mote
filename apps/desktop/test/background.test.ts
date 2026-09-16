import { afterAll, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { archiveWork, imageWork, previewWork, BackgroundLane } from '../src/background';
import { BackgroundJobs } from '../src/background-jobs';
import { DurableQueue } from '../src/queue';
import { defaultConfig } from '../src/config';
import { event, image } from './fixtures';

afterAll(async () => { await Promise.all([archiveWork.close(), imageWork.close(), previewWork.close()]); });
it('round trips a file archive in workers, reports progress and rejects conflicts before mutation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mote-background-fixture-'));
  try {
    const source = new DurableQueue(join(directory, 'source'), defaultConfig()); await source.initialize();
    const first = event(); await source.enqueue(first, image);
    const path = join(directory, 'backup.json'), progress: string[] = [];
    await source.exportArchiveFile(path, value => progress.push(value.message));
    const target = new DurableQueue(join(directory, 'target'), defaultConfig()); await target.initialize();
    expect(await target.importArchiveFile(path, value => progress.push(value.message))).toBe(1);
    expect(await target.importArchiveFile(path)).toBe(0);
    expect((await target.exportArchive()).records[0].event).toEqual(first);
    expect(await target.imageForBrowser(first.id)).toEqual(image);
    expect(progress).toContain('正在校验备份'); expect(progress).toContain('正在保存导入记录');
    const archive = JSON.parse(await readFile(path, 'utf8'));
    archive.records.unshift({ ...archive.records[0], event: event() });
    archive.records[1].event.ocrText = 'GENERATED CONFLICT';
    await writeFile(path, JSON.stringify(archive));
    await expect(target.importArchiveFile(path)).rejects.toThrow('冲突');
    expect(target.stats().depth).toBe(1);
    archive.records[1].event.ocrText = first.ocrText;
    archive.blobs[archive.records[0].blobHash] = 'invalid';
    await writeFile(path, JSON.stringify(archive));
    await expect(target.importArchiveFile(path)).rejects.toThrow();
    expect(target.stats().depth).toBe(1);
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 20_000);
it('keeps main-loop heartbeats alive during generated image work and preserves masks and BGRA colours', async () => {
  const width = 1024, height = 1024, bytes = Buffer.alloc(width * height * 4);
  for (let i = 0; i < bytes.length; i += 4) { bytes[i + 2] = 255; bytes[i + 3] = 255; }
  let ticks = 0; const timer = setInterval(() => ticks++, 5);
  try {
    const masked = await imageWork.run<Uint8Array>({ kind: 'mask', bytes, width, height, rectangles: [{ x: 0, y: 0, width: .5, height: 1 }] });
    const jpeg = await imageWork.run<Uint8Array>({ kind: 'jpeg', bytes: masked, width, height, quality: 90 });
    const rgb = await sharp(Buffer.from(jpeg)).removeAlpha().raw().toBuffer();
    expect([...rgb.subarray(0, 3)]).toEqual([0, 0, 0]);
    expect(rgb[(width - 10) * 3]).toBeGreaterThan(240); expect(rgb[(width - 10) * 3 + 2]).toBeLessThan(10);
    const preview = await previewWork.run<string>({ kind: 'preview', bytes: jpeg, thumbnail: true });
    expect((await sharp(Buffer.from(preview.split(',')[1], 'base64')).metadata()).width).toBe(480);
    expect(ticks).toBeGreaterThan(0);
  } finally { clearInterval(timer); }
}, 20_000);
it('reports worker termination and permits a subsequent retry', async () => {
  const lane = new BackgroundLane();
  const pending = lane.run({ kind: 'hash', bytes: Buffer.alloc(16_000_000) });
  const failure = expect(pending).rejects.toThrow('后台');
  await lane.close(); await failure;
  expect(await lane.run({ kind: 'hash', bytes: Buffer.from('fixture') })).toMatch(/^[a-f0-9]{64}$/);
  await lane.close();
});
it('progress snapshots stay available while a job runs; duplicates cannot start and failure releases the slot', async () => {
  const jobs = new BackgroundJobs(); let reject!: (error: Error) => void;
  const pending = jobs.run('import', '导入', () => new Promise<void>((_, fail) => { reject = fail; }));
  await Promise.resolve(); jobs.progress('import', { message: '校验', completed: 2, total: 8 });
  expect(jobs.snapshot()[0]).toMatchObject({ state: 'running', completed: 2, total: 8 });
  await expect(jobs.run('import', '导入', () => {})).rejects.toThrow('正在进行');
  reject(new Error('fixture')); await expect(pending).rejects.toThrow('fixture');
  expect(jobs.snapshot()[0].state).toBe('failed');
  await jobs.run('import', '导入', () => {}); expect(jobs.snapshot()[0].state).toBe('completed');
});
