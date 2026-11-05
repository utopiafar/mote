import type {NoteInput} from '@mote/shared';
import {ViewLifetime} from '@mote/shared/plugin-view-lifetime';
import {moteText} from '@mote/shared/i18n';
import {ApiError,errorMessage,type Api,type Capture} from '../../api';
import {uploadNoteAttachment} from './note-attachments';
import {NoteOutbox,type NoteDraft,type NoteStorage,type QueuedNote} from './notes-state';

/** The controller owns the draft/outbox, submission identity, attachment
 * queue, list cache and visibility-gated reads. React components only render
 * this snapshot; a plugin factory (index.tsx) owns the controller lifecycle. */
export interface NotesState {
  draft: NoteDraft;
  queued: QueuedNote[];
  records: Capture[];
  cursor: string | null;
  error: string;
  listError: string;
  notice: string;
  loading: boolean;
  listLoaded: boolean;
  loadingMore: boolean;
  syncing: boolean;
  uploading: boolean;
  draftSaved: boolean;
}

export interface NotesControllerOptions {
  readonly api: Api;
  readonly namespace: string;
  readonly revision?: number;
  readonly composerOnly?: boolean;
  readonly historyOnly?: boolean;
  readonly storage?: NoteStorage;
  readonly deviceStorage?: Pick<Storage, 'getItem' | 'setItem'>;
  readonly deviceId?: string;
  readonly now?: () => Date;
  readonly createId?: () => string;
  readonly onSaved?: () => void;
  readonly onSubmitted?: () => void;
}

const initial=(draft:NoteDraft={text:'',mood:''}):NotesState=>({draft,queued:[],records:[],cursor:null,error:'',listError:'',notice:'',loading:true,listLoaded:false,loadingMore:false,syncing:false,uploading:false,draftSaved:false});

/** ACK identity: a transport failure after the server may already have saved
 * the note. The queued body and note id stay byte-identical and are only
 * replayed by an explicit retry (manual sync), never by the background timer. */
export class NotesController {
  readonly #api: Api;
  readonly #namespace: string;
  readonly #composerOnly: boolean;
  readonly #historyOnly: boolean;
  readonly #outbox: NoteOutbox;
  readonly #deviceStorage?: Pick<Storage, 'getItem' | 'setItem'>;
  readonly #fixedDeviceId?: string;
  readonly #now: () => Date;
  readonly #createId: () => string;
  readonly #lifetime = new ViewLifetime();
  readonly #listeners = new Set<() => void>();
  #onSaved?: () => void;
  #onSubmitted?: () => void;
  #state = initial();
  #revision: number;
  #started = false;
  #readGeneration = 0;
  #syncTail: Promise<void> = Promise.resolve();
  #syncScheduled = false;
  #syncFollowUp: Promise<void> | null = null;
  #manualQueued = false;
  #timer: ReturnType<typeof setInterval> | undefined;
  #attachmentRequest: AbortController | null = null;
  #submittedId: string | undefined;
  #cachedDeviceId: string | undefined;

  constructor(options: NotesControllerOptions) {
    this.#api = options.api;
    this.#namespace = options.namespace;
    this.#composerOnly = Boolean(options.composerOnly);
    this.#historyOnly = Boolean(options.historyOnly);
    this.#outbox = new NoteOutbox(options.storage ?? (globalThis.localStorage as NoteStorage), options.namespace);
    this.#deviceStorage = options.deviceStorage ?? (typeof localStorage === 'undefined' ? undefined : localStorage);
    this.#fixedDeviceId = options.deviceId;
    this.#now = options.now ?? (() => new Date());
    this.#createId = options.createId ?? (() => crypto.randomUUID());
    this.#onSaved = options.onSaved;
    this.#onSubmitted = options.onSubmitted;
    this.#revision = options.revision ?? 0;
  }

  getSnapshot = (): NotesState => this.#state;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  };

  #emit(patch: Partial<NotesState>): void {
    this.#state = {...this.#state, ...patch};
    for (const listener of this.#listeners) listener();
  }

  setHandlers(handlers: {onSaved?: () => void; onSubmitted?: () => void}): void {
    this.#onSaved = handlers.onSaved;
    this.#onSubmitted = handlers.onSubmitted;
  }

