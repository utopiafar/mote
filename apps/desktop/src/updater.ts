import { moteText, statusMessage } from '@mote/shared/i18n';
import { checkRelease, compareVersions, downloadReleaseAsset, selectReleaseAsset, type ReleaseAsset, type ReleaseManifest, type ReleaseChannel } from '@mote/shared/release';
import { mkdir, readFile, readdir, realpath, rm, stat, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { createReadStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { atomicSourceJson } from './source-sync';
import { inspectUpdateArchive } from './update-archive';
import { installationEligibility, inspectBundle, prepareInstall, startInstall, cancelPreparedInstall, recoverInterruptedUpdate } from './update-install';
const execute = promisify(execFile);
export interface UpdateStatus {
  manualDownload?: boolean;
  currentVersion: string; channel: ReleaseChannel;
  state: 'idle' | 'checking' | 'available' | 'up_to_date' | 'downloading' | 'verifying' | 'ready' | 'installing' | 'error';
  message: string; received: number; total: number; canInstall: boolean; installReason: string;
  availableVersion?: string; notesUrl?: string; checkedAt?: string;
}
export interface UpdateDependencies {
  check: typeof checkRelease; download: typeof downloadReleaseAsset;
  inspect: typeof inspectBundle; extract: (archive: string, destination: string) => Promise<void>;
}
async function verifyExtractedArchive(archive: string, asset: ReleaseAsset): Promise<void> {
  const hash = createHash('sha256'); let bytes = 0;
  for await (const chunk of createReadStream(archive)) { bytes += (chunk as Buffer).length; if (bytes > asset.size) throw new Error('UPDATE_STAGE_CHANGED'); hash.update(chunk); }
  if (bytes !== asset.size || hash.digest('hex') !== asset.sha256) throw new Error('UPDATE_STAGE_CHANGED');
}
const dependencies: UpdateDependencies = {
  check: checkRelease, download: downloadReleaseAsset, inspect: inspectBundle,
  extract: async (archive, destination) => { await execute('/usr/bin/ditto', ['-x', '-k', archive, destination], { timeout: 180000, maxBuffer: 32768 }); },
};
const messages: Record<string, string> = {
  get release_not_found() { return moteText("此渠道暂未提供可验证的发布清单。请稍后检查；旧版未签名发布不能用于应用内安装。"); },
  get release_rate_limited() { return moteText("GitHub 暂时限制请求，请稍后重试。"); },
  get invalid_manifest_signature() { return moteText("发布清单签名无效，已停止更新。"); }, get unknown_release_key() { return moteText("发布密钥不受此 App 信任，已停止更新。"); },
  get asset_checksum_mismatch() { return moteText("安装包校验失败，已删除不完整下载。请重新下载。"); }, get asset_size_mismatch() { return moteText("安装包大小不符，已停止更新。"); },
  get UPDATE_ARCHIVE_INVALID() { return moteText("安装包目录、压缩格式或链接不安全，已停止解压。"); }, get UPDATE_BUNDLE_INVALID() { return moteText("应用签名、版本或架构校验失败，未替换现有 App。"); },
  get UPDATE_STAGE_CHANGED() { return moteText("待安装应用在校验后发生变化，已停止安装，请重新下载。"); },
  get UPDATE_OTHER_PROFILES_RUNNING() { return moteText("同一个 App 还有其他 profile 正在运行。请先退出这些实例，再安装。"); },
  get UPDATE_INSTALL_LOCKED() { return moteText("另一个更新正在进行，或上次更新事务尚未结束。请保留应用旁的旧包并检查更新状态。"); },
  get UPDATE_TARGET_NOT_WRITABLE() { return moteText("应用目录不可写。请显示已验证安装包，用 Finder 手动替换 App。"); },
  get UPDATE_HELPER_NOT_READY() { return moteText("安装助手未能就绪，当前 App 保持运行。请检查应用目录并重试。"); },
};
export function updateMessage(error: unknown): string {
  const key = (error as { code?: string })?.code || (error as Error)?.message;
  return messages[key] || moteText("更新未完成，现有 App 与资料保持不变。请检查网络、磁盘空间后重试。");
}
export class DesktopUpdater {
  private value: UpdateStatus;
  private manifest?: ReleaseManifest;
  private asset?: ReleaseAsset;
  private archive?: string;
  private staged?: { path: string; digest: string };
  private task?: Promise<void>;
  private controller?: AbortController;
  private deps: UpdateDependencies;
  constructor(private options: { directory: string; helper: string; bundlePath?: string; currentVersion: string; arch: 'arm64' | 'x64'; profile: string }, deps: Partial<UpdateDependencies> = {}) {
    this.deps = { ...dependencies, ...deps };
    this.value = { currentVersion: options.currentVersion, channel: 'stable', state: 'idle', message: moteText("手动检查 GitHub utopiafar/mote 的已签名更新。"), received: 0, total: 0, canInstall: false, installReason: '' };
  }
  async initialize(): Promise<void> {
    await mkdir(this.options.directory, { recursive: true, mode: 0o700 });
    try { const value = JSON.parse(await readFile(join(this.options.directory, 'preferences.json'), 'utf8')); if (['stable', 'preview'].includes(value.channel)) this.value.channel = value.channel; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.value.message = moteText("更新渠道配置无法读取，暂按稳定渠道检查。现有资料未变动。"); }
    await this.cleanupDownloads().catch(() => { this.value.message = moteText("旧更新缓存暂时无法清理，请检查磁盘权限；采集资料未变动。"); });
    const eligibility = await installationEligibility(this.options.bundlePath, this.options.directory);
    this.value.canInstall = eligibility.allowed; this.value.installReason = eligibility.reason;
  }
  private async cleanupDownloads(): Promise<void> {
    const directory = join(this.options.directory, 'downloads');
    try {
      const canonicalDirectory = await realpath(directory);
      for (const name of await readdir(canonicalDirectory)) {
        if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(name)) continue;
        const path = join(canonicalDirectory, name), entry = await lstat(path);
        if (entry.isDirectory() && !entry.isSymbolicLink() && await realpath(path) === path) await rm(path, { recursive: true });
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('UPDATE_CACHE_UNAVAILABLE'); }
  }
  async startupCompleted(): Promise<void> {
    if (this.task || this.value.checkedAt || !['idle', 'error'].includes(this.value.state)) return;
    const recovery = await recoverInterruptedUpdate({ ...this.options, version: this.options.currentVersion });
    if (recovery === 'blocked') { this.value.state = 'error'; this.value.message = moteText("上次更新未能安全确认。已保留应用旁的恢复包，未删除资料。请备份并通过 Finder 手动恢复或替换 App。"); return; }
    try {
      const directory = join(this.options.directory, 'transactions');
      const entries = (await readdir(directory)).filter(name => /^[a-f0-9]{32}$/.test(name));
      const recent = (await Promise.all(entries.map(async name => ({ name, modified: (await stat(join(directory, name))).mtimeMs })))).sort((a, b) => b.modified - a.modified).slice(0, 20);
      for (const entry of recent) {
        try {
          const folder = join(directory, entry.name), job = JSON.parse(await readFile(join(folder, 'job.json'), 'utf8')), result = JSON.parse(await readFile(join(folder, 'result.json'), 'utf8'));
          if (this.task || this.value.checkedAt || !['idle', 'error'].includes(this.value.state)) return;
          if (job.targetPath !== this.options.bundlePath || job.profile !== this.options.profile) continue;
          if (result.state === 'installed' && result.version === this.options.currentVersion) this.value.message = moteText("更新已安装并完成启动确认。原有 profile、草稿、队列和模型保持原位。");
          else if (result.state === 'rolled_back') { this.value.state = 'error'; this.value.message = moteText("新版启动未确认，已自动恢复旧版 App。原有资料保持原位，可重新检查更新。"); }
          else if (result.state === 'failed') { this.value.state = 'error'; this.value.message = result.backupRetained ? moteText("更新未完成，旧应用恢复包已保留。请先备份并通过 Finder 检查应用旁的恢复包。") : moteText("上次更新未完成，现有 App 与资料保持原位。可重新检查更新。"); }
          break;
        } catch { /* Ignore incomplete receipts; no raw helper output reaches the UI. */ }
      }
    } catch { /* First launch has no update receipts. */ }
  }
  status(): UpdateStatus { return { ...this.value, message: statusMessage(this.value.message), installReason: statusMessage(this.value.installReason) }; }
  async setChannel(channel: unknown): Promise<UpdateStatus> {
    if (channel !== 'stable' && channel !== 'preview') throw new Error(moteText("更新渠道无效"));
    await this.cancel();
    await atomicSourceJson(join(this.options.directory, 'preferences.json'), { channel });
    this.value.channel = channel; this.manifest = undefined; this.asset = undefined; this.archive = undefined; this.staged = undefined;
    Object.assign(this.value, { state: 'idle', message: moteText("渠道已保存。点击检查更新。"), availableVersion: undefined, notesUrl: undefined, received: 0, total: 0 }); return this.status();
  }
  async check(): Promise<UpdateStatus> {
    if (this.task || this.value.state === 'installing') return this.status();
    const controller = new AbortController(); this.controller = controller;
    this.value.state = 'checking'; this.value.message = moteText("正在检查发布清单和签名…");
    this.task = (async () => {
      try {
        const result = await this.deps.check({ repository: 'utopiafar/mote', channel: this.value.channel, currentVersion: this.options.currentVersion, signal: controller.signal });
        this.manifest = structuredClone(result.manifest); this.asset = selectReleaseAsset(this.manifest, { component: 'desktop', platform: 'darwin', arch: this.options.arch, format: 'zip' });
        if (this.asset?.bundleId !== 'dev.mote.collector') this.asset = undefined;
        this.staged = undefined; this.archive = undefined;
        Object.assign(this.value, { state: result.available ? this.asset ? 'available' : 'error' : 'up_to_date', availableVersion: result.manifest.version, notesUrl: result.manifest.notesUrl, checkedAt: new Date().toISOString(), received: 0, total: this.asset?.size || 0,
          message: result.available ? this.asset ? moteText("发现已签名的新版本，可以下载并校验。") : moteText("此版本尚无适合当前 Mac 架构的更新包。") : moteText("当前版本已经是此渠道最新版本。") });
      } catch (error) { this.value.state = 'error'; this.value.message = controller.signal.aborted ? moteText("更新检查已取消。") : updateMessage(error); }
    })().finally(() => { this.task = undefined; this.controller = undefined; });
    await this.task; return this.status();
  }
  download(): UpdateStatus {
    if (this.task || this.value.state === 'installing') return this.status();
    if (!this.manifest || !this.asset || compareVersions(this.manifest.version, this.options.currentVersion) <= 0) throw new Error(moteText("请先检查可用更新"));
    const asset = structuredClone(this.asset), manifest = this.manifest, controller = new AbortController(); this.controller = controller;
    this.staged = undefined; this.archive = undefined;
    Object.assign(this.value, { state: 'downloading', message: moteText("下载经过签名清单绑定的安装包…"), received: 0, total: asset.size });
    this.task = (async () => {
      const folder = join(this.options.directory, 'downloads', randomUUID());
      try {
        await this.cleanupDownloads();
        await mkdir(folder, { recursive: true, mode: 0o700 });
        const archive = join(folder, asset.name);
        await this.deps.download(asset, archive, { signal: controller.signal, onProgress: (received, total) => { this.value.received = received; this.value.total = total; } });
        controller.signal.throwIfAborted(); this.value.state = 'verifying'; this.value.message = moteText("校验 ZIP 路径、应用签名、版本、架构和完整文件树…");
        const appName = await inspectUpdateArchive(archive); const extracted = join(folder, 'extracted'); await mkdir(extracted, { mode: 0o700 });
        await this.deps.extract(archive, extracted); await verifyExtractedArchive(archive, asset); controller.signal.throwIfAborted();
        const path = await realpath(join(extracted, appName));
        const bundle = await this.deps.inspect(this.options.helper, path, manifest.version, this.options.arch);
        controller.signal.throwIfAborted(); this.archive = archive; this.staged = { path, digest: bundle.digest };
        this.value.state = 'ready'; this.value.message = moteText("安装包与应用已校验。安装前将保存当前操作并退出 App。");
      } catch (error) {
        await rm(folder, { recursive: true, force: true }).catch(() => {});
        this.value.state = 'error'; this.value.message = controller.signal.aborted ? moteText("下载已取消。下次下载会从头开始。") : updateMessage(error);
      }
    })().finally(() => { this.task = undefined; this.controller = undefined; });
    return this.status();
  }
  archivePath(): string | undefined { return this.archive; }
  async cancel(): Promise<UpdateStatus> {
    if (this.value.state === 'installing') throw new Error(moteText("安装交接已开始，请等待新版本启动"));
    this.controller?.abort(); await this.task; return this.status();
  }
  async install(beforeQuit: () => Promise<void>, quit: () => void): Promise<void> {
    if (this.task || this.value.state !== 'ready' || !this.staged || !this.manifest || !this.asset || !this.options.bundlePath) throw new Error(moteText("没有可安装的已验证更新"));
    this.value.state = 'installing'; this.value.message = moteText("准备应用替换，等待保存当前操作…");
    let prepared: Awaited<ReturnType<typeof prepareInstall>> | undefined;
    try {
      // The staged tree is rechecked against the digest obtained from the verified archive, then copied alongside the target.
      prepared = await prepareInstall({ directory: this.options.directory, helper: this.options.helper, target: this.options.bundlePath, staged: this.staged.path, stagedDigest: this.staged.digest, oldVersion: this.options.currentVersion, newVersion: this.manifest.version, arch: this.options.arch, profile: this.options.profile, teamId: this.asset.signing === 'developer-id' ? this.asset.teamId : undefined });
      await beforeQuit(); await startInstall(prepared); quit();
    } catch (error) { if (prepared) await cancelPreparedInstall(prepared); this.value.state = 'error'; this.value.message = updateMessage(error); throw new Error(this.value.message); }
  }
  async close(): Promise<void> { if (this.value.state !== 'installing') { this.controller?.abort(); await this.task; } }
}
