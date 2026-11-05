import type { ConnectionPreview, ConnectionIdentity, ConnectionStatus } from './contracts/connection';
export type { ConnectionPreview, ConnectionIdentity, ConnectionStatus } from './contracts/connection';
import { moteText, getLocale } from '@mote/shared/i18n';
import { randomUUID } from 'node:crypto';
import {httpFailureMessage,responseFailureCode} from '@mote/shared';
import { parseConnectionInvitation, type ConnectionInvitation } from '@mote/shared/connection';
import { MOTE_PROTOCOL_HEADERS, ProtocolCompatibilityError, requireCompatibleProtocol, type ProtocolRange } from '@mote/shared/protocol';
import type { Config, Platform } from './contracts';
import { validateServerUrl } from './config';

export class ConnectionError extends Error { constructor(readonly code: string, message: string, readonly status?: number, readonly reason?: string) { super(message); } }
const invalid = () => new ConnectionError('INVALID_RESPONSE', moteText("中央确认格式无效，原连接保持不变"));
const object = (value: unknown, required: string[], optional: string[] = []): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || required.some(key => !(key in value)) || Object.keys(value).some(key => ![...required, ...optional].includes(key))) throw invalid();
  return value as Record<string, unknown>;
};
const bounded = (value: unknown, max: number, empty = false): string => { if (typeof value !== 'string' || (!empty && !value) || value.length > max || /[\x00-\x1f\x7f]/.test(value)) throw invalid(); return value; };
async function responseJson(response: Response): Promise<unknown> {
  if (Number(response.headers.get('content-length')) > 16384 || !response.body) { await response.body?.cancel(); throw invalid(); }
  const chunks: Uint8Array[] = []; let length = 0;
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) { length += chunk.length; if (length > 16384) throw invalid(); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw invalid(); }
}
async function request(serverUrl: string, path: string, init: RequestInit, fetcher: typeof fetch): Promise<unknown> {
  try {
    const response = await fetcher(validateServerUrl(serverUrl) + path, { ...init, redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (!response.ok) {
      let reason:string|undefined;try{reason=responseFailureCode(await responseJson(response));}catch{}
      if(reason==='device_already_registered')throw new ConnectionError('DEVICE_CONFLICT',moteText('设备已在中央登记，或邀请已使用；请在中央选择此设备重新生成邀请'),response.status,reason);
      const code=[401,403].includes(response.status)?'AUTH':response.status===410?'INVITATION_EXPIRED':response.status===426?'PROTOCOL_INCOMPATIBLE':response.status===429?'RATE_LIMIT':'HTTP';
      throw new ConnectionError(code,httpFailureMessage(response.status,reason),response.status,reason);
    }
    return await responseJson(response);
  } catch (error) { if (error instanceof ConnectionError) throw error; throw new ConnectionError('NETWORK', moteText("连接失败或超时；请检查中央地址、HTTPS 证书和网络，不接受重定向")); }
}
export async function testConnection(config: Pick<Config, 'serverUrl' | 'token' | 'deviceId'>, fetcher: typeof fetch = fetch, enforceDevice = true): Promise<ConnectionIdentity> {
  if (!config.token) throw new ConnectionError('MISSING_TOKEN', moteText("请先导入连接邀请，或保存访问令牌"));
  const result = object(await request(config.serverUrl, '/api/connections/self', { headers: { ...MOTE_PROTOCOL_HEADERS, 'Accept-Language': getLocale(), Authorization: 'Bearer ' + config.token } }, fetcher), ['credential', 'node', 'capabilities']);
  const credential = object(result.credential, ['id', 'scope', 'label'], ['deviceId', 'deviceName', 'platform', 'serverUrl']);
  if (credential.scope !== 'owner') throw invalid();
  const node = object(result.node, ['version', 'profile', 'protocol']), capabilities = object(result.capabilities, ['ingest', 'ownSources', 'archiveRead'], ['ingressVersion']);
  let protocol: ProtocolRange;
  try { protocol = requireCompatibleProtocol(node.protocol); }
  catch (error) { if (error instanceof ProtocolCompatibilityError && error.code === 'incompatible_protocol') throw new ConnectionError('PROTOCOL_INCOMPATIBLE', httpFailureMessage(426,'incompatible_protocol')); throw invalid(); }
  if (['ingest', 'ownSources', 'archiveRead'].some(key => typeof capabilities[key] !== 'boolean') || (capabilities.ingressVersion !== undefined && (!Number.isInteger(capabilities.ingressVersion) || (capabilities.ingressVersion as number) < 1)) || (enforceDevice && credential.deviceId !== undefined && credential.deviceId !== config.deviceId)) throw invalid();
  const cleanCredential: ConnectionIdentity['credential'] = { id: bounded(credential.id, 128), scope: credential.scope as 'owner', label: bounded(credential.label, 200, true) };
  for (const key of ['deviceId', 'deviceName', 'platform', 'serverUrl'] as const) if (credential[key] !== undefined) cleanCredential[key] = bounded(credential[key], key === 'serverUrl' ? 2048 : 200);
  if (cleanCredential.serverUrl && validateServerUrl(cleanCredential.serverUrl) !== config.serverUrl) throw invalid();
  return { credential: cleanCredential, node: { version: bounded(node.version, 100), profile: bounded(node.profile, 100), protocol }, capabilities: capabilities as unknown as ConnectionIdentity['capabilities'] };
}
export class ConnectionOnboarding {
  private pending?: { preview: ConnectionPreview; invitation: ConnectionInvitation };
  constructor(private fetcher: typeof fetch = fetch, private now = Date.now) {}
  preview(input: unknown): ConnectionPreview {
    this.pending = undefined;
    if (typeof input !== 'string') throw new ConnectionError('INPUT', moteText("请导入连接邀请文字"));
    const invitation = parseConnectionInvitation(input, this.now());
    const preview = { id: randomUUID(), serverUrl: invitation.serverUrl, expiresAt: invitation.expiresAt };
    this.pending = { preview, invitation }; return { ...preview };
  }
  clear(): void { this.pending = undefined; }
  async redeem(id: unknown, confirmedOrigin: unknown, config: Pick<Config, 'deviceId' | 'deviceName'>, platform: Platform): Promise<{ serverUrl: string; token: string; credentialId: string; scope: 'owner' }> {
    const pending = this.pending;
    if (!pending || pending.preview.id !== id || pending.preview.serverUrl !== confirmedOrigin) throw new ConnectionError('CONFIRMATION', moteText("请先预览邀请并确认显示的中央地址"));
    const invitation = parseConnectionInvitation(JSON.stringify(pending.invitation), this.now());
    const result = object(await request(invitation.serverUrl, '/api/connections/redeem', { method: 'POST', headers: { 'Accept-Language': getLocale(), 'Content-Type': 'application/json' }, body: JSON.stringify({ code: invitation.code, deviceId: config.deviceId, deviceName: config.deviceName, platform }) }, this.fetcher), ['serverUrl', 'token', 'credentialId', 'scope']);
    const serverUrl = bounded(result.serverUrl, 2048), token = bounded(result.token, 4096), credentialId = bounded(result.credentialId, 128);
    if (result.scope !== 'owner' || token.length < 32 || validateServerUrl(serverUrl) !== invitation.serverUrl || serverUrl !== invitation.serverUrl) throw invalid();
    this.pending = undefined;
    return { serverUrl, token, credentialId, scope: result.scope as 'owner' };
  }
}
export function assertConnectionChangeSafe(state: { running: boolean; inFlight: boolean; queued: number; preparedNote: boolean; sourcePending: number; sourceInFlight: boolean }, sameNodeInvitation = false): void {
  if (state.running) throw new Error(moteText("请先停止采集，再更换连接"));
  if (!sameNodeInvitation && (state.queued || state.preparedNote || state.sourcePending)) throw new Error(moteText("还有待上传截图、记录或来源版本，不能更换节点或凭据；请先完成上传或备份处理旧队列"));
  if (state.inFlight || state.sourceInFlight) throw new Error(moteText("当前采集、上传或来源同步尚未结束，请稍后重试连接"));
}
