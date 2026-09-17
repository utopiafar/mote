import { moteText } from '@mote/shared/i18n';
import { noteSchema, type NoteInput } from '@mote/shared';

export interface NoteStorage {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
export interface NoteDraft { text: string; mood: string; attachments?: string[] }
interface StoredDraft extends NoteDraft { prepared?: NoteInput }
type SubmissionIdentity = Omit<NoteInput, 'text' | 'mood'>;
export interface QueuedNote { note: NoteInput; error?: string; blocked?: boolean }
const MAX_QUEUED_BYTES = 2_000_000;

/** One immutable event per storage key: another tab cannot overwrite the whole queue. */
export class NoteOutbox {
  private readonly prefix: string;
  private readonly draftKey: string;
  constructor(private storage: NoteStorage, namespace: string) {
    this.prefix = `mote.notes.v1:${encodeURIComponent(namespace)}:`;
    this.draftKey = `${this.prefix}draft`;
  }
  private storedDraft(): StoredDraft {
    const raw = this.storage.getItem(this.draftKey);
    if (!raw) return { text: '', mood: '' };
    try {
      const value = JSON.parse(raw);
      if (typeof value?.text !== 'string' || typeof value?.mood !== 'string') throw new Error('Invalid draft');
      if(value.attachments!==undefined&&(!Array.isArray(value.attachments)||value.attachments.length>10||value.attachments.some((id:unknown)=>typeof id!=='string')))throw new Error('Invalid attachments');
      const prepared = value.prepared === undefined ? undefined : noteSchema.parse(value.prepared);
      if (prepared && (prepared.text !== (value.text.trim()?value.text:'附件记录') || (prepared.mood ?? '') !== (value.mood.trim() ? value.mood : '') || JSON.stringify(prepared.metadata?.attachments??[]) !== JSON.stringify(value.attachments??[]))) throw new Error('Draft submission content mismatch');
      return { text: value.text, mood: value.mood, attachments: value.attachments, ...(prepared ? { prepared } : {}) };
    } catch { throw new Error(moteText("本机草稿无法读取；原数据已保留。")); }
  }
  draft(): NoteDraft {
    const { text, mood, attachments } = this.storedDraft();
    return { text, mood, ...(attachments?.length?{attachments}:{}) };
  }
  saveDraft(draft: NoteDraft): void {
    const previous = this.storedDraft();
    const prepared = previous.text === draft.text && previous.mood === draft.mood && JSON.stringify(previous.attachments) === JSON.stringify(draft.attachments) ? previous.prepared : undefined;
    this.storage.setItem(this.draftKey, JSON.stringify({ ...draft, ...(prepared ? { prepared } : {}) }));
  }
  /** Persist the exact event before queueing it, so a crash cannot create a second ID. */
  prepareSubmission(draft: NoteDraft, identity: SubmissionIdentity): NoteInput {
    if(!draft.text.trim()&&!draft.attachments?.length)throw new Error(moteText("此刻想留下什么？"));
    const previous = this.storedDraft();
    const prepared = previous.text === draft.text && previous.mood === draft.mood && JSON.stringify(previous.attachments) === JSON.stringify(draft.attachments) ? previous.prepared : undefined;
    const { id, deviceId, deviceName, platform, capturedAt, client } = identity;
    const note = prepared ?? noteSchema.parse({ id, deviceId, deviceName, platform, capturedAt, ...(client ? { client } : {}), text: draft.text.trim()?draft.text:'附件记录', ...(draft.attachments?.length?{metadata:{version:1,observedAt:capturedAt,attachments:draft.attachments}}:{}), ...(draft.mood.trim() ? { mood: draft.mood } : {}) });
    this.storage.setItem(this.draftKey, JSON.stringify({ ...draft, prepared: note }));
    return note;
  }
  completeSubmission(id: string): void {
    // Another view may have started a new draft while this one was submitting.
    if (this.storedDraft().prepared?.id === id) this.storage.setItem(this.draftKey, JSON.stringify({ text: '', mood: '' }));
  }
  items(): QueuedNote[] {
    const items: QueuedNote[] = [];
    for (let i = 0; i < this.storage.length; i++) {
      const key = this.storage.key(i);
      if (!key?.startsWith(`${this.prefix}event:`)) continue;
      const raw = this.storage.getItem(key);
      if (!raw) continue;
      try {
        const item = JSON.parse(raw);
        const note = noteSchema.parse(item.note);
        if (key !== `${this.prefix}event:${note.id}`) throw new Error('Mismatched event ID');
        items.push({ note, ...(typeof item.error === 'string' ? { error: item.error } : {}), ...(item.blocked === true ? { blocked: true } : {}) });
      } catch { throw new Error(moteText("本机待同步随手记存在损坏记录；原数据已保留，不能覆盖。")); }
    }
    return items.sort((a, b) => a.note.capturedAt.localeCompare(b.note.capturedAt) || a.note.id.localeCompare(b.note.id));
  }
  enqueue(note: NoteInput): void {
    const normalized = noteSchema.parse(note);
    const key = `${this.prefix}event:${normalized.id}`;
    const existing = this.storage.getItem(key);
    if (existing) {
      if (JSON.stringify(JSON.parse(existing).note) !== JSON.stringify(normalized)) throw new Error(moteText("随手记 ID 已用于另一条内容。"));
      return;
    }
    const items = this.items();
    if (items.length >= 100 || new TextEncoder().encode(JSON.stringify([...items, { note: normalized }])).length > MAX_QUEUED_BYTES) throw new Error(moteText("本机随手记待同步空间已满，请先同步或导出待传内容。"));
    this.storage.setItem(key, JSON.stringify({ note: normalized }));
  }
  mark(id: string, error: string, blocked: boolean): void {
    const key = `${this.prefix}event:${id}`;
    const previous = this.storage.getItem(key);
    if (previous) this.storage.setItem(key, JSON.stringify({ note: JSON.parse(previous).note, error, blocked }));
  }
  acknowledge(id: string, result: { id?: string }): void {
    if (result.id !== id) throw new Error(moteText("中央节点确认的随手记 ID 不匹配；本机记录已保留。"));
    this.storage.removeItem(`${this.prefix}event:${id}`);
  }
  discard(id: string): void { this.storage.removeItem(`${this.prefix}event:${id}`); }
}
