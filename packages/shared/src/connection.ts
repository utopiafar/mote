import { moteText } from './i18n.js';
export interface ConnectionInvitation {
  format: 'mote.connection';
  version: 1;
  serverUrl: string;
  code: string;
  expiresAt: string;
}

export const CONNECTION_INPUT_MAX_BYTES = 8192;

export function connectionServerUrl(input: string): string {
  if (typeof input !== 'string' || input.length > 2048 || input !== input.trim() || /[\s\\\u0000-\u001f\u007f]/u.test(input)) throw new Error(moteText("节点地址格式无效"));
  let url: URL;
  try { url = new URL(input); } catch { throw new Error(moteText("请填写完整的中央节点地址")); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error(moteText("远程节点须使用 HTTPS；地址不能包含账号、路径、查询或片段"));
  }
  return url.origin;
}

function validate(value: unknown, now: number): ConnectionInvitation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(moteText("连接邀请格式无效"));
  const v = value as Record<string, unknown>;
  if (Object.keys(v).sort().join(',') !== 'code,expiresAt,format,serverUrl,version' || v.format !== 'mote.connection' || v.version !== 1 || typeof v.serverUrl !== 'string' || typeof v.code !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(v.code) || typeof v.expiresAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(v.expiresAt)) throw new Error(moteText("请导入有效的 Mote v1 连接邀请"));
  const expires = Date.parse(v.expiresAt);
  if (!Number.isFinite(expires) || !Number.isFinite(now) || expires <= now) throw new Error(moteText("连接邀请已过期，请在中央节点重新生成"));
  const serverUrl = connectionServerUrl(v.serverUrl);
  return { format: 'mote.connection', version: 1, serverUrl, code: v.code, expiresAt: v.expiresAt };
}

export function parseConnectionInvitation(input: string, now = Date.now()): ConnectionInvitation {
  if (typeof input !== 'string' || new TextEncoder().encode(input).length > CONNECTION_INPUT_MAX_BYTES) throw new Error(moteText("连接邀请不能超过 8 KiB"));
  let json = input.trim();
  if (json.startsWith('mote:')) {
    // Deliberately accept one canonical URI shape: no extra fields, authorities or redirects.
    const match = /^mote:\/\/connect\?data=([A-Za-z0-9_-]+)$/.exec(json);
    if (!match) throw new Error(moteText("Mote 连接链接格式无效"));
    try {
      const encoded = match[1]!;
      const binary = atob(encoded.replace(/-/g, '+').replace(/_/g, '/'));
      const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
      json = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      const canonical = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      if (encoded !== canonical) throw new Error('Invalid encoding');
    } catch { throw new Error(moteText("Mote 连接链接编码无效")); }
  }
  let value: unknown;
  try { value = JSON.parse(json); } catch { throw new Error(moteText("请粘贴连接邀请 JSON 或 mote://connect 链接")); }
  return validate(value, now);
}

export function encodeConnectionInvitation(invitation: ConnectionInvitation, now = Date.now()): string {
  return JSON.stringify(validate(invitation, now), null, 2);
}

export function connectionUri(invitation: ConnectionInvitation, now = Date.now()): string {
  const bytes = new TextEncoder().encode(JSON.stringify(validate(invitation, now)));
  const encoded = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `mote://connect?data=${encoded}`;
}
