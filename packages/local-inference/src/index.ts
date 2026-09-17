import { moteText } from '@mote/shared/i18n';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readdir, rename, stat, unlink } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

export interface ModelManifest {
  role?: 'language' | 'vision'; fileName: string; size: number; sha256: string;
  urls: { mirror: string; official: string };
}
export interface VisionManifest {
  id: string; displayName: string; revision: string; totalBytes: number; files: ModelManifest[];
}
export const QWEN_MODEL: Readonly<VisionManifest> = Object.freeze(require('./qwen-manifest.json'));
export const DEFAULT_REVIEW_POLICY: string = require('node:fs').readFileSync(require('node:path').join(__dirname, 'review-policy.txt'), 'utf8').trim();
export const REVIEW_SYSTEM: string = require('node:fs').readFileSync(require('node:path').join(__dirname, 'review-system.txt'), 'utf8').trim();
export const REVIEW_GRAMMAR: string = require('node:fs').readFileSync(require('node:path').join(__dirname, 'review-grammar.gbnf'), 'utf8').trim();
export interface VisionDecision { allow: boolean; reason?: string; labels?: string[] }
export function parseVisionDecision(raw: string): VisionDecision {
  if (typeof raw !== 'string' || raw.length > 16000) throw new Error(moteText("本地视觉模型输出过大或无效"));
  const v: unknown = JSON.parse(raw.trim());
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(moteText("本地视觉模型必须返回 JSON 决策"));
  const r = v as Record<string, unknown>;
  if (typeof r.allow !== 'boolean' || Object.keys(r).some(k => !['allow', 'reason', 'labels'].includes(k))) throw new Error(moteText("本地视觉模型决策格式无效"));
  if (r.reason !== undefined && (typeof r.reason !== 'string' || r.reason.length > 240)) throw new Error(moteText("本地视觉模型原因格式无效"));
  if (r.labels !== undefined && (!Array.isArray(r.labels) || r.labels.length > 12 || r.labels.some(x => typeof x !== 'string' || x.length > 64))) throw new Error(moteText("本地视觉模型标签格式无效"));
  return r as unknown as VisionDecision;
}
export type ModelSource = 'auto' | 'mirror' | 'official' | 'custom';
export interface ModelProgress { bytes: number; totalBytes: number; source: string }
export interface ModelState { state: 'missing' | 'partial' | 'ready' | 'invalid'; bytes: number; totalBytes: number; path: string }
export interface DownloadOptions {
  source: ModelSource; customUrl?: string; signal?: AbortSignal; onProgress?: (progress: ModelProgress) => void;
}
export function validateModelUrl(value: string): string {
  const u = new URL(value);
  if (u.protocol !== 'https:' || u.username || u.password || u.hash) throw new Error(moteText("模型下载需要不含账号及片段的 HTTPS 文件地址"));
  return u.toString();
}
function validateManifest(m: ModelManifest): void {
  if (!/^[a-zA-Z0-9._-]+$/.test(m.fileName) || m.fileName === '.' || m.fileName === '..' || !/^[a-f0-9]{64}$/.test(m.sha256) || !Number.isSafeInteger(m.size) || m.size <= 0) throw new Error(moteText("模型清单无效"));
  validateModelUrl(m.urls.official); validateModelUrl(m.urls.mirror);
}
async function bytesAt(path: string): Promise<number> {
  try { return (await stat(path)).size; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 0; throw e; }
}
export async function verifyModelFile(path: string, m: ModelManifest = QWEN_MODEL.files[0]!): Promise<boolean> {
  if (await bytesAt(path) !== m.size) return false;
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex') === m.sha256;
}

