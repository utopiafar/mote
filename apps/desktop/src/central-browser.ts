import type { BrowserWindow, Session, WebContents, WebFrameMain } from 'electron';
import { randomUUID } from 'node:crypto';
import { validateServerUrl } from './config';
import type { Config } from './contracts';
import { connectionToken, loginRequest } from './login-session';
import { deepLinkHash, formatEvidenceRef, pageHash, parseEvidenceRef, type PageRouteKey } from '@mote/shared';

/** Mac page ids that open a page from the shared route table. Legacy pages
 * without a table entry keep their existing destination. */
export const centralPageRoutes: Readonly<Record<string, PageRouteKey>> = {
  library: 'library', models: 'models', plugins: 'skills', sources: 'connections',
  lark: 'lark', actions: 'actions', ask: 'chat', activity: 'activity',
  overview: 'chat', guide: 'chat',
};

export function validateCentralWorkId(value:unknown):string{
  if(typeof value!=='string'||!value.trim()||value.length>512||/[\u0000-\u001f\u007f]/.test(value))throw Error('Invalid work reference');
  return value;
}

/** The Central page keeps a session separate from the trusted local window, so
 * remote-origin permissions, cache and cookies never share the local policy. */
export const centralWindowSessionPartition = 'persist:mote-central';

/** The main window renders the paired Central page as untrusted content. It
 * never receives Node or the local preload, and its window keeps only these
 * minimum capabilities. */
export const centralWindowWebPreferences = {
  contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true,
  partition: centralWindowSessionPartition,
} as const;

/** A configured address is only a Central origin once the owner has paired and
 * is signed in; a new or signed-out profile goes to the offline page instead. */
export function pairedCentralOrigin(serverUrl: string | undefined, credential: string | undefined): string | undefined {
  if (!serverUrl || !credential) return undefined;
  try { return validateServerUrl(serverUrl); } catch { return undefined; }
}

/** The Central session denies every permission except sanitized clipboard
 * writes from the paired Central origin. Clipboard reads, media, geolocation,
 * notifications, fullscreen, devices and display capture stay closed. */
export function centralPermissionAllowed(permission: string, requestingUrl: string | undefined, allowedOrigin: string | undefined): boolean {
  return permission === 'clipboard-sanitized-write' && allowedOrigin !== undefined && webUrl(requestingUrl)?.origin === allowedOrigin;
}

type CentralSession = Pick<Session,
  'setPermissionCheckHandler' | 'setPermissionRequestHandler' | 'setDevicePermissionHandler' | 'setDisplayMediaRequestHandler'>;

/** Install the complete permission boundary on the one session used by the
 * untrusted Central window. The request handler is not optional: Electron's
 * check handler alone does not cover the request path. */
export function installCentralSessionGuards(session: CentralSession, allowedOrigin: () => string | undefined): void {
  session.setPermissionCheckHandler((_contents, permission, requestingOrigin) =>
    centralPermissionAllowed(permission, requestingOrigin, allowedOrigin()));
  session.setPermissionRequestHandler((_contents, permission, callback, details) => {
    callback(centralPermissionAllowed(permission, details?.requestingUrl, allowedOrigin()));
  });
  session.setDevicePermissionHandler(() => false);
  session.setDisplayMediaRequestHandler((_request, callback) => callback({}));
}

/** Keep in sync with central-window-preload.ts; the sandboxed preload cannot
 * import this module without pulling Node-only configuration code with it. */
export const centralWindowOpenLocalChannel = 'mote:central:open-local-window';
export const centralWindowLoginTicketChannel = 'mote:central:login-ticket';
const centralWindowLoginParameter = 'desktopLogin';

