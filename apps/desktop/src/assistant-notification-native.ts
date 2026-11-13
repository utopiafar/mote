import { BrowserWindow, dialog, Menu, Notification } from 'electron';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { moteText } from '@mote/shared/i18n';
import { AssistantNoticePresenter, AssistantNotificationReader, AssistantNotificationError, type AssistantNoticeCursor } from './assistant-notification';
import type { Config } from './contracts';

/** Online local adapter. The existing app timer drives polling; there is no
 * background guarantee, remote push, delivery ledger or cached card body. */
export class DesktopAssistantNotifications {
  private readonly reader: AssistantNotificationReader;
  private readonly presenter: AssistantNoticePresenter;
  private cursor?: AssistantNoticeCursor;
  private connection?: Config;
  private generation = -1;
  private busy = false;
  private next = 0;
  private closed = false;
  private visit = 0;
  private menu?: Menu;
  private result?: { origin: string; id: string; revision: number; abort: AbortController };
  constructor(private readonly options: {
    directory: string; settings(): Config; generation(): number; owner(): BrowserWindow | undefined;
    openEvidence(id: string): Promise<void>;
  }) {
    this.reader = new AssistantNotificationReader(options.settings, options.generation);
    const file = join(options.directory, 'assistant-notification-cursor.json');
    try {
      const value = JSON.parse(readFileSync(file, 'utf8'));
      if (typeof value.origin === 'string' && typeof value.id === 'string' && typeof value.eligibleAt === 'string' && typeof value.shownAt === 'string') this.cursor = value;
    } catch { /* A new profile has no presentation cursor. Cards stay in Central. */ }
    this.presenter = new AssistantNoticePresenter({
      cursor: () => this.cursor,
      save: cursor => {
        writeFileSync(file + '.tmp', JSON.stringify(cursor), { mode: 0o600 });
        renameSync(file + '.tmp', file); this.cursor = cursor;
      },
      show: (event, shown, failed) => {
        const origin = this.reader.origin()!;
        // OS history can outlive this process. Keep derived titles/reasons out
        // of it entirely; an owner click fetches the current authorized result.
        const notification = new Notification({ title: moteText('通知'), body: moteText('打开 Mote') });
        let closed = false;
        notification.on('show', () => {
          if (closed) { notification.close(); return; }
          try { shown(); } catch { failed(); }
        });
        notification.on('failed', failed);
        notification.on('click', () => { if (!closed) void this.openCard(origin, event.id); });
        notification.show();
        return { close: () => { closed = true; notification.close(); } };
      },
    });
  }
  /** Called by the existing authorization timer, including while the tray app
   * has no window. Session changes invalidate in-flight work before it returns. */
  tick(): void {
    if (this.closed) return;
    if (this.connection !== this.options.settings() || this.generation !== this.options.generation()) {
      this.clear(); this.connection = this.options.settings(); this.generation = this.options.generation(); this.next = 0;
    }
    this.presenter.expire();
    if (this.busy || Date.now() < this.next) return;
    const connection = this.connection, generation = this.generation;
    const current = () => !this.closed && connection === this.options.settings() && generation === this.options.generation();
    const origin = this.reader.origin();
    if (!origin) { this.clear(); return; }
    this.busy = true; this.next = Date.now() + 15000;
    void (async () => {
      try {
        const snapshot = await this.reader.snapshot(origin);
        if (!current()) return;
        this.presenter.update(origin, snapshot, process.platform === 'darwin' && Notification.isSupported());
        this.menu?.closePopup(); this.menu = undefined;
        // An open result is a current read too. Retire its text on a revision,
        // withdrawal or loss of access, independently of notification eligibility.
        const result = this.result;
        if (result) {
          const card = await this.reader.card(result.origin, result.id);
          if (current() && this.result === result && card.revision !== result.revision) { result.abort.abort(); this.result = undefined; }
        }
      } catch { if (current()) this.clear(); }
      finally { this.busy = false; }
    })();
  }
  private clear(): void {
    this.visit++;
    this.presenter.clear(); this.menu?.closePopup(); this.menu = undefined;
    this.result?.abort.abort(); this.result = undefined;
  }
  close(): void { this.closed = true; this.clear(); }

  /** Minimal read-only card inbox until the full assistant pages land. Every
   * page comes from the card store, including cards with no eligible system notification. */
  async openInbox(cursor?: string): Promise<void> {
    const origin = this.reader.origin(), owner = this.options.owner();
    if (!origin || !owner) { await this.failure(new AssistantNotificationError(moteText('先登录中央，各页面会共用这次登录'))); return; }
    const visit = ++this.visit, connection = this.options.settings(), generation = this.options.generation();
    try {
      const page = await this.reader.page(origin, cursor);
      if (this.closed || this.visit !== visit || this.options.settings() !== connection || this.options.generation() !== generation || owner.isDestroyed()) return;
      this.menu?.closePopup();
      const menu = Menu.buildFromTemplate([
        ...page.items.map(card => ({ label: card.title, click: () => { void this.openCard(origin, card.id); } })),
        ...(page.items.length ? [] : [{ label: moteText('暂无记录'), enabled: false }]),
        ...(page.nextCursor ? [{ label: moteText('加载更多'), click: () => { void this.openInbox(page.nextCursor!); } }] : []),
        { label: moteText('刷新'), click: () => { void this.openInbox(); } },
      ]);
      this.menu = menu; owner.show(); menu.popup({ window: owner });
    } catch (error) { await this.failure(error); }
  }
  async openCard(origin: string, id: string): Promise<void> {
    const owner = this.options.owner();
    if (!owner || this.closed) return;
    const visit = ++this.visit, connection = this.options.settings(), generation = this.options.generation();
    const currentVisit = () => !this.closed && this.visit === visit && this.options.settings() === connection && this.options.generation() === generation;
    try {
      this.result?.abort.abort(); this.result = undefined;
      // The OS carries an origin and card ID only. The owner click performs a
      // fresh authorized read and card read feedback, never a cached-text handoff.
      const card = await this.reader.card(origin, id, true);
      if (!currentVisit() || owner.isDestroyed() || this.reader.origin() !== origin) return;
      const result = { origin, id, revision: card.revision, abort: new AbortController() }; this.result = result;
      owner.show();
      const answer = await dialog.showMessageBox(owner, { title: moteText('通知'), message: card.title, detail: card.body, signal: result.abort.signal,
        buttons: [moteText('确定'), ...(card.evidence.length ? [moteText('查看原文')] : [])], cancelId: 0 });
      if (currentVisit() && !result.abort.signal.aborted && this.result === result && answer.response === 1) {
        // Check again after the dialog; withdrawal cannot turn an old citation
        // into an arbitrary path or a different result.
        const current = await this.reader.card(origin, id);
        if (currentVisit() && current.evidence[0]) await this.options.openEvidence(current.evidence[0].id);
      }
      if (this.result === result) this.result = undefined;
    } catch (error) { if (currentVisit()) await this.failure(error); }
  }
  private async failure(error?: unknown): Promise<void> {
    const owner = this.options.owner();
    if (owner && !owner.isDestroyed() && !this.closed) await dialog.showMessageBox(owner, { title: moteText('通知'),
      message: error instanceof AssistantNotificationError ? error.message : moteText('连接暂时中断，请检查网络。'), buttons: [moteText('确定')] });
  }
}