// No cookies, credentials or capture content are ever sent by this downloader.
// Handle redirects explicitly so an HTTPS model URL cannot downgrade to HTTP.
async function fetchModel(url: string, headers: Record<string, string>, signal: AbortSignal, fetcher: typeof fetch): Promise<Response> {
  for (let redirects = 0; redirects <= 8; redirects++) {
    const response = await fetcher(validateModelUrl(url), { headers, signal, redirect: 'manual', credentials: 'omit' });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    await response.body?.cancel();
    const location = response.headers.get('location');
    if (!location) throw new Error(moteText("模型下载重定向缺少地址"));
    url = new URL(location, url).toString();
  }
  throw new Error(moteText("模型下载重定向过多"));
}
const activeDirectories = new Set<string>();
export class ModelStore {
  readonly path: string;
  private partialPath = '';
  private readonly directory: string;
  constructor(directory: string, private readonly manifest: ModelManifest = QWEN_MODEL.files[0]!, private readonly fetcher: typeof fetch = fetch,
    private readonly retryDelayMs = 1000) {
    validateManifest(manifest);
    this.directory = resolve(directory); this.path = join(this.directory, manifest.fileName);
  }
  private async partials(): Promise<string[]> {
    try { return (await readdir(this.directory)).filter(name => name === basename(this.path) + '.part' || name.startsWith(basename(this.path) + '.part-')).map(name => join(this.directory, name)); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e; }
  }
  private async claimPartial(): Promise<void> {
    for (const candidate of await this.partials()) {
      if (candidate !== this.path + '.part') {
        const pid = Number(candidate.slice((this.path + '.part-').length).split('-')[0]);
        if (!Number.isSafeInteger(pid) || pid <= 0) continue;
        try { process.kill(pid, 0); continue; }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') continue; }
      }
      try { await rename(candidate, this.partialPath); return; }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    }
  }
  async inspect(): Promise<ModelState> {
    const bytes = await bytesAt(this.path);
    const partial = Math.max(0, ...await Promise.all((await this.partials()).map(bytesAt)));
    const state = bytes ? (await verifyModelFile(this.path, this.manifest) ? 'ready' : 'invalid') : partial ? 'partial' : 'missing';
    return { state, bytes: bytes || partial, totalBytes: this.manifest.size, path: this.path };
  }
  async verifiedPath(): Promise<string> {
    if (!await verifyModelFile(this.path, this.manifest)) throw new Error(moteText("千问视觉模型缺失或校验失败，请先下载或导入模型；截图已跳过"));
    return this.path;
  }
  private async exclusive<T>(action: () => Promise<T>): Promise<T> {
    if (activeDirectories.has(this.directory)) throw new Error(moteText("模型正在下载或导入，请等待或取消当前操作"));
    activeDirectories.add(this.directory);
    try { await mkdir(this.directory, { recursive: true, mode: 0o700 }); return await action(); }
    finally { activeDirectories.delete(this.directory); }
  }
  async importFile(source: string): Promise<string> {
    return this.exclusive(async () => {
      const temporary = this.path + '.' + randomUUID() + '.import';
      try {
        if (await bytesAt(source) !== this.manifest.size) throw new Error(moteText("导入文件大小与固定模型不符"));
        const out = await open(temporary, 'wx', 0o600);
        let total = 0;
        try {
          for await (const chunk of createReadStream(source)) {
            total += chunk.length;
            if (total > this.manifest.size) throw new Error(moteText("导入文件过大"));
            await out.writeFile(chunk);
          }
          await out.sync();
        } finally { await out.close(); }
        if (!await verifyModelFile(temporary, this.manifest)) throw new Error(moteText("导入模型 SHA-256 校验失败"));
        await rename(temporary, this.path);
        await unlink(this.path + '.part').catch(() => undefined);
        return this.path;
      } finally { await unlink(temporary).catch(() => undefined); }
    });
  }
  async download(options: DownloadOptions): Promise<string> {
    return this.exclusive(async () => {
      if (await verifyModelFile(this.path, this.manifest)) return this.path;
      this.partialPath = this.path + `.part-${process.pid}-${randomUUID()}`;
      await this.claimPartial();
      try {
      const sources = options.source === 'auto' ? ['mirror', 'official'] as const : [options.source];
      if (!sources.every(s => ['mirror', 'official', 'custom'].includes(s))) throw new Error(moteText("模型下载来源无效"));
      for (const source of sources) {
        const url = validateModelUrl(source === 'custom' ? options.customUrl ?? '' : this.manifest.urls[source as 'mirror' | 'official']);
        for (let attempt = 0; attempt < 3; attempt++) {
          options.signal?.throwIfAborted();
          try {
            await this.downloadOnce(url, source, options);
            if (!await verifyModelFile(this.partialPath, this.manifest)) {
              await unlink(this.partialPath); throw new Error(moteText("SHA-256 校验失败"));
            }
            options.signal?.throwIfAborted();
            await rename(this.partialPath, this.path);
            return this.path;
          } catch {
            options.signal?.throwIfAborted();
            if (attempt < 2) await new Promise<void>((resolve, reject) => {
              const onAbort = () => { clearTimeout(timer); reject(options.signal!.reason); };
              const timer = setTimeout(() => { options.signal?.removeEventListener('abort', onAbort); resolve(); }, this.retryDelayMs * 2 ** attempt);
              options.signal?.addEventListener('abort', onAbort, { once: true });
            });
          }
        }
      }
      throw new Error(moteText("模型下载或校验失败；已保留可续传部分，请重试、更换来源或离线导入"));
      } finally {
        // Each writer owns an inode. Only a closed file may become the shared resume file.
        // Another process can never retain a write handle to our verified final model.
        if (await bytesAt(this.partialPath)) {
          if (await bytesAt(this.path + '.part') <= await bytesAt(this.partialPath)) await rename(this.partialPath, this.path + '.part');
          else await unlink(this.partialPath);
        } else await unlink(this.partialPath).catch(() => undefined);
      }
    });
  }
  private async downloadOnce(url: string, source: string, options: DownloadOptions): Promise<void> {
    const partial = this.partialPath, m = this.manifest;
    let offset = await bytesAt(partial);
    if (offset > m.size) { await unlink(partial); offset = 0; }
    if (offset === m.size) return;
    const controller = new AbortController();
    const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
    let timer = setTimeout(() => controller.abort(new Error(moteText("模型下载连接超时"))), 45000);
    const touch = () => { clearTimeout(timer); timer = setTimeout(() => controller.abort(new Error(moteText("模型下载读取超时"))), 45000); };
    let response: Response | undefined;
    try {
      response = await fetchModel(url, { 'Accept-Encoding': 'identity', ...(offset ? { Range: `bytes=${offset}-` } : {}) }, signal, this.fetcher);
      if (response.status === 206) {
        const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') ?? '');
        if (!match || Number(match[1]) !== offset || Number(match[3]) !== m.size || Number(match[2]) !== m.size - 1) throw new Error(moteText("模型下载续传范围无效"));
      } else if (response.status === 200) offset = 0;
      else if (response.status === 416) { await unlink(partial).catch(() => undefined); throw new Error(moteText("模型下载范围已重置")); }
      else throw new Error(moteText("模型下载请求失败"));
      if (!response.body) throw new Error(moteText("模型下载内容为空"));
      const output = await open(partial, offset ? 'a' : 'w', 0o600);
      let received = offset;
      try {
        options.onProgress?.({ bytes: received, totalBytes: m.size, source });
        const reader = response.body.getReader();
        try {
          while (true) {
            touch(); const { done, value } = await reader.read();
            if (done) break;
            signal.throwIfAborted();
            if (received + value.length > m.size) throw new Error(moteText("模型下载响应超过清单大小"));
            await output.writeFile(value); received += value.length;
            options.onProgress?.({ bytes: received, totalBytes: m.size, source });
          }
        } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
        await output.sync();
      } finally { await output.close(); }
      if (received !== m.size) throw new Error(moteText("模型文件尚未下载完整"));
    } finally { clearTimeout(timer); await response?.body?.cancel().catch(() => undefined); }
  }
}

