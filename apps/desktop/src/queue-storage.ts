import { moteText } from '@mote/shared/i18n';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, readFile, realpath, rename, rm, rmdir, statfs, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export class StorageCommitUncertainError extends Error { constructor() { super(moteText("存储切换的提交状态需要恢复；新旧副本均已保留，请退出并重新打开 Mote")); } }
const OWNER = '.mote-storage.json';
interface Owner { format: 'mote-capture-storage'; version: 1; profile: string; deviceId: string; migrationId?: string }
interface Journal { version: 1; profile: string; deviceId: string; id: string; source: string; target: string; staging: string }
function inside(path: string, root: string): boolean { const diff = relative(root, path); return !diff || (diff !== '..' && !diff.startsWith('..' + sep) && !isAbsolute(diff)); }
async function exists(path: string): Promise<boolean> { try { await lstat(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; } }
async function syncDirectory(path: string): Promise<void> { const file = await open(path, 'r'); try { await file.sync(); } finally { await file.close(); } }
async function writeJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`, file = await open(temporary, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
  await rename(temporary, path); await syncDirectory(dirname(path));
}
async function checksum(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW), buffer = Buffer.allocUnsafe(64 * 1024), hash = createHash('sha256');
  try { while (true) { const { bytesRead } = await file.read(buffer, 0, buffer.length, null); if (!bytesRead) break; hash.update(buffer.subarray(0, bytesRead)); } return hash.digest('hex'); }
  finally { await file.close(); }
}
async function filesIn(root: string): Promise<{ path: string; bytes: number }[]> {
  const files: { path: string; bytes: number }[] = [];
  async function walk(path: string): Promise<void> {
    for (const item of await readdir(path, { withFileTypes: true })) {
      const file = join(path, item.name);
      if (path === root && item.name === OWNER) continue;
      if (item.isSymbolicLink()) throw new Error(moteText("存储目录含符号链接，不能安全迁移；原目录保持有效"));
      if (item.isDirectory()) await walk(file);
      else if (item.isFile()) files.push({ path: relative(root, file), bytes: (await lstat(file)).size });
      else throw new Error(moteText("存储目录含特殊文件，不能安全迁移"));
    }
  }
  await walk(root); return files;
}
async function copyVerified(source: string, target: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW), output = await open(target, 'wx', 0o600);
  const buffer = Buffer.allocUnsafe(64 * 1024), hash = createHash('sha256');
  try {
    while (true) { const { bytesRead } = await input.read(buffer, 0, buffer.length, null); if (!bytesRead) break; const chunk = buffer.subarray(0, bytesRead); hash.update(chunk); await output.writeFile(chunk); }
    await output.sync();
  } finally { await input.close(); await output.close(); }
  const expected = hash.digest('hex');
  if (await checksum(source) !== expected || await checksum(target) !== expected) throw new Error(moteText("迁移文件校验失败，原目录保持有效"));
}

/** The fixed profile config is authoritative. A copied old queue is never a failover location. */
export class QueueStorage {
  readonly defaultDirectory: string;
  readonly owner: Owner;
  cleanupPending = false;
  private readonly journalPath: string;
  constructor(readonly profileDirectory: string, readonly profileName: string, deviceId: string, private readonly protectedRoots: string[] = [profileDirectory]) {
    this.defaultDirectory = join(profileDirectory, 'queue'); this.journalPath = join(profileDirectory, 'queue-migration.json');
    this.owner = { format: 'mote-capture-storage', version: 1, profile: createHash('sha256').update(resolve(profileDirectory)).digest('hex'), deviceId };
  }
  private matches(value: Owner | undefined, migrationId?: string): boolean {
    return Boolean(value && value.format === this.owner.format && value.version === 1 && value.profile === this.owner.profile && value.deviceId === this.owner.deviceId && (!migrationId || value.migrationId === migrationId));
  }
  private async checkDirectory(path: string): Promise<void> {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== resolve(path)) throw new Error(moteText("截图目录不能是符号链接或其他文件；请重新选择"));
  }
  private async readOwner(path: string): Promise<Owner | undefined> {
    try { const info = await lstat(join(path, OWNER)); if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) throw new Error(moteText("存储目录归属标记无效")); return JSON.parse(await readFile(join(path, OWNER), 'utf8')) as Owner; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  }
  async assertOwned(path: string): Promise<void> {
    try { await this.checkDirectory(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(moteText("截图目录不可用；请连接原磁盘后重试，已有记录不会被空目录替代")); throw error; }
    if (!this.matches(await this.readOwner(path))) throw new Error(moteText("该存储目录不属于当前环境和设备，不能混用其他环境的队列"));
  }
  async open(configured: string): Promise<string> {
    const selected = configured || this.defaultDirectory;
    if (configured && !await exists(selected)) throw new Error(moteText("已选择的截图目录不可用；请连接原磁盘后重试。不会新建空队列或自动回退旧副本"));
    if (!configured) {
      if (!await exists(selected) && await exists(this.journalPath)) throw new Error(moteText("迁移恢复需要的原目录不可用；请连接原磁盘后重试，不会创建空队列"));
      await mkdir(selected, { recursive: true, mode: 0o700 }); await this.checkDirectory(selected);
      const owner = await this.readOwner(selected);
      if (!owner) await writeJson(join(selected, OWNER), this.owner);
      if (!await exists(this.journalPath)) {
        await mkdir(join(selected, 'events'), { recursive: true, mode: 0o700 }); await mkdir(join(selected, 'blobs'), { recursive: true, mode: 0o700 });
      }
    }
    await this.assertOwned(selected);
    // Existing custom queues and migration targets must be complete before initialize can create anything.
    if (configured || await exists(this.journalPath)) {
      await this.checkDirectory(join(selected, 'events')); await this.checkDirectory(join(selected, 'blobs'));
      const binding = await lstat(join(selected, 'connection-binding.json'));
      if (!binding.isFile() || binding.isSymbolicLink()) throw new Error(moteText("存储目录的节点绑定不完整；已保留迁移副本，请检查原磁盘"));
      await filesIn(selected); // Reject links before the queue reads any body.
    }
    return selected;
  }
  async candidate(parent: string, current: string): Promise<string> {
    await this.checkDirectory(parent);
    const target = join(await realpath(parent), `Mote-Captures-${this.profileName}-${this.owner.deviceId}`);
    if (target === current) return current;
    if (this.protectedRoots.some(root => inside(target, resolve(root)))) throw new Error(moteText("请选择 Mote 应用数据目录以外的文件夹，避免与其他环境或应用文件混用"));
    this.checkRelationship(current, target);
    if (await exists(target)) throw new Error(moteText("所选位置已有 Mote 存储目录；请选择其他文件夹，避免覆盖已有记录"));
    return target;
  }
  private checkRelationship(source: string, target: string): void {
    if (!isAbsolute(target) || target !== resolve(target) || source === target || inside(source, target) || inside(target, source)) throw new Error(moteText("新旧存储目录不能相同或互相嵌套"));
  }
  private async removeOwned(path: string, migrationId?: string): Promise<void> {
    if (!await exists(path)) return;
    await this.checkDirectory(path);
    if (!this.matches(await this.readOwner(path), migrationId)) {
      if (migrationId && (await readdir(path)).length === 0) { await rmdir(path); return; }
      throw new Error(moteText("旧副本归属无法确认，已保留待处理"));
    }
    await rm(path, { recursive: true }); await syncDirectory(dirname(path));
  }
  /** Call only after DurableQueue.initialize has validated the selected queue and its JPEG hashes. */
  async recover(selected: string): Promise<void> {
    let journal: Journal;
    try { const info = await lstat(this.journalPath); if (!info.isFile() || info.isSymbolicLink() || info.size > 16384) throw new Error(moteText("迁移恢复记录无效")); journal = JSON.parse(await readFile(this.journalPath, 'utf8')) as Journal; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    if (typeof journal.source !== 'string' || typeof journal.target !== 'string' || typeof journal.id !== 'string' || !isAbsolute(journal.source) || resolve(journal.source) !== journal.source || journal.version !== 1 || journal.profile !== this.owner.profile || journal.deviceId !== this.owner.deviceId || !/^[a-f0-9-]{36}$/.test(journal.id) || journal.staging !== `${journal.target}.migrating-${journal.id}` || ![journal.source, journal.target].includes(selected)) throw new Error(moteText("迁移记录与当前环境不匹配，请保留目录并检查配置"));
    this.checkRelationship(journal.source, journal.target);
    try {
      if (selected === journal.target) { await this.assertOwned(journal.target); await this.removeOwned(journal.source); }
      else { await this.removeOwned(journal.target, journal.id); await this.removeOwned(journal.staging, journal.id); }
      await unlink(this.journalPath); this.cleanupPending = false;
    } catch { this.cleanupPending = true; } // The selected directory stays authoritative after commit.
  }
  async migrate(source: string, target: string, activate: () => Promise<void>, selectedDirectory: () => Promise<string>, progress?: (value: import('./background').WorkProgress) => void): Promise<void> {
    if (source === target) { await activate(); return; }
    if (await exists(this.journalPath)) { await this.recover(source); if (await exists(this.journalPath)) throw new Error(moteText("上次迁移副本尚未清理，请确认旧磁盘可用后重试")); }
    await this.assertOwned(source); this.checkRelationship(source, target); await this.checkDirectory(dirname(target));
    if (target !== this.defaultDirectory && this.protectedRoots.some(root => inside(target, resolve(root)))) throw new Error(moteText("目标位置与应用环境目录冲突"));
    if (await exists(target)) throw new Error(moteText("新位置已存在文件，迁移不会覆盖或合并已有记录"));
    const files = await filesIn(source), totalBytes = files.reduce((total, file) => total + file.bytes, 0), capacity = await statfs(dirname(target));
    if (capacity.bavail * capacity.bsize < totalBytes + 1024 * 1024) throw new Error(moteText("新位置空间不足；请释放空间或选择其他位置"));
    const id = randomUUID(), staging = `${target}.migrating-${id}`, journal: Journal = { version: 1, profile: this.owner.profile, deviceId: this.owner.deviceId, id, source, target, staging };
    await writeJson(this.journalPath, journal);
    let committed = false;
    try {
      await mkdir(staging, { mode: 0o700 }); await writeJson(join(staging, OWNER), { ...this.owner, migrationId: id });
      await mkdir(join(staging, 'events'), { mode: 0o700 }); await mkdir(join(staging, 'blobs'), { mode: 0o700 });
      let completed = 0;
      for (const file of files) {
        await copyVerified(join(source, file.path), join(staging, file.path));
        progress?.({ message: moteText("正在复制并校验存储文件"), completed: ++completed, total: files.length });
      }
      const copied = await filesIn(staging);
      const sizes = new Map(files.map(file => [file.path, file.bytes]));
      if (copied.length !== files.length || copied.some(file => sizes.get(file.path) !== file.bytes)) throw new Error(moteText("迁移校验未通过，原目录保持有效"));
      for (const folder of new Set(files.map(file => dirname(join(staging, file.path))))) await syncDirectory(folder);
      await syncDirectory(staging); await rename(staging, target); await syncDirectory(dirname(target));
      await activate(); committed = true;
      try { await this.removeOwned(source); await unlink(this.journalPath); this.cleanupPending = false; }
      catch { this.cleanupPending = true; }
    } catch (error) {
      if (!committed) {
        // A callback may fail after rename/fsync. Read the persisted pointer before deleting either copy.
        const selected = await selectedDirectory().catch(() => undefined);
        if (selected !== source) { this.cleanupPending = true; throw new StorageCommitUncertainError(); }
        try { await this.removeOwned(target, id); await this.removeOwned(staging, id); await unlink(this.journalPath); }
        catch { this.cleanupPending = true; }
      }
      throw error;
    }
  }
}