  /** Hydrate the durable draft/outbox, then start the visible read/sync loop. */
  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#lifetime.show();
    if (typeof document !== 'undefined' && document.hidden) this.#lifetime.suspend();
    try {
      const draft = this.#outbox.draft();
      this.#emit({draft, queued: this.#outbox.items(), draftSaved: Boolean(draft.text)});
    } catch (error) {
      this.#emit({error: errorMessage(error)});
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('storage', this.#storageChanged);
      window.addEventListener('mote:notes-outbox', this.#storageChanged);
      window.addEventListener('online', this.#online);
    }
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.#visibility);
    if (!this.#historyOnly) {
      this.#startTimer();
      void this.syncNow();
    }
    if (!this.#composerOnly) void this.load();
  }

  stop(): void {
    if (!this.#started) return;
    this.#started = false;
    this.#stopTimer();
    this.#attachmentRequest?.abort();
    this.#attachmentRequest = null;
    this.#lifetime.suspend();
    this.#readGeneration += 1;
    if (typeof window !== 'undefined') {
      window.removeEventListener('storage', this.#storageChanged);
      window.removeEventListener('mote:notes-outbox', this.#storageChanged);
      window.removeEventListener('online', this.#online);
    }
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.#visibility);
    if (this.#state.syncing || this.#state.uploading) this.#state = {...this.#state, syncing: false, uploading: false};
  }

  dispose(): void {
    this.stop();
    this.#lifetime.dispose();
  }

  setRevision(revision: number): void {
    if (this.#revision === revision) return;
    this.#revision = revision;
    if (!this.#composerOnly) void this.load();
  }

  updateDraft(next: NoteDraft): void {
    this.#emit({draft: next, error: '', notice: ''});
    try {
      this.#outbox.saveDraft(next);
      this.#emit({draftSaved: true});
    } catch {
      this.#emit({draftSaved: false, error: moteText('本机存储不可用或已满；草稿目前只在此窗口，请先复制保存。')});
    }
  }

  patchDraft(patch: Partial<NoteDraft>): void {
    this.updateDraft({...this.#state.draft, ...patch});
  }

  /** Prepare, enqueue and attempt the exact immutable note event. If the ACK
   * is lost, the queued event keeps this same id and body for explicit retry. */
  save(): NoteInput | undefined {
    this.#emit({error: '', notice: ''});
    try {
      const capturedAt = this.#now().toISOString();
      const note = this.#outbox.prepareSubmission(this.#state.draft, {
        id: this.#createId(),
        deviceId: this.#deviceId(),
        deviceName: moteText('Mote 记录'),
        platform: 'import',
        client: 'web',
        capturedAt,
      });
      this.#outbox.enqueue(note);
      this.#submittedId = note.id;
      this.#emit({queued: this.#outbox.items()});
      this.#outbox.completeSubmission(note.id);
      const remainingDraft = this.#outbox.draft();
      this.#emit({draft: remainingDraft, draftSaved: Boolean(remainingDraft.text), notice: moteText('已保存到本机待同步队列，联网后会继续同步。')});
      this.#notifyOutbox();
      void this.syncNow();
      return note;
    } catch (error) {
      this.#emit({error: errorMessage(error)});
      return undefined;
    }
  }

  /** Explicit user retry, including unknown ACKs and previously blocked
   * events. It never creates a new operation identity. */
  retry(): Promise<void> {
    return this.syncNow(true);
  }

  /** Submit an already serialized note through the same immutable outbox and
   * submission controller (for example an owner addition with a quoted
   * origin). The note ID stays the operation identity for every retry. */
  submit(note: NoteInput): Promise<void> {
    this.#outbox.enqueue(note);
    this.#emit({queued: this.#outbox.items()});
    this.#notifyOutbox();
    return this.syncNow();
  }

  syncNow(manual = false): Promise<void> {
    if (manual) this.#manualQueued = true;
    if (this.#syncScheduled) {
      if (!manual) return this.#syncTail;
      this.#syncFollowUp ??= this.#syncTail.then(() => {
        this.#syncFollowUp = null;
        return this.syncNow(true);
      });
      return this.#syncFollowUp;
    }
    this.#syncScheduled = true;
    const run = this.#syncTail.then(async () => {
      try {
        await this.#runSync(this.#manualQueued);
      } finally {
        this.#manualQueued = false;
        this.#syncScheduled = false;
      }
    });
    this.#syncTail = run;
    return run;
  }

  async #runSync(manual: boolean): Promise<void> {
    this.#emit({syncing: true});
    let saved = false, submittedSaved = false;
    try {
      for (const item of this.#outbox.items()) {
        if (!this.#started) break;
        if ((item.blocked || item.unknown) && !manual) continue;
        try {
          const response = await this.#api.request<{id: string}>('/api/notes', {
            method: 'POST',
            body: JSON.stringify(item.note),
            signal: AbortSignal.timeout(20000),
          });
          this.#outbox.acknowledge(item.note.id, response);
          if (this.#submittedId === item.note.id) {
            this.#submittedId = undefined;
            submittedSaved = true;
          }
          saved = true;
        } catch (error) {
          const blocked = error instanceof ApiError && [400, 409, 410, 413].includes(error.status);
          const unknown = !blocked && (!(error instanceof ApiError) || error.status >= 500 || error.status === 408);
          this.#outbox.mark(item.note.id, errorMessage(error), blocked, unknown);
          if (!blocked) break;
        }
      }
      // An acknowledged submission still updates the underlying history when
      // the owner has already folded this composer away.
      if (saved) this.#onSaved?.();
      if (this.#started) {
        this.#emit({queued: this.#outbox.items(), ...(saved ? {notice: moteText('记录已同步到你的中央节点。')} : {})});
        if (saved) {
          if (!this.#composerOnly) void this.load();
          const current = this.#outbox.draft();
          if (submittedSaved && !current.text && !current.description && !current.attachments?.length) this.#onSubmitted?.();
        }
      }
    } catch (error) {
      if (this.#started) this.#emit({error: errorMessage(error)});
    } finally {
      this.#notifyOutbox();
      if (this.#started) this.#emit({syncing: false});
      else this.#state = {...this.#state, syncing: false};
    }
  }

  load(next?: string): Promise<void> {
    if (!this.#started || this.#lifetime.state !== 'visible') return Promise.resolve();
    const generation = this.#lifetime.generation, read = ++this.#readGeneration;
    const admitted = () => this.#started && this.#lifetime.admits(generation) && read === this.#readGeneration;
    this.#emit({loading: true, loadingMore: Boolean(next), listError: ''});
    return this.#api.request<{items: Capture[]; nextCursor: string | null}>(`/api/notes?limit=30${next ? `&cursor=${encodeURIComponent(next)}` : ''}`, {signal: this.#lifetime.viewSignal})
      .then(response => {
        if (!admitted()) return;
        this.#emit({
          records: next ? [...this.#state.records, ...response.items.filter(item => !this.#state.records.some(previous => previous.id === item.id))] : response.items,
          cursor: response.nextCursor,
          listLoaded: true,
        });
      })
      .catch(error => {
        if (!admitted()) return;
        if (error instanceof ApiError && [401, 403, 404, 410].includes(error.status)) this.#emit({records: [], cursor: null, listLoaded: false});
        this.#emit({listError: errorMessage(error)});
      })
      .finally(() => {
        if (!admitted()) return;
        this.#emit({loading: false, loadingMore: false});
      });
  }

  discard(id: string): void {
    try {
      this.#outbox.discard(id);
      this.#emit({queued: this.#outbox.items()});
      this.#notifyOutbox();
    } catch (error) {
      this.#emit({error: errorMessage(error)});
    }
  }

  /** Sequential durable attachment queue: view hide never cancels it, while
   * unmount/owner disposal aborts the current transport. */
  async addAttachments(files: readonly File[]): Promise<void> {
    if (!files.length || this.#attachmentRequest) return;
    if ((this.#state.draft.attachments?.length ?? 0) + files.length > 10) {
      this.#emit({error: moteText('最多 10 个附件')});
      return;
    }
    const controller = new AbortController();
    this.#attachmentRequest = controller;
    this.#emit({uploading: true, error: ''});
    try {
      let deviceId: string | undefined;
      for (const file of files) {
        deviceId ??= this.#deviceId();
        const id = await uploadNoteAttachment(this.#api, file, deviceId, controller.signal);
        if (controller.signal.aborted) break;
        this.updateDraft({...this.#state.draft, attachments: [...(this.#state.draft.attachments ?? []), id]});
      }
    } catch (error) {
      if (!controller.signal.aborted) this.#emit({error: errorMessage(error)});
    } finally {
      if (this.#attachmentRequest === controller) this.#attachmentRequest = null;
      if (!controller.signal.aborted) this.#emit({uploading: false});
      else this.#state = {...this.#state, uploading: false};
    }
  }

  #deviceId(): string {
    if (this.#fixedDeviceId) return this.#fixedDeviceId;
    if (this.#cachedDeviceId) return this.#cachedDeviceId;
    try {
      let id = this.#deviceStorage?.getItem('mote.notes.device.v1') ?? undefined;
      if (!id) {
        id = `web:${this.#createId()}`;
        this.#deviceStorage?.setItem('mote.notes.device.v1', id);
      }
      this.#cachedDeviceId = id;
      return id;
    } catch {
      this.#cachedDeviceId ??= `web:${this.#createId()}`;
      return this.#cachedDeviceId;
    }
  }

  #storageChanged = (event?: Event): void => {
    try {
      if (event?.type === 'mote:notes-outbox' && (event as CustomEvent<{namespace: string}>).detail.namespace !== this.#namespace) return;
      this.#emit({queued: this.#outbox.items()});
    } catch (error) {
      this.#emit({error: errorMessage(error)});
    }
  };

  #online = (): void => {
    if (typeof document !== 'undefined' && document.hidden) return;
    void this.syncNow();
  };

  #visibility = (): void => {
    if (typeof document === 'undefined') return;
    if (document.hidden) {
      this.#lifetime.suspend();
      this.#stopTimer();
      this.#readGeneration += 1;
      return;
    }
    if (this.#lifetime.state === 'suspended') this.#lifetime.show();
    if (!this.#historyOnly) {
      this.#startTimer();
      void this.syncNow();
    }
    if (!this.#composerOnly) void this.load();
  };

  #startTimer(): void {
    if (!this.#started || this.#historyOnly || this.#timer !== undefined) return;
    if (typeof document !== 'undefined' && document.hidden) return;
    this.#timer = setInterval(() => { void this.syncNow(); }, 30000);
  }

  #stopTimer(): void {
    if (this.#timer === undefined) return;
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  #notifyOutbox(): void {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new window.CustomEvent('mote:notes-outbox', {detail: {namespace: this.#namespace}}));
  }
}

export function createNotesController(options: NotesControllerOptions): NotesController {
  return new NotesController(options);
}