export interface VisionPaths { modelPath: string; projectorPath: string }
export class VisionModelStore {
  private readonly files: ModelStore[];
  constructor(private readonly directory: string, private readonly manifest: VisionManifest = QWEN_MODEL, fetcher: typeof fetch = fetch, retryDelayMs = 1000) {
    if (manifest.files.length !== 2 || manifest.files.filter(f => f.role === 'language').length !== 1 || manifest.files.filter(f => f.role === 'vision').length !== 1 || manifest.totalBytes !== manifest.files.reduce((n, f) => n + f.size, 0)) throw new Error(moteText("视觉模型清单无效"));
    this.files = manifest.files.map(file => new ModelStore(directory, file, fetcher, retryDelayMs));
  }
  async inspect(): Promise<ModelState> {
    const states = await Promise.all(this.files.map(f => f.inspect()));
    const state = states.every(s => s.state === 'ready') ? 'ready' : states.some(s => s.state === 'invalid') ? 'invalid' : states.some(s => s.bytes > 0) ? 'partial' : 'missing';
    return { state, bytes: states.reduce((n, s) => n + s.bytes, 0), totalBytes: this.manifest.totalBytes, path: resolve(this.directory) };
  }
  async verifiedPaths(): Promise<VisionPaths> {
    const paths = await Promise.all(this.files.map(file => file.verifiedPath()));
    return { modelPath: paths[this.manifest.files.findIndex(f => f.role === 'language')]!, projectorPath: paths[this.manifest.files.findIndex(f => f.role === 'vision')]! };
  }
  async download(options: DownloadOptions): Promise<VisionPaths> {
    let completed = 0;
    for (const [index, file] of this.files.entries()) {
      let customUrl: string | undefined;
      if (options.source === 'custom') {
        const base = new URL(validateModelUrl(options.customUrl ?? ''));
        if (base.search) throw new Error(moteText("自定义模型来源需要 HTTPS 目录，不含查询参数"));
        base.pathname = base.pathname.replace(/\/?$/, '/');
        customUrl = new URL(this.manifest.files[index]!.fileName, base).toString();
      }
      await file.download({ ...options, customUrl, onProgress: p => options.onProgress?.({ ...p, bytes: completed + p.bytes, totalBytes: this.manifest.totalBytes }) });
      completed += this.manifest.files[index]!.size;
      options.onProgress?.({ bytes: completed, totalBytes: this.manifest.totalBytes, source: options.source });
    }
    return this.verifiedPaths();
  }
  async importFiles(paths: string[]): Promise<void> {
    if (!Array.isArray(paths) || paths.length < 1 || paths.length > 2 || paths.some(p => typeof p !== 'string')) throw new Error(moteText("请选择语言模型与视觉模型文件，最多两个"));
    const matched: { index: number; path: string }[] = [];
    // Validate the full selection before replacing any existing file.
    for (const path of paths) {
      let index = -1;
      for (const [i, spec] of this.manifest.files.entries()) if (await verifyModelFile(path, spec)) { index = i; break; }
      if (index < 0 || matched.some(f => f.index === index)) throw new Error(moteText("模型文件与固定千问版本的大小或 SHA-256 不符，或重复选择"));
      matched.push({ index, path });
    }
    for (const item of matched) await this.files[item.index]!.importFile(item.path);
  }
}
