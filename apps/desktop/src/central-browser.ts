import { validateServerUrl } from './config';
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

/** The main window renders the paired Central page as untrusted content. It
 * never receives Node or the local preload, and its window keeps only these
 * minimum capabilities. */
export const centralWindowWebPreferences = {
  contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true,
} as const;

/** Keep in sync with central-window-preload.ts; the sandboxed preload cannot
 * import this module without pulling Node-only configuration code with it. */
export const centralWindowOpenLocalChannel = 'mote:central:open-local-window';

/** Same-origin navigation stays in the window. Other HTTP(S) destinations go
 * to the system browser. File, data, javascript and credential-bearing URLs
 * are denied without being handed to any external handler. */
export type CentralNavigationDecision = 'allow' | 'external' | 'deny';
export function centralNavigationDecision(target: string, allowedOrigin: string | undefined): CentralNavigationDecision {
  let url: URL;
  try { url = new URL(target); } catch { return 'deny'; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return 'deny';
  if (allowedOrigin !== undefined && url.origin === allowedOrigin) return 'allow';
  return 'external';
}

/** The initial main-window address. A login ticket is short-lived address data
 * inside the hash query; the bearer token never enters the URL. */
export function centralWindowUrl(serverUrl: string, loginTicket?: string, route: PageRouteKey = 'chat'): string {
  const origin = validateServerUrl(serverUrl);
  if (loginTicket !== undefined && !/^[A-Za-z0-9_-]{43}$/.test(loginTicket)) throw Error('Invalid login ticket');
  return origin + '/' + pageHash(route, loginTicket ? { loginTicket } : undefined);
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
