import { moteText } from '@mote/shared/i18n';
import { connectionServerUrl, formatEvidenceRef, isMoteRunId, moteRoute, parseMoteReference, type MoteLinkScope, type MoteRoute } from '@mote/shared';
import type { Config } from './contracts';
import { connectionToken, loginRequest } from './login-session';
import { openCentralBrowser } from './central-browser';

export type BrowserLogin = (page?: string, evidenceId?: string, durationMs?: number, workId?: string,conversationId?:string) => Promise<void>;
export interface CentralNavigation {
  settings(): Config;
  authorizationGeneration(): number;
  browserLogin(): BrowserLogin | undefined;
  ensureBrowserLogin(): Promise<void>;
  platform: string;
  launchChrome(url: string): Promise<unknown>;
  openDefault(url: string): Promise<unknown>;
}

/** The exact instance scope a Mac handoff belongs to. Different spellings of
 * the same node URL must never imply another owner. */
export function centralScope(config: Pick<Config,'serverUrl'>): MoteLinkScope {
  return { origin: connectionServerUrl(config.serverUrl) };
}

/** Resolve the Mac handoff arguments through the shared deep-link schema.
 * Plain page destinations have no route identity; a reference, run or
 * conversation is validated and canonicalized before any ticket is minted. */
export function centralRoute(evidenceId?: string, workId?: string, conversationId?: string): MoteRoute | undefined {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (workId !== undefined) {
    if (conversationId !== undefined) throw Error('Invalid conversation destination');
    if (evidenceId !== undefined) throw Error('Invalid work destination');
    if (!isMoteRunId(workId)) throw Error('Invalid work reference');
    return moteRoute({ kind: 'run', id: workId });
  }
  if (evidenceId !== undefined) {
    if (!evidenceId.trim() || evidenceId !== evidenceId.trim() || evidenceId.length > 4096 || /[\u0000-\u001f\u007f]/.test(evidenceId)) throw Error('Invalid evidence reference');
    const reference = uuid.test(evidenceId) ? formatEvidenceRef('capture', evidenceId) : parseMoteReference(evidenceId);
    if (!reference || (!reference.startsWith('capture:') && !reference.startsWith('material:'))) throw Error('Invalid evidence reference');
    return moteRoute({ kind: 'reference', ref: reference, ...(conversationId !== undefined ? { conversation: conversationId } : {}) });
  }
  if (conversationId !== undefined) return moteRoute({ kind: 'conversation', id: conversationId });
  return undefined;
}

const changed = () => Error(moteText('登录会话已变更，请重新打开中央页面。'));
const sameLocation = (a: Config, b: Config) => {
  try { return centralScope(a).origin === centralScope(b).origin && a.deviceId === b.deviceId; }
  catch { return false; }
};
const sameSession = (a: Config, b: Config) => sameLocation(a,b) && a.token === b.token &&
  a.authSignedOut === b.authSignedOut && a.authExpiresAt === b.authExpiresAt &&
  a.authSessionOnly === b.authSessionOnly && a.authSourceBinding === b.authSourceBinding;

/** A delayed owner check may never install its credential into a different connection. */
export async function prepareBrowserSession(dependencies: {
  settings(): Config;
  authorizationGeneration(): number;
  inspect(config: Config): Promise<{credential:{id:string}}>;
  install(token:string,durationMs:number): Promise<void>;
}): Promise<void> {
  const selected = { ...dependencies.settings() }, generation = dependencies.authorizationGeneration();
  const token = connectionToken(selected);
  if (!token) return;
  const identity = await dependencies.inspect(selected);
  if (generation !== dependencies.authorizationGeneration() || !sameSession(selected,dependencies.settings()) || connectionToken(dependencies.settings()) !== token) throw changed();
  if (identity.credential.id === 'owner') {
    await dependencies.install(token,selected.authSessionOnly ? 0 : 2592000000);
    if (!sameLocation(selected,dependencies.settings())) throw changed();
  }
}

/** A late login grant belongs only to the connection that requested it. */
export async function pollBrowserLogin(dependencies: {
  current(): boolean;
  poll(): Promise<{ready?:boolean;token:string}>;
  install(token:string): Promise<void>;
  acknowledge(): Promise<unknown>;
  wait(): Promise<unknown>;
}, deadline = Date.now() + 10 * 60000): Promise<void> {
  while (Date.now() < deadline) {
    if (!dependencies.current()) throw changed();
    const grant = await dependencies.poll();
    if (!dependencies.current()) throw changed();
    if (grant.ready) {
      await dependencies.install(grant.token);
      await dependencies.acknowledge();
      return;
    }
    await dependencies.wait();
  }
  throw changed();
}

/** The desktop's current browser entry: establish a device session, then hand off a short-lived ticket. */
export async function showCentral(navigation: CentralNavigation, page?: string, evidenceId?: string, workId?: string,conversationId?:string): Promise<void> {
  const selected = { ...navigation.settings() };
  if (!connectionToken(selected)) {
    const login = navigation.browserLogin();
    if (login) return login(page, evidenceId, undefined, workId,conversationId);
    throw Error(moteText('先登录中央，各页面会共用这次登录'));
  }
  const route = centralRoute(evidenceId, workId, conversationId);
  await navigation.ensureBrowserLogin();
  const prepared = { ...navigation.settings() }, token = connectionToken(prepared), generation = navigation.authorizationGeneration();
  if (!sameLocation(selected,prepared) || !token) throw changed();
  const scope = centralScope(prepared);
  const target = route?.kind === 'run'
    ? { evidenceId: undefined, workId: route.id, conversationId: undefined }
    : route?.kind === 'reference'
      ? { evidenceId: route.ref, workId: undefined, conversationId: route.conversation }
      : route?.kind === 'conversation'
        ? { evidenceId: undefined, workId: undefined, conversationId: route.id }
        : { evidenceId, workId, conversationId };
  const ensureCurrent = () => {
    const current = navigation.settings();
    if (generation !== navigation.authorizationGeneration() || !sameSession(prepared,current) || connectionToken(current) !== token) throw changed();
  };
  const { code } = await loginRequest(prepared, '/api/login/ticket', { expiresAt: prepared.authExpiresAt }, token);
  ensureCurrent();
  await openCentralBrowser(scope.origin, page, navigation.platform,
    url => { ensureCurrent(); return navigation.launchChrome(url); },
    url => { ensureCurrent(); return navigation.openDefault(url); }, target.evidenceId, code, undefined, target.workId, target.conversationId);
}
