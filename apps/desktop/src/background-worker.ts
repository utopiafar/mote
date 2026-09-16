import {scanCodingAgent} from './coding-agents';
import {compressionPreview} from './compression-preview';
import { parentPort } from 'node:worker_threads';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import sharp from 'sharp';
import { prepareVisionImage } from './vision-image';
import { maskBitmap } from './privacy';
import { validateRecord, validateImage, type QueueArchive, type QueueRecord } from './queue';
import type { BackgroundRequest, WorkProgress } from './background';
import { configureLocalContent, encodeLocalContent, readLocalContent, type ContentPolicy } from './local-content';

async function execute(request: BackgroundRequest, progress: (value: WorkProgress) => void): Promise<unknown> {
  switch (request.kind) {
    case 'coding-scan': return scanCodingAgent(request.root,request.provider,request.options,request.checkpoint);
    case 'compression-preview': return compressionPreview(request.quality,request.maxSide);
    case 'browse': {
      const rows = request.records.filter(record => record.at >= request.after && record.at < request.before)
        .sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id));
      return { ids: rows.slice(request.offset, request.offset + request.limit).map(record => record.id), total: rows.length };
    }
    case 'json-read': {
      try { return JSON.parse((await readLocalContent(request.path)).toString('utf8')); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
    }
    case 'json-write': {
      const body = JSON.stringify(request.value);
      const encoded = encodeLocalContent(body);
      if (request.maximum !== undefined && encoded.length > request.maximum) throw new Error('来源待同步队列已满，请恢复网络后重试');
      await mkdir(dirname(request.path), { recursive: true, mode: 0o700 });
      const temporary = request.path + '.' + randomUUID() + '.tmp';
      try {
        const handle = await open(temporary, 'wx', 0o600);
        try { await handle.writeFile(encoded); await handle.sync(); } finally { await handle.close(); }
        await rename(temporary, request.path);
        if (process.platform !== 'win32') { const directory = await open(dirname(request.path), 'r'); try { await directory.sync(); } finally { await directory.close(); } }
      } finally { await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }); }
      return;
    }
    case 'hash': return createHash('sha256').update(request.bytes).digest('hex');
    case 'vision': return prepareVisionImage(request.bytes, request.width, request.height, request.maxSide);
    case 'mask': return maskBitmap(Buffer.from(request.bytes), request.width, request.height, request.rectangles);
    case 'jpeg': {
      const bytes = Buffer.from(request.bytes);
      if (bytes.length !== request.width * request.height * 4) throw new Error('截图像素格式不正确');
      // Electron supplies BGRA; libvips raw input expects RGBA.
      for (let i = 0; i < bytes.length; i += 4) { const blue = bytes[i]; bytes[i] = bytes[i + 2]; bytes[i + 2] = blue; }
      return sharp(bytes, { raw: { width: request.width, height: request.height, channels: 4 } }).removeAlpha().jpeg({ quality: request.quality }).toBuffer();
    }
    case 'preview': {
      let image = sharp(Buffer.from(request.bytes), { limitInputPixels: 16_777_216 }).rotate();
      if (request.thumbnail) image = image.resize(480, 480, { fit: 'inside', withoutEnlargement: true });
      return `data:image/jpeg;base64,${(await image.jpeg({ quality: request.thumbnail ? 70 : 90 }).toBuffer()).toString('base64')}`;
    }
    case 'archive-export': {
      const names = (await readdir(join(request.directory, 'events'))).filter(name => /^[0-9a-f-]{36}\.json$/i.test(name));
      const temporary = `${request.path}.${randomUUID()}.tmp`;
      const file = await open(temporary, 'wx', 0o600);
      const blobs = new Set<string>();
      try {
        await file.writeFile('{"format":"mote-desktop-queue","version":1,"records":[');
        for (let i = 0; i < names.length; i++) {
          const record = validateRecord(JSON.parse((await readLocalContent(join(request.directory, 'events', names[i]))).toString('utf8')));
          if (record.blobHash) blobs.add(record.blobHash);
          await file.writeFile((i ? ',' : '') + JSON.stringify(record));
          progress({ message: '正在导出记录', completed: i + 1, total: names.length });
        }
        await file.writeFile('],"blobs":{');
        let count = 0;
        for (const hash of blobs) {
          const bytes = await readLocalContent(join(request.directory, 'blobs', hash + '.jpg')); validateImage(bytes, hash);
          await file.writeFile((count ? ',' : '') + JSON.stringify(hash) + ':' + JSON.stringify(bytes.toString('base64')));
          progress({ message: '正在导出图片', completed: ++count, total: blobs.size });
        }
        await file.writeFile('}}'); await file.sync();
      } catch (error) { await file.close(); await unlink(temporary).catch(() => {}); throw error; }
      await file.close();
      try { await rename(temporary, request.path); }
      catch (error) { await unlink(temporary).catch(() => {}); throw error; }
      return;
    }
    case 'archive-prepare': {
      progress({ message: '正在读取和解析备份' });
      const input = await open(request.path, 'r');
      let archive: QueueArchive;
      try {
        if ((await input.stat()).size > 360 * 1024 * 1024) throw new Error('备份超过 360 MiB，请使用完整 queue 文件夹迁移');
        archive = JSON.parse(await input.readFile('utf8')) as QueueArchive;
      } finally { await input.close(); }
      if (archive?.format !== 'mote-desktop-queue' || archive.version !== 1 || !Array.isArray(archive.records) || archive.records.length > 1_000_000 || !archive.blobs || typeof archive.blobs !== 'object') throw new Error('不是 Mote 电脑端队列备份');
      await mkdir(join(request.staging, 'events'), { mode: 0o700 });
      await mkdir(join(request.staging, 'blobs'), { mode: 0o700 });
      const unique = new Map<string, QueueRecord>(), images = new Map<string, number>();
      for (let i = 0; i < archive.records.length; i++) {
        const record = validateRecord(archive.records[i]);
        if (record.blobHash) {
          if (!images.has(record.blobHash)) {
            const encoded = archive.blobs[record.blobHash];
            if (typeof encoded !== 'string' || encoded.length > 8 * 1024 * 1024 * 1.4) throw new Error('备份图片缺失或太大');
            const bytes = Buffer.from(encoded, 'base64'); validateImage(bytes, record.blobHash);
            await writeFile(join(request.staging, 'blobs', record.blobHash + '.jpg'), bytes, { mode: 0o600 });
            images.set(record.blobHash, bytes.length);
          }
          if (images.get(record.blobHash) !== record.blobBytes) throw new Error('备份图片长度不匹配');
        }
        const prior = unique.get(record.event.id);
        if (prior && (prior.blobHash !== record.blobHash || JSON.stringify(prior.event) !== JSON.stringify(record.event))) throw new Error('备份包含冲突的事件 ID');
        if (!prior) {
          unique.set(record.event.id, record);
          await writeFile(join(request.staging, 'events', record.event.id + '.json'), JSON.stringify({ ...record, uploaded: false, attempts: 0, nextAttemptAt: 0 }), { mode: 0o600 });
        }
        if (i % 100 === 0 || i + 1 === archive.records.length) progress({ message: '正在校验备份', completed: i + 1, total: archive.records.length });
      }
      return unique.size;
    }
  }
}
let chain = Promise.resolve();
parentPort!.on('message', ({ id, request, contentPolicy }: { id: number; request: BackgroundRequest; contentPolicy: ContentPolicy }) => {
  chain = chain.then(async () => {
    let lastProgress = 0;
    try {
      configureLocalContent(contentPolicy);
      const value = await execute(request, progress => {
        const now = Date.now(); if (now - lastProgress < 100 && progress.completed !== progress.total) return;
        lastProgress = now; parentPort!.postMessage({ id, progress });
      });
      parentPort!.postMessage({ id, value });
    } catch (error) { parentPort!.postMessage({ id, error: error instanceof Error ? error.message : '后台处理失败' }); }
  });
});
