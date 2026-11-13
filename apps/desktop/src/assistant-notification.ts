import { moteText } from '@mote/shared/i18n';
import { connectionToken } from './login-session';
import { validateServerUrl } from './config';
import { readResponseText } from './response-body';
import type { Config } from './contracts';
import { httpFailureMessage, responseFailureCode } from '@mote/shared';

/** The server's current projection. The card store owns content, eligibility and read state. */
export type AssistantNotice = { id: string; revision: number; title: string; reason: string; eligibleAt: string; expiresAt: string };
export type AssistantNoticeCursor = Pick<AssistantNotice, 'id' | 'eligibleAt'> & { origin: string; shownAt: string };
export type AssistantCardPreview = { id: string; revision: number; title: string; body: string; readAt: string | null; evidence: { id: string }[] };
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export class AssistantNotificationError extends Error {
  constructor(message: string, readonly status?: number) { super(message); }
}
const invalid = () => new AssistantNotificationError(moteText('中央响应格式无效，请刷新后重试。'));
const object = (value: unknown): Record<string, any> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  return value as Record<string, any>;
};
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;
const date = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));
const revision = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;

export function assistantNoticeSnapshot(value: unknown): AssistantNotice[] {
  const { items } = object(value);
  if (!Array.isArray(items) || items.length > 1) throw invalid();
  return items.map(raw => {
    const v = object(raw);
    if (!uuid.test(v.id) || !revision(v.revision) || !text(v.title, 500) || !text(v.reason, 2000) ||
      !date(v.eligibleAt) || !date(v.expiresAt) || Date.parse(v.expiresAt) <= Date.parse(v.eligibleAt)) throw invalid();
    return { id: v.id, revision: v.revision, title: v.title, reason: v.reason, eligibleAt: v.eligibleAt, expiresAt: v.expiresAt };
  });
}

export function assistantCardPreview(value: unknown): AssistantCardPreview {
  const v = object(value);
  if (v.state === 'stale' || v.evidenceStale === true) throw new AssistantNotificationError(moteText('请求的资源不存在或已删除。'), 404);
  if (!uuid.test(v.id) || !revision(v.revision) || !['open', 'resolved'].includes(v.state) || !text(v.title, 500) || !text(v.body, 32000) ||
    !(v.readAt === null || date(v.readAt)) || !Array.isArray(v.evidence) || v.evidence.length > 100 ||
    v.evidence.some((entry: unknown) => !uuid.test(object(entry).id))) throw invalid();
  return { id: v.id, revision: v.revision, title: v.title, body: v.body, readAt: v.readAt, evidence: v.evidence.map((entry: { id: string }) => ({ id: entry.id })) };
}

/** One local presentation cursor, without bodies or a second unread/delivery store.
 * Content revisions retire the old OS text without alerting again. A snoozed
 * occurrence has a new eligibleAt and can alert again. Other devices read the card store.
 * The server spaces eligible instants; this client also keeps the configured gap
 * between its actual displays when polling was delayed. */
