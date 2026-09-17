import { moteText } from '@mote/shared/i18n';
import { access, chmod, copyFile, lstat, mkdir, readFile, realpath, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { atomicSourceJson } from './source-sync';
const execute = promisify(execFile);
export interface BundleInspection { valid: true; otherInstances: number; digest: string }
export interface UpdateJob {
  schemaVersion: 1; nonce: string; parentPID: number; profile: string; targetPath: string; candidatePath: string;
  oldVersion: string; newVersion: string; arch: 'arm64' | 'x64'; candidateDigest: string; targetDigest: string; teamId?: string;
}
export async function inspectBundle(helper: string, path: string, version: string, arch: string, parentPID = process.pid): Promise<BundleInspection> {
  try {
    const { stdout } = await execute(helper, ['inspect', path, version, arch, String(parentPID)], { timeout: 120000, maxBuffer: 32768 });
    const value = JSON.parse(stdout) as BundleInspection;
    if (value.valid !== true || !Number.isInteger(value.otherInstances) || !/^[a-f0-9]{64}$/.test(value.digest)) throw new Error('invalid');
    return value;
  } catch { throw new Error('UPDATE_BUNDLE_INVALID'); }
}
export async function installationEligibility(bundlePath: string | undefined, dataDirectory: string): Promise<{ allowed: boolean; reason: string }> {
  if (process.platform !== 'darwin' || !bundlePath) return { allowed: false, reason: moteText("开发运行不能替换 Electron。请使用安装后的 Mac App；仍可下载更新包。") };
  if (bundlePath.includes('/AppTranslocation/') || relative(bundlePath, dataDirectory).split(/[\\/]/)[0] !== '..') return { allowed: false, reason: moteText("请先把 App 移到可写的应用目录，再打开更新；资料目录不能位于 App 包内。") };
  try {
    if ((await lstat(bundlePath)).isSymbolicLink() || await realpath(bundlePath) !== bundlePath) throw new Error();
    await access(dirname(bundlePath), constants.W_OK | constants.X_OK);
    return { allowed: true, reason: moteText("安装会退出当前 App，替换应用包后以相同 profile 重启。") };
  } catch { return { allowed: false, reason: moteText("应用目录不可写或为只读磁盘。可显示已验证的 ZIP，然后通过 Finder 手动替换 App；资料目录保持不变。") }; }
}
export async function copyVerifiedBundle(source: string, destination: string): Promise<void> {
  try { await lstat(destination); throw new Error('UPDATE_STAGE_EXISTS'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  await execute('/usr/bin/ditto', [source, destination], { timeout: 180000, maxBuffer: 32768 });
}
export async function prepareInstall(args: {
  directory: string; helper: string; target: string; staged: string; stagedDigest: string;
  oldVersion: string; newVersion: string; arch: 'arm64' | 'x64'; profile: string; teamId?: string;
}): Promise<{ job: UpdateJob; path: string; helper: string }> {
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(args.profile)) throw new Error('UPDATE_PROFILE_INVALID');
  const eligibility = await installationEligibility(args.target, args.directory); if (!eligibility.allowed) throw new Error('UPDATE_TARGET_NOT_WRITABLE');
  const target = await inspectBundle(args.helper, args.target, args.oldVersion, args.arch);
  if (target.otherInstances) throw new Error('UPDATE_OTHER_PROFILES_RUNNING');
  const staged = await inspectBundle(args.helper, args.staged, args.newVersion, args.arch);
  if (staged.digest !== args.stagedDigest) throw new Error('UPDATE_STAGE_CHANGED');
  const nonce = randomBytes(16).toString('hex'); const lock = join(dirname(args.target), '.mote-update-lock');
  try { await mkdir(lock, { mode: 0o700 }); } catch { throw new Error('UPDATE_INSTALL_LOCKED'); }
  const candidate = join(dirname(args.target), '.mote-stage-' + nonce + '.app');
  const transaction = join(args.directory, 'transactions', nonce);
  try {
    await atomicSourceJson(join(lock, 'owner.json'), { nonce, pid: process.pid });
    await mkdir(transaction, { recursive: true, mode: 0o700 });
    await copyVerifiedBundle(args.staged, candidate);
    const copied = await inspectBundle(args.helper, candidate, args.newVersion, args.arch);
    if (copied.digest !== args.stagedDigest) throw new Error('UPDATE_STAGE_CHANGED');
    const job: UpdateJob = { schemaVersion: 1, nonce, parentPID: process.pid, profile: args.profile, targetPath: args.target, candidatePath: candidate, oldVersion: args.oldVersion, newVersion: args.newVersion, arch: args.arch, candidateDigest: copied.digest, targetDigest: target.digest, ...(args.teamId ? { teamId: args.teamId } : {}) };
    const path = join(transaction, 'job.json'); await atomicSourceJson(path, job);
    const helper = join(transaction, 'mote-updater'); await copyFile(args.helper, helper); await chmod(helper, 0o700);
    return { job, path, helper };
  } catch (error) { await rm(candidate, { recursive: true, force: true }); await rm(lock, { recursive: true, force: true }); throw error; }
}
export async function startInstall(prepared: Awaited<ReturnType<typeof prepareInstall>>): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(MOTE_|ELECTRON_|DYLD_)/.test(key)));
    const child = spawn(prepared.helper, ['apply', prepared.path], { env, detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let buffer = ''; let settled = false;
    const fail = () => { if (settled) return; settled = true; clearTimeout(timer); reject(new Error('UPDATE_HELPER_NOT_READY')); };
    const timer = setTimeout(() => { child.kill('SIGTERM'); fail(); }, 120000);
    child.stdout!.on('data', (data: Buffer) => {
      buffer += data.toString(); if (buffer.length > 32768) { child.kill('SIGTERM'); return fail(); }
      for (const line of buffer.split('\n').slice(0, -1)) {
        try { const value = JSON.parse(line); if (value.ready === true && value.nonce === prepared.job.nonce && !settled) { settled = true; clearTimeout(timer); child.stdout!.destroy(); child.unref(); resolve(child); } } catch { /* Wait for a complete fixed handshake. */ }
      }
    });
    child.once('error', fail); child.once('exit', fail);
  });
}
export async function acknowledgeInstalledUpdate(args: { argv: string[]; directory: string; bundlePath?: string; version: string; profile: string }): Promise<void> {
  const selected = args.argv.filter(arg => arg.startsWith('--mote-update-transaction='));
  if (selected.length !== 1 || !args.bundlePath) return;
  const transaction = selected[0].slice('--mote-update-transaction='.length);
  const expectedParent = join(args.directory, 'transactions');
  if (dirname(transaction) !== expectedParent || !/^[a-f0-9]{32}$/.test(transaction.slice(expectedParent.length + 1))) return;
  try {
    if (await realpath(transaction) !== transaction) return;
    const job = JSON.parse(await readFile(join(transaction, 'job.json'), 'utf8')) as UpdateJob;
    if (job.schemaVersion !== 1 || job.nonce !== transaction.slice(expectedParent.length + 1) || job.newVersion !== args.version || job.profile !== args.profile || job.targetPath !== args.bundlePath) return;
    await atomicSourceJson(join(transaction, 'ready.json'), { nonce: job.nonce, version: args.version });
  } catch { /* An unrelated launch must never write outside its own profile or block startup. */ }
}

