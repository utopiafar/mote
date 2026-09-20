import type { Connection } from './api';

export const connectionStorageKey = 'mote.connection';
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
  const stored = connectionForLifetime(connection.token, lifetime, now);
  try {
    globalThis.sessionStorage?.removeItem(connectionStorageKey);
    globalThis.localStorage?.removeItem(connectionStorageKey);
    (lifetime === 'session' ? globalThis.sessionStorage : globalThis.localStorage)?.setItem(connectionStorageKey, JSON.stringify(stored));
  } catch {
    try {
      globalThis.localStorage?.removeItem(connectionStorageKey);
      globalThis.sessionStorage?.setItem(connectionStorageKey, JSON.stringify({token: connection.token}));
    } catch {
      // Keep the in-memory connection alive when browser storage is unavailable.
    }
  }
  return stored;
}

export function clearSession(): void {
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
    return { token: value.token, ...(value.expiresAt === undefined ? {} : {expiresAt: value.expiresAt}) };
  } catch {
    return null;
  }
}

export function readStoredSession(origin: string, now = Date.now()): Connection | null {
  let raw: string | null = null;
  try { raw = globalThis.sessionStorage?.getItem(connectionStorageKey) ?? null; } catch { /* try persistent storage */ }
  const session = restoreSession(raw, origin, now);
  if (session) return session;
  try { raw = globalThis.localStorage?.getItem(connectionStorageKey) ?? null; } catch { raw = null; }
  const persistent = restoreSession(raw, origin, now);
  if (!persistent && raw) {
    try { globalThis.localStorage?.removeItem(connectionStorageKey); } catch { /* ignore stale storage */ }
  }
  return persistent;
}
