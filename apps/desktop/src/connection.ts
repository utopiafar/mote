import { moteText, getLocale } from '@mote/shared/i18n';
import { randomUUID } from 'node:crypto';
import { parseDesktopConnectionInvitation, type DesktopConnectionInvitation } from './connection-invitation';
import { ProtocolCompatibilityError, requireCompatibleProtocol, type ProtocolRange } from '@mote/shared/protocol';
import {DESKTOP_PROTOCOL_HEADERS,validateAccount,type DesktopAccount} from './account';
import {httpFailureMessage,responseFailureCode} from '@mote/shared';
import type { Config } from './contracts';
import { validateServerUrl } from './config';
export interface ConnectionPreview { id: string; serverUrl: string; expiresAt: string; deploymentId:string; userId:string; deviceId?:string }
export interface ConnectionIdentity {
  account:DesktopAccount & {credentialId:string;administrator:boolean;authorizationEpoch:number};
  credential: { id:string; scope:'client'; kind:'client'; expiresAt:number; deviceId?:string };
  protocol:ProtocolRange;
  capabilities: {authentication:boolean;ingest:boolean;ingressVersion:number;archiveRead:boolean};
}
export interface ConnectionStatus { state: 'unchecked' | 'checking' | 'connected' | 'error'; message: string; checkedAt?: string; identity?: ConnectionIdentity }
export class ConnectionError extends Error { constructor(readonly code: string, message: string,readonly httpStatus?:number,readonly reason?:string) { super(message); } }
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
export async function connectionRequest(serverUrl: string, path: string, init: RequestInit, fetcher: typeof fetch): Promise<unknown> {
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
  const result = object(await connectionRequest(config.serverUrl, '/api/connections/self', { credentials:'omit',headers: { ...DESKTOP_PROTOCOL_HEADERS, 'Accept-Language': getLocale(), Authorization: 'Bearer ' + config.token } }, fetcher), ['account','credential','protocol','capabilities']);
  const account=object(result.account,['userId','username','administrator','disabled','authorizationEpoch','createdAt','deploymentId','credentialId']);
  const credential = object(result.credential, ['kind','expiresAt'], ['deviceId']);
  if (credential.kind !== 'client'||account.disabled!==false||typeof account.administrator!=='boolean'||!Number.isSafeInteger(account.authorizationEpoch)||Number(account.authorizationEpoch)<0||!Number.isFinite(credential.expiresAt)||Number(credential.expiresAt)<=Date.now()) throw invalid();
  const capabilities = object(result.capabilities, ['authentication','ingest','ingressVersion','archiveRead']);
  let protocol: ProtocolRange;
  try { protocol = requireCompatibleProtocol(result.protocol,{min:2,max:2}); }
  catch (error) { if (error instanceof ProtocolCompatibilityError && error.code === 'incompatible_protocol') throw new ConnectionError('PROTOCOL_INCOMPATIBLE', httpFailureMessage(426,'incompatible_protocol')); throw invalid(); }
  if (['authentication','ingest','archiveRead'].some(key=>typeof capabilities[key]!=='boolean')||capabilities.ingressVersion!==3||(enforceDevice&&credential.deviceId!==undefined&&credential.deviceId!==config.deviceId))throw invalid();
  const stable=validateAccount({origin:validateServerUrl(config.serverUrl),deploymentId:bounded(account.deploymentId,200),userId:bounded(account.userId,200),username:bounded(account.username,200)},validateServerUrl(config.serverUrl));
  return {account:{...stable,credentialId:bounded(account.credentialId,128),administrator:account.administrator as boolean,authorizationEpoch:account.authorizationEpoch as number},credential:{id:bounded(account.credentialId,128),scope:'client',kind:'client',expiresAt:Number(credential.expiresAt),...(credential.deviceId!==undefined?{deviceId:bounded(credential.deviceId,200)}:{})},protocol,capabilities:capabilities as unknown as ConnectionIdentity['capabilities']};
}
export class ConnectionOnboarding {
  private pending?: { preview: ConnectionPreview; invitation: DesktopConnectionInvitation };
  constructor(private fetcher: typeof fetch = fetch, private now = Date.now) {}
  preview(input: unknown): ConnectionPreview {
    this.pending = undefined;
    if (typeof input !== 'string') throw new ConnectionError('INPUT', moteText("请导入连接邀请文字"));
    const invitation = parseDesktopConnectionInvitation(input, this.now());
    const preview = { id: randomUUID(), serverUrl: invitation.serverUrl, expiresAt: invitation.expiresAt, deploymentId:invitation.deploymentId,userId:invitation.userId,...(invitation.deviceId?{deviceId:invitation.deviceId}:{}) };
    this.pending = { preview, invitation }; return { ...preview };
  }
  clear(): void { this.pending = undefined; }
  confirm(id:unknown,origin:unknown):DesktopConnectionInvitation{
    const pending=this.pending;
    if(!pending||pending.preview.id!==id||pending.preview.serverUrl!==origin)throw new ConnectionError('CONFIRMATION',moteText('请先预览邀请并确认显示的中央地址'));
    return parseDesktopConnectionInvitation(JSON.stringify(pending.invitation),this.now());
  }
}
export function assertConnectionChangeSafe(state: { running: boolean; inFlight: boolean; queued: number; preparedNote: boolean; sourcePending: number; sourceInFlight: boolean }, sameNodeInvitation = false): void {
  if (state.running) throw new Error(moteText("请先停止采集，再更换连接"));
  if (!sameNodeInvitation && (state.queued || state.preparedNote || state.sourcePending)) throw new Error(moteText("还有待上传截图、随手记或来源版本，不能更换节点或凭据；请先完成上传或备份处理旧队列"));
  if (state.inFlight || state.sourceInFlight) throw new Error(moteText("当前采集、上传或来源同步尚未结束，请稍后重试连接"));
}