export class AssistantNoticePresenter {
  private active?: { origin: string; event: AssistantNotice; close(): void };
  constructor(private readonly options: {
    cursor(): AssistantNoticeCursor | undefined;
    save(cursor: AssistantNoticeCursor): void;
    show(event: AssistantNotice, shown: () => void, failed: () => void): { close(): void };
    now?: () => number;
  }) {}
  clear(): void { const active = this.active; this.active = undefined; active?.close(); }
  expire(): void { if (this.active && Date.parse(this.active.event.expiresAt) <= (this.options.now?.() ?? Date.now())) this.clear(); }
  update(origin: string, snapshot: unknown, allowed: boolean): void {
    const now = this.options.now?.() ?? Date.now();
    const event = assistantNoticeSnapshot(snapshot).find(event => Date.parse(event.eligibleAt) <= now && now < Date.parse(event.expiresAt));
    if (!allowed || !event) { this.clear(); return; }
    if (this.active?.origin === origin && this.active.event.id === event.id && this.active.event.eligibleAt === event.eligibleAt && this.active.event.revision === event.revision) return;
    this.clear();
    const cursor = this.options.cursor();
    // Settings changes can move the projected slot backwards. A high-water
    // cursor prevents re-alerting an older slot; its cards remain in the inbox.
    if (cursor?.origin === origin && Date.parse(cursor.eligibleAt) >= Date.parse(event.eligibleAt)) return;
    // The server only spaces eligible instants; without a delivery ledger a
    // delayed poll could otherwise show this event too soon after the last one.
    // Its slot length is the server interval capped at 24 hours.
    const shownAt = cursor?.origin === origin ? Date.parse(cursor.shownAt) : NaN;
    if (Number.isFinite(shownAt) && now < shownAt + (Date.parse(event.expiresAt) - Date.parse(event.eligibleAt))) return;
    const active = { origin, event, close: () => {} };
    this.active = active;
    try {
      const handle = this.options.show(event, () => {
        if (this.active === active) this.options.save({ origin, id: event.id, eligibleAt: event.eligibleAt,
          shownAt: new Date(this.options.now?.() ?? Date.now()).toISOString() });
      }, () => { if (this.active === active) this.clear(); });
      active.close = () => handle.close();
      if (this.active !== active) handle.close();
    } catch (error) { this.clear(); throw error; }
  }
}

/** Fixed API paths, explicit owner scope and a post-I/O session check. No URL
 * from captured/model text or OS notification content is ever followed. */
export class AssistantNotificationReader {
  constructor(private readonly settings: () => Config, private readonly generation: () => number, private readonly request = fetch) {}
  origin(): string | undefined {
    const config = this.settings();
    return connectionToken(config) && config.serverUrl ? validateServerUrl(config.serverUrl) : undefined;
  }
  private async read(path: string, origin: string, body?: unknown): Promise<unknown> {
    const config = this.settings(), generation = this.generation(), token = connectionToken(config);
    if (!token || this.origin() !== origin) throw new AssistantNotificationError(moteText('先登录中央，各页面会共用这次登录'));
    const response = await this.request(origin + path, { method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { Authorization: 'Bearer ' + token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const raw = await readResponseText(response, 4 * 1024 * 1024);
    if (this.settings() !== config || this.generation() !== generation || connectionToken(this.settings()) !== token) throw new AssistantNotificationError(moteText('登录会话已变更，请重新打开中央页面。'));
    let value: unknown;
    try { value = JSON.parse(raw); } catch { if (response.ok) throw invalid(); }
    if (!response.ok) throw new AssistantNotificationError(httpFailureMessage(response.status, responseFailureCode(value)), response.status);
    return value;
  }
  snapshot(origin: string): Promise<unknown> { return this.read('/api/assistant-notifications?' + this.scope(), origin); }
  async page(origin: string, cursor?: string): Promise<{ items: AssistantCardPreview[]; nextCursor: string | null }> {
    const value = object(await this.read('/api/assistant-cards?' + this.scope() + '&limit=30' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''), origin));
    if (!Array.isArray(value.items) || value.items.length > 30 || !(value.nextCursor === null || text(value.nextCursor, 1000))) throw invalid();
    return { items: value.items.map(assistantCardPreview), nextCursor: value.nextCursor };
  }
  async card(origin: string, id: string, markRead = false): Promise<AssistantCardPreview> {
    if (!uuid.test(id)) throw invalid();
    const path = '/api/assistant-cards/' + encodeURIComponent(id), card = assistantCardPreview(await this.read(path + '?' + this.scope(), origin));
    if (card.id !== id) throw invalid();
    // Only an owner click in the inbox/notification asks for this feedback.
    if (markRead && card.readAt === null) {
      try {
        const read = assistantCardPreview(await this.read(path + '/feedback?' + this.scope(), origin, { expectedRevision: card.revision, action: 'read' }));
        if (read.id !== id || read.readAt === null) throw invalid();
        return read;
      } catch (error) {
        if (error instanceof AssistantNotificationError && error.status === 409) return this.card(origin, id);
        throw error;
      }
    }
    return card;
  }
  private scope(): string { return new URLSearchParams({ scope: JSON.stringify({ kind: 'all' }) }).toString(); }
}
