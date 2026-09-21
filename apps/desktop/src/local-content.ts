import {DatabaseSync} from 'node:sqlite';
import { moteText } from '@mote/shared/i18n';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import type { SecretStorage } from './config';

export interface ContentPolicy { enabled: boolean; key?: Uint8Array }
const encryptedPrefix = Buffer.from('MOTE-CONTENT-AES256GCM-V1\0');
const plainPrefix = Buffer.from('MOTE-CONTENT-PLAIN-V1\0');
let policy: ContentPolicy = { enabled: false };
export function configureLocalContent(value: ContentPolicy): void {
  if (value.key && value.key.length !== 32 || value.enabled && !value.key) throw new Error(moteText("本地内容加密密钥不可用"));
  policy = { enabled: value.enabled, key: value.key ? Buffer.from(value.key) : undefined };
}
export function localContentPolicy(): ContentPolicy { return { enabled: policy.enabled, key: policy.key ? Buffer.from(policy.key) : undefined }; }
export function isEncryptedContent(bytes: Buffer): boolean { return bytes.subarray(0, encryptedPrefix.length).equals(encryptedPrefix); }
export function encodeLocalContent(value: string | Uint8Array, selected = policy): Buffer {
  const bytes = typeof value === 'string' ? Buffer.from(value) : Buffer.from(value);
  if (!selected.enabled) return isEncryptedContent(bytes) || bytes.subarray(0, plainPrefix.length).equals(plainPrefix) ? Buffer.concat([plainPrefix, bytes]) : bytes;
  if (!selected.key || selected.key.length !== 32) throw new Error(moteText("本地内容加密密钥不可用"));
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', selected.key, iv);
  cipher.setAAD(encryptedPrefix);
  const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return Buffer.concat([encryptedPrefix, iv, cipher.getAuthTag(), ciphertext]);
}
export function decodeLocalContent(bytes: Buffer, selected = policy): Buffer {
  if (bytes.subarray(0, plainPrefix.length).equals(plainPrefix)) return bytes.subarray(plainPrefix.length);
  if (!isEncryptedContent(bytes)) return bytes;
  if (!selected.key || selected.key.length !== 32) throw new Error(moteText("无法读取本地加密内容：原内容密钥不可用"));
  const offset = encryptedPrefix.length;
  if (bytes.length < offset + 28) throw new Error(moteText("本地加密文件不完整，原文件已保留"));
  const decipher = createDecipheriv('aes-256-gcm', selected.key, bytes.subarray(offset, offset + 12));
  decipher.setAAD(encryptedPrefix); decipher.setAuthTag(bytes.subarray(offset + 12, offset + 28));
  return Buffer.concat([decipher.update(bytes.subarray(offset + 28)), decipher.final()]);
}
export async function readLocalContent(path: string, selected = policy): Promise<Buffer> { return decodeLocalContent(await readFile(path), selected); }
async function rawAtomic(path: string, bytes: Buffer): Promise<void> {
  const temporary = path + '.' + randomUUID() + '.tmp';
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    await rename(temporary, path);
    if (process.platform !== 'win32') { const directory = await open(dirname(path), 'r'); try { await directory.sync(); } finally { await directory.close(); } }
  } finally { await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }); }
}

/** The content key is distinct from connection credentials and never leaves the main/worker processes. */
export class LocalContentKeyStore {
  private key?: Buffer;
  constructor(private readonly directory: string, private readonly secrets: SecretStorage) {}
  async initialize(enabled: boolean): Promise<void> {
    try {
      const saved = JSON.parse(await readFile(join(this.directory, 'content-key.json'), 'utf8'));
      if (saved.version !== 1 || typeof saved.encryptedKey !== 'string' || !this.secrets.available()) throw new Error(moteText("本地内容密钥存储不可用"));
      const value = this.secrets.decrypt(Buffer.from(saved.encryptedKey, 'base64'));
      if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(moteText("本地内容密钥无效"));
      this.key = Buffer.from(value, 'hex');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await this.setEnabled(enabled);
  }
  async setEnabled(enabled: boolean): Promise<void> {
    if (enabled && !this.key) {
      if (!this.secrets.available()) throw new Error(moteText("系统密钥存储不可用，无法启用本地内容加密"));
      const next = randomBytes(32);
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await rawAtomic(join(this.directory, 'content-key.json'), Buffer.from(JSON.stringify({ version: 1, encryptedKey: this.secrets.encrypt(next.toString('hex')).toString('base64') })));
      this.key = next;
    }
    configureLocalContent({ enabled, key: this.key });
  }
}

export interface DecryptionProgress { state: 'idle' | 'running' | 'completed' | 'cancelled' | 'failed'; total: number; processed: number; decrypted: number; skipped: number; failed: number; message: string }
export function emptyDecryptionProgress(): DecryptionProgress { return { state: 'idle', total: 0, processed: 0, decrypted: 0, skipped: 0, failed: 0, message: moteText("尚未运行批量解密") }; }
/** Call while queue, note and source writers are held. Each file commits independently. */
export async function decryptLocalContent(roots: string[], signal: AbortSignal, progress: (value: DecryptionProgress) => void, selected = policy): Promise<DecryptionProgress> {
  const result: DecryptionProgress = { ...emptyDecryptionProgress(), state: 'running', message: moteText("正在读取本机文件目录…") };
  progress({ ...result });
  const files: string[] = [];
  async function collect(path: string): Promise<void> {
    if (signal.aborted) return;
    let info;
    try { info = await lstat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    if (info.isSymbolicLink()) { result.failed++; return; }
    if (info.isDirectory()) for (const name of await readdir(path)) await collect(join(path, name));
    else if (info.isFile() && !path.endsWith('.tmp')) files.push(path);
    await yieldTurn();
  }
  for (const root of roots) await collect(root);
  result.total = files.length;
  for (const path of files) {
    if (signal.aborted) break;
    try {
      if(path.endsWith('.json.sqlite')){
        const db=new DatabaseSync(path);let changed=false;
        try{db.exec('BEGIN IMMEDIATE');for(const row of db.prepare('SELECT section,key,value FROM entries').all()){const bytes=Buffer.from(row.value as Uint8Array);if(isEncryptedContent(bytes)){db.prepare('UPDATE entries SET value=? WHERE section=? AND key=?').run(encodeLocalContent(decodeLocalContent(bytes,selected),{enabled:false}),row.section,row.key);changed=true;}}db.exec('COMMIT; PRAGMA wal_checkpoint(TRUNCATE);');}catch(error){try{db.exec('ROLLBACK');}catch{}throw error;}finally{db.close();}
        if(changed)result.decrypted++;else result.skipped++;
      }else{
      const bytes = await readFile(path);
      if (isEncryptedContent(bytes)) { await rawAtomic(path, encodeLocalContent(decodeLocalContent(bytes, selected), { enabled: false })); result.decrypted++; }
      else result.skipped++;
      }
    } catch { result.failed++; }
    result.processed++; result.message = moteText("正在逐个解密本机内容"); progress({ ...result });
    await yieldTurn();
  }
  result.state = signal.aborted ? 'cancelled' : result.failed ? 'failed' : 'completed';
  result.message = moteText("{0}：解密 {1}，跳过 {2}，失败 {3}；失败文件保留", signal.aborted ? moteText("已取消，未处理文件保持原样") : moteText("处理结束"), result.decrypted, result.skipped, result.failed);
  progress({ ...result }); return result;
}
