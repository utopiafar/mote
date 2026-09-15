import type { Connection } from './api';

/** Never move a credential saved for another server to the current service. */
export function restoreSession(raw: string | null, origin: string): Connection | null {
  try {
    const value = JSON.parse(raw || 'null');
    if (!value || typeof value.token !== 'string' || !value.token.trim()) return null;
    // Accept old same-service sessions; invalidate the former remote-node option.
    if (value.url !== undefined && value.url !== '' && value.url !== origin) return null;
    return { token: value.token };
  } catch {
    return null;
  }
}