export async function cancelPreparedInstall(prepared: Awaited<ReturnType<typeof prepareInstall>>): Promise<void> {
  const lock = join(dirname(prepared.job.targetPath), '.mote-update-lock');
  try {
    const owner = JSON.parse(await readFile(join(lock, 'owner.json'), 'utf8'));
    if (owner.nonce !== prepared.job.nonce) return;
    if (owner.pid !== process.pid) {
      try { process.kill(owner.pid, 0); return; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return; }
    }
    // A helper may already have exchanged the bundles. Never remove a candidate containing the old installed version.
    const target = await inspectBundle(prepared.helper, prepared.job.targetPath, prepared.job.oldVersion, prepared.job.arch);
    if (target.digest !== prepared.job.targetDigest) return;
    await rm(prepared.job.candidatePath, { recursive: true, force: true });
    await rm(lock, { recursive: true, force: true });
  } catch { /* Preserve uncertain recovery data. */ }
}

/** Resume cleanup only after this App has initialized its own profile. Never swap a running bundle. */
export async function recoverInterruptedUpdate(args: { directory: string; helper: string; bundlePath?: string; version: string; profile: string }): Promise<'recovered' | 'blocked' | undefined> {
  if (!args.bundlePath) return;
  const lock = join(dirname(args.bundlePath), '.mote-update-lock');
  let owner: { nonce: string; pid: number };
  try { owner = JSON.parse(await readFile(join(lock, 'owner.json'), 'utf8')); }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : 'blocked'; }
  if (!/^[a-f0-9]{32}$/.test(owner.nonce) || !Number.isInteger(owner.pid) || owner.pid < 2) return 'blocked';
  try { process.kill(owner.pid, 0); return; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return 'blocked'; }
  const folder = join(args.directory, 'transactions', owner.nonce);
  try {
    if (await realpath(folder) !== folder || await realpath(lock) !== lock) return 'blocked';
    const job = JSON.parse(await readFile(join(folder, 'job.json'), 'utf8')) as UpdateJob;
    if (job.schemaVersion !== 1 || job.nonce !== owner.nonce || job.profile !== args.profile || job.targetPath !== args.bundlePath || job.candidatePath !== join(dirname(args.bundlePath), '.mote-stage-' + owner.nonce + '.app') || !['arm64', 'x64'].includes(job.arch)) return 'blocked';
    const installed = await inspectBundle(args.helper, args.bundlePath, args.version, job.arch);
    const completed = args.version === job.newVersion && installed.digest === job.candidateDigest;
    const untouched = args.version === job.oldVersion && installed.digest === job.targetDigest;
    if (!completed && !untouched) return 'blocked';
    const candidate = await inspectBundle(args.helper, job.candidatePath, completed ? job.oldVersion : job.newVersion, job.arch);
    if (candidate.digest !== (completed ? job.targetDigest : job.candidateDigest) || candidate.otherInstances) return 'blocked';
    // Claim the exact stale owner before cleanup; another process cannot legitimately own this transaction.
    const latest = JSON.parse(await readFile(join(lock, 'owner.json'), 'utf8'));
    if (latest.nonce !== owner.nonce || latest.pid !== owner.pid) return 'blocked';
    await atomicSourceJson(join(lock, 'owner.json'), { nonce: owner.nonce, pid: process.pid });
    await atomicSourceJson(join(folder, 'result.json'), { state: completed ? 'installed' : 'failed', version: args.version, code: completed ? 'RECOVERED_AFTER_STARTUP' : 'INTERRUPTED_BEFORE_REPLACEMENT' });
    await rm(job.candidatePath, { recursive: true }); await rm(lock, { recursive: true });
    return 'recovered';
  } catch { return 'blocked'; }
}
