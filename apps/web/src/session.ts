import type { Connection } from './api';

export const connectionStorageKey = 'mote.connection';
export const periodStorageKey = 'mote.period';
export type Period = 'today' | 'week' | 'month' | 'all';
const validScope=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
export const periodValue=(value:unknown):Period=>value==='today'||value==='month'||value==='all'?value:'week';

export function readPeriod(connection:Connection|null):Period {
  try {
    const saved=JSON.parse(globalThis.sessionStorage?.getItem(periodStorageKey)??'null');
    if(connection?.viewScope&&(!connection.expiresAt||connection.expiresAt>Date.now())&&saved?.scope===connection.viewScope)return periodValue(saved.period);
    globalThis.sessionStorage?.removeItem(periodStorageKey);
  } catch { /* blocked or malformed view storage uses the default */ }
  return 'week';
}
export function savePeriod(connection:Connection|null,value:unknown):Period {
  const period=periodValue(value);
  try {if(connection?.viewScope&&(!connection.expiresAt||connection.expiresAt>Date.now()))globalThis.sessionStorage?.setItem(periodStorageKey,JSON.stringify({scope:connection.viewScope,period}));} catch { /* in-memory selection still works */ }
  return period;
}

export const sessionLifetimeStorageKey = 'mote.session-lifetime';
export type SessionLifetime = 'session' | '1d' | '7d' | '30d';
type PersistentLifetime = Exclude<SessionLifetime, 'session'>;

const lifetimeMs: Record<PersistentLifetime, number> = {
  '1d': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

export function sessionLifetime(value: unknown): SessionLifetime {
  return value === '1d' || value === '7d' || value === '30d' ? value : 'session';
}

export function readSessionLifetime(): SessionLifetime {
  try {
    return sessionLifetime(globalThis.localStorage?.getItem(sessionLifetimeStorageKey));
  } catch {
    return 'session';
  }
}

export function saveSessionLifetime(value: SessionLifetime): void {
  try {
    globalThis.localStorage?.setItem(sessionLifetimeStorageKey, value);
  } catch {
    // A browser with blocked storage can still use a tab-scoped session.
  }
}

export function connectionForLifetime(token: string, lifetime: SessionLifetime, now = Date.now()): Connection {
  const expiresAt = lifetime === 'session' ? undefined : now + lifetimeMs[lifetime];
  return expiresAt === undefined ? {token} : {token, expiresAt};
}

/** Persist only the browser session credential; the central owner token itself remains server-managed. */
export function persistSession(connection: Connection, lifetime: SessionLifetime, now = Date.now()): Connection {
  const selected=connectionForLifetime(connection.token,lifetime,now);
  const deadline=connection.serverExpiresAt===undefined?selected.expiresAt:selected.expiresAt===undefined?connection.serverExpiresAt:Math.min(selected.expiresAt,connection.serverExpiresAt);
  const stored = {...selected,...(connection.serverExpiresAt!==undefined?{serverExpiresAt:connection.serverExpiresAt}:{}),...(deadline!==undefined?{expiresAt:deadline}:{}),viewScope:validScope(connection.viewScope)?connection.viewScope:crypto.randomUUID()};
  try {
    globalThis.sessionStorage?.removeItem(connectionStorageKey);
    globalThis.localStorage?.removeItem(connectionStorageKey);
    (lifetime === 'session' ? globalThis.sessionStorage : globalThis.localStorage)?.setItem(connectionStorageKey, JSON.stringify(stored));
  } catch {
    try {
      globalThis.localStorage?.removeItem(connectionStorageKey);
      globalThis.sessionStorage?.setItem(connectionStorageKey, JSON.stringify(stored));
    } catch {
      // Keep the in-memory connection alive when browser storage is unavailable.
    }
  }
  return stored;
}

export function clearSession(): void {
  try { globalThis.sessionStorage?.removeItem(periodStorageKey); } catch { /* storage may be blocked */ }
  try { globalThis.sessionStorage?.removeItem(connectionStorageKey); } catch { /* storage may be blocked */ }
  try { globalThis.localStorage?.removeItem(connectionStorageKey); } catch { /* storage may be blocked */ }
}

/** Never move a credential saved for another server to the current service. */
export function restoreSession(raw: string | null, origin: string, now = Date.now()): Connection | null {
  try {
    const value = JSON.parse(raw || 'null');
    if (!value || typeof value.token !== 'string' || !value.token.trim()) return null;
    if (value.expiresAt !== undefined && (!Number.isSafeInteger(value.expiresAt) || value.expiresAt <= now)) return null;
    // Accept old same-service sessions; invalidate the former remote-node option.
    if (value.url !== undefined && value.url !== '' && value.url !== origin) return null;
    if(value.serverExpiresAt!==undefined&&(!Number.isSafeInteger(value.serverExpiresAt)||value.serverExpiresAt<=now))return null;
    return { token: value.token,...(value.serverExpiresAt===undefined?{}:{serverExpiresAt:value.serverExpiresAt}), ...(validScope(value.viewScope)?{viewScope:value.viewScope}:{}), ...(value.expiresAt === undefined ? {} : {expiresAt: value.expiresAt}) };
  } catch {
    return null;
  }
}

export function readStoredSession(origin: string, now = Date.now()): Connection | null {
  let raw: string | null = null;
  try { raw = globalThis.sessionStorage?.getItem(connectionStorageKey) ?? null; } catch { /* try persistent storage */ }
  const session = restoreSession(raw, origin, now);
  if (session) return ensureViewScope(session,'sessionStorage');
  try { raw = globalThis.localStorage?.getItem(connectionStorageKey) ?? null; } catch { raw = null; }
  const persistent = restoreSession(raw, origin, now);
  if (!persistent && raw) {
    try { globalThis.localStorage?.removeItem(connectionStorageKey); } catch { /* ignore stale storage */ }
  }
  return persistent?ensureViewScope(persistent,'localStorage'):null;
}

function ensureViewScope(connection:Connection,storage:'sessionStorage'|'localStorage'):Connection {
  if(connection.viewScope)return connection;
  const migrated={...connection,viewScope:crypto.randomUUID()};
  try {globalThis[storage]?.setItem(connectionStorageKey,JSON.stringify(migrated));} catch { /* keep the in-memory identity */ }
  return migrated;
}
