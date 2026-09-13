import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, readdir, unlink, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { CaptureEvent, Config, Platform } from './contracts';
import type { DurableQueue } from './queue';
export interface NoteDraft { id: string; text: string; mood: string; revision: number; prepared?: boolean }
interface StoredDraft { draft: NoteDraft; submission?: CaptureEvent; targetOrigin?: string; completed?: { draftId: string; eventId: string } }
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function emptyDraft(): NoteDraft { return { id: randomUUID(), text: '', mood: '', revision: 0 }; }
function validateDraft(value: NoteDraft): void {
  if (!value || !uuid.test(value.id) || typeof value.text !== 'string' || typeof value.mood !== 'string' || !Number.isSafeInteger(value.revision) || value.revision < 0) throw new Error('随手记草稿格式无效');
  if (value.text.length > 20000) throw new Error('正文最多 20000 个字符位，部分表情占多个字符位；原草稿未改动');
  if (value.mood.length > 80) throw new Error('心情最多 80 个字符位，部分表情占多个字符位；原草稿未改动');
}
/** Prepared IDs precede queue writes, so an interrupted submit never becomes a second note. */
export class NoteDraftStore {
  private value: StoredDraft = { draft: emptyDraft() };
  private chain: Promise<unknown> = Promise.resolve();
  constructor(private directory: string) {}
  private exclusive<T>(fn: () => Promise<T>): Promise<T> { const task = this.chain.then(fn); this.chain = task.catch(() => undefined); return task; }
  async initialize(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      const path = join(this.directory, 'draft.json');
      // Prepared submissions include a second copy; JSON can escape each UTF-16 unit as six bytes.
      const maxBytes = 512 * 1024;
      if ((await stat(path)).size > maxBytes) throw new Error('oversized');
      const data = await readFile(path, 'utf8');
      if (Buffer.byteLength(data) > maxBytes) throw new Error('oversized');
      const value = JSON.parse(data) as StoredDraft; validateDraft(value.draft);
      if (value.completed && (!uuid.test(value.completed.draftId) || !uuid.test(value.completed.eventId))) throw new Error('invalid completion');
      if (value.submission && (value.submission.id !== value.draft.id || value.submission.source !== 'note' || value.submission.ocrText !== value.draft.text || typeof value.targetOrigin !== 'string')) throw new Error('invalid prepared note');
      this.value = value;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('随手记草稿无法读取；请先备份草稿文件再修复'); await this.persist(this.value); }
    for (const name of await readdir(this.directory)) if (name.endsWith('.tmp') && uuid.test(name.slice(0, -4))) await unlink(join(this.directory, name));
  }
  get(): NoteDraft { return { ...this.value.draft, prepared: Boolean(this.value.submission) }; }
  hasPrepared(): boolean { return Boolean(this.value.submission); }
  private async persist(value: StoredDraft): Promise<void> {
    const temporary = join(this.directory, randomUUID() + '.tmp');
    try {
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
      await rename(temporary, join(this.directory, 'draft.json'));
      if (process.platform !== 'win32') { const directory = await open(this.directory, 'r'); try { await directory.sync(); } finally { await directory.close(); } }
      this.value = value;
    } finally { await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }); }
  }
  update(input: NoteDraft): Promise<NoteDraft> {
    return this.exclusive(async () => {
      validateDraft(input);
      if (input.id !== this.value.draft.id) throw new Error('草稿已更新，请重新载入当前草稿');
      if (input.revision <= this.value.draft.revision) return this.get();
      if (this.value.submission) throw new Error('此草稿已有待完成保存，请先重试保存；不能改写已准备的记录');
      await this.persist({ ...this.value, draft: { id: input.id, text: input.text, mood: input.mood, revision: input.revision } });
      return this.get();
    });
  }
  submit(input: NoteDraft, config: Config, platform: Platform, queue: Pick<DurableQueue, 'enqueue'>): Promise<{ id: string; draft: NoteDraft }> {
    return this.exclusive(async () => {
      validateDraft(input);
      if (this.value.completed?.draftId === input.id) return { id: this.value.completed.eventId, draft: this.get() };
      if (input.id !== this.value.draft.id) throw new Error('草稿已更新，此提交不会重复创建记录');
      if (!input.text.trim()) throw new Error('请填写随手记正文，不能只有空白');
      if (input.mood && !input.mood.trim()) throw new Error('心情不能只有空白；清空心情后也可以保存');
      if (input.revision < this.value.draft.revision) throw new Error('提交版本已过期，请重新保存当前草稿');
      if (this.value.submission) {
        if (this.value.targetOrigin !== config.serverUrl) throw new Error('待完成记录属于原中央节点，请恢复原节点完成保存');
        if (input.text !== this.value.draft.text || input.mood !== this.value.draft.mood) throw new Error('待完成记录不能改写，请重新载入草稿后重试');
      } else {
        const submission: CaptureEvent = { id: input.id, deviceId: config.deviceId, deviceName: config.deviceName, platform,
          capturedAt: new Date().toISOString(), durationMs: 0, appId: 'dev.mote.notes', appName: '随手记', source: 'note',
          ocrText: input.text, ...(input.mood ? { mood: input.mood } : {}), privacy: { excluded: false, redacted: false, mode: 'none' } };
        await this.persist({ ...this.value, draft: { id: input.id, text: input.text, mood: input.mood, revision: input.revision }, submission, targetOrigin: config.serverUrl });
      }
      const submission = this.value.submission!;
      await queue.enqueue(submission);
      await this.persist({ draft: emptyDraft(), completed: { draftId: input.id, eventId: submission.id } });
      return { id: submission.id, draft: this.get() };
    });
  }
}