function webUrl(target: string | undefined): URL | undefined {
  if (!target) return undefined;
  try {
    const url = new URL(target);
    if ((url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password) return url;
  } catch { /* Invalid addresses have no web origin. */ }
}

function hasLoginTicket(url: URL): boolean {
  const fragment = url.hash.slice(1);
  return url.searchParams.has('loginTicket') || new URLSearchParams(fragment.slice(fragment.indexOf('?') + 1)).has('loginTicket');
}

/** Same-origin navigation stays in the window. Other HTTP(S) destinations go
 * to the system browser. File, data, javascript and credential-bearing URLs
 * are denied without being handed to any external handler. */
export type CentralNavigationDecision = 'allow' | 'external' | 'deny';
export function centralNavigationDecision(target: string, allowedOrigin: string | undefined): CentralNavigationDecision {
  const url = webUrl(target);
  if (!url || hasLoginTicket(url)) return 'deny';
  return url.origin === allowedOrigin ? 'allow' : 'external';
}

export function installCentralNavigationGuards(
  contents: Pick<WebContents, 'on' | 'mainFrame' | 'setWindowOpenHandler'>,
  allowedOrigin: () => string | undefined,
  openExternal: (url: string) => Promise<unknown>,
): void {
  // Electron's window-open callback cannot identify the initiating frame.
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const navigate = (event: {
    url: string; isMainFrame: boolean; initiator?: WebFrameMain | null; preventDefault(): void;
  }): void => {
    if (!event.isMainFrame) {
      const url = webUrl(event.url);
      if (url && hasLoginTicket(url)) event.preventDefault();
      return;
    }
    const origin = allowedOrigin();
    const decision = centralNavigationDecision(event.url, origin);
    if (decision === 'allow') return;
    event.preventDefault();
    const initiator = event.initiator;
    if (decision === 'external' && origin && initiator === contents.mainFrame && initiator?.origin === origin) {
      void openExternal(event.url).catch(() => {});
    }
  };
  contents.on('will-frame-navigate', navigate);
  contents.on('will-redirect', navigate);
  contents.on('will-attach-webview', event => event.preventDefault());
}

/** The initial main-window address contains no credentials. */
export function centralWindowUrl(serverUrl: string, route: PageRouteKey = 'chat'): string {
  return validateServerUrl(serverUrl) + '/' + pageHash(route);
}

/** Tracks whether the main window is on the local offline page and owns the
 * single in-flight fallback load. Already being offline is not a reason to
 * skip the fallback: a tray retry may fail after the first offline page. */
export class CentralWindowFallback {
  private offlineState = false;
  private pending: Promise<void> | undefined;

  get offline(): boolean { return this.offlineState; }

  markOnline(): void { this.offlineState = false; }

  restore(loadOffline: () => Promise<unknown>): Promise<void> {
    this.offlineState = true;
    if (this.pending) return this.pending;
    const pending = Promise.resolve()
      .then(loadOffline)
      .then(() => undefined, () => undefined)
      .finally(() => { if (this.pending === pending) this.pending = undefined; });
    this.pending = pending;
    return pending;
  }
}

type CentralWindowSettings = Pick<Config, 'serverUrl' | 'token' | 'authExpiresAt' | 'authSignedOut' | 'authSessionOnly'>;

/** Reload on changes to any part of the login, even when the origin is unchanged. */
export function centralConnectionIdentity(config: CentralWindowSettings): string {
  return [config.serverUrl, connectionToken(config) ?? '', config.authExpiresAt ?? '',
    config.authSignedOut ? 'signed-out' : 'signed-in', config.authSessionOnly ? 'session' : 'persistent'].join('\u0000');
}

export class CentralWindowLoader {
  private readonly fallback = new CentralWindowFallback();
  private pendingLoad: Promise<void> | undefined;
  private pendingTicket: { code: string; attempt: string; origin: string; identity: string } | undefined;

  constructor(
    private readonly window: Pick<BrowserWindow, 'loadURL' | 'isDestroyed'>,
    private readonly settings: () => CentralWindowSettings,
    private readonly offlineUrl: string,
  ) {}

  get offline(): boolean { return this.fallback.offline; }
  get loading(): boolean { return this.pendingLoad !== undefined; }

  restoreOffline(): Promise<void> {
    this.pendingTicket = undefined;
    if (this.window.isDestroyed()) return Promise.resolve();
    return this.fallback.restore(() => this.window.loadURL(this.offlineUrl));
  }

  takeLoginTicket(frame: Pick<WebFrameMain, 'origin' | 'url'>, attempt: unknown): string | undefined {
    const ticket = this.pendingTicket;
    if (!ticket || attempt !== ticket.attempt || this.window.isDestroyed() || frame.origin !== ticket.origin ||
        centralConnectionIdentity(this.settings()) !== ticket.identity) return undefined;
    const url = webUrl(frame.url);
    if (url?.origin !== ticket.origin ||
        new URLSearchParams(url.hash.split('?')[1] ?? '').get(centralWindowLoginParameter) !== attempt) return undefined;
    this.pendingTicket = undefined;
    return ticket.code;
  }

  load(): Promise<void> {
    return this.pendingLoad ??= Promise.resolve().then(() => this.loadCurrent());
  }

  private async loadCurrent(): Promise<void> {
    try {
      while (!this.window.isDestroyed()) {
        this.pendingTicket = undefined;
        const selected = { ...this.settings() };
        const identity = centralConnectionIdentity(selected);
        const token = connectionToken(selected);
        const origin = pairedCentralOrigin(selected.serverUrl, token);
        if (origin && token) {
          try {
            const grant = await loginRequest(selected, '/api/login/ticket', { expiresAt: selected.authExpiresAt }, token);
            if (typeof grant?.code !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(grant.code)) throw Error('Invalid login ticket');
            if (this.window.isDestroyed()) return;
            if (centralConnectionIdentity(this.settings()) !== identity) continue;

            // The query forces a fresh document. The non-secret fragment
            // marker follows same-origin redirects that drop the query.
            // The main frame obtains the ticket separately over IPC.
            const attempt = randomUUID();
            const url = new URL(centralWindowUrl(origin));
            url.searchParams.set(centralWindowLoginParameter, attempt);
            url.hash = pageHash('chat', { [centralWindowLoginParameter]: attempt });
            this.pendingTicket = { code: grant.code, attempt, origin, identity };
            await this.window.loadURL(url.href);
            this.fallback.markOnline();
          } catch {
            this.pendingTicket = undefined;
            if (this.window.isDestroyed()) return;
            if (centralConnectionIdentity(this.settings()) !== identity) continue;
            await this.restoreOffline();
          }
        } else {
          await this.restoreOffline();
        }
        if (centralConnectionIdentity(this.settings()) === identity) return;
      }
    } finally {
      this.pendingLoad = undefined;
    }
  }
}

/** Only the main Central window main frame, on the paired origin or the local
 * offline page, may ask the host to open the local window. */
export function trustedCentralWindowSender(
  facts: {senderId:number; mainSenderId:number; frameIsMain:boolean; frameUrl?:string},
  allowedOrigin: string | undefined,
  offlineUrl: string,
): boolean {
  if (facts.senderId !== facts.mainSenderId || !facts.frameIsMain || facts.frameUrl === undefined) return false;
  try {
    const frame = new URL(facts.frameUrl);
    if (frame.href === new URL(offlineUrl).href) return true;
    if (frame.username || frame.password) return false;
    return ['http:', 'https:'].includes(frame.protocol) && allowedOrigin !== undefined && frame.origin === allowedOrigin;
  } catch { return false; }
}

/** Only short-lived login exchanges may enter a URL; bearer credentials never do. */
export async function openCentralBrowser(serverUrl: string, page: string | undefined, platform: string,
  launchChrome: (url: string) => Promise<unknown>, openDefault: (url: string) => Promise<unknown>, evidenceId?: string, loginTicket?: string, loginRequestId?:string,workId?:string,conversationId?:string): Promise<void> {
  const origin = validateServerUrl(serverUrl);
  const route = page !== undefined && Object.hasOwn(centralPageRoutes, page) ? centralPageRoutes[page] : undefined;
  let hash = route ? pageHash(route) : ['notes', 'vault'].includes(page ?? '') ? '#' + page : page === 'about' ? '#/about' : '';
  if(conversationId!==undefined&&(page!=='ask'||workId!==undefined||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(conversationId)))throw Error('Invalid conversation destination');
  if(workId!==undefined){if(page!=='activity'||evidenceId!==undefined)throw Error('Invalid work destination');hash=deepLinkHash({kind:'run',id:validateCentralWorkId(workId)});}
  if (evidenceId !== undefined) {
    if (typeof evidenceId !== 'string' || !evidenceId.trim() || evidenceId.length > 4096 || /[\u0000-\u001f\u007f]/.test(evidenceId)) throw new Error('Invalid evidence reference');
    const bare=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(evidenceId);
    const parsed = bare?undefined:parseEvidenceRef(evidenceId);
    const material=/^material:mat_[a-f0-9]{64}@[a-f0-9]{64}$/.test(evidenceId);
    if(!material&&!bare&&(!parsed||parsed.kind!=='capture'))throw Error('Invalid evidence reference');
    const reference = material?evidenceId:formatEvidenceRef('capture',bare?evidenceId:parsed!.id);
    // The reference is query data, never a destination URL or credential.
    hash = deepLinkHash({kind:'reference',ref:reference,conversation:conversationId});
  } else if(conversationId) hash=deepLinkHash({kind:'conversation',id:conversationId});
  if(loginTicket||loginRequestId){
    const [route,query='']=hash.split('?');const params=new URLSearchParams(query);
    if(loginTicket)params.set('loginTicket',loginTicket);if(loginRequestId)params.set('loginRequest',loginRequestId);
    hash=(route||pageHash('chat'))+'?'+params;
  }
  const url = origin + '/' + hash;
  if (platform === 'darwin') {
    try { await launchChrome(url); return; } catch { /* Chrome may not be installed. */ }
  }
  await openDefault(url);
}
