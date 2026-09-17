import { moteText } from '@mote/shared/i18n';
import { spawn } from 'node:child_process';
import { UNKNOWN_FOREGROUND } from './app-collection';

export interface ActiveApplication { appId: string; appName: string; pid: number; visibleAppIds: string[]; unknownVisibleWindows: boolean }
export function runHelper(path: string, command: 'calendar-status' | 'notifications' | 'screen-permission' | 'active' | 'activity' | 'device' | 'ocr' | 'power' | 'qr' | 'installed-apps', input?: Buffer, signal?: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(path, [command], { stdio: ['pipe', 'pipe', 'pipe'], signal });
    const chunks: Buffer[] = [];
    let length = 0;
    const timeout = setTimeout(() => child.kill(), command === 'ocr' ? 20000 : 5000);
    child.stdout.on('data', (data: Buffer) => {
      length += data.length;
      if (length > 1024 * 1024) child.kill();
      else chunks.push(data);
    });
    child.stderr.resume();
    child.on('error', () => { clearTimeout(timeout); reject(new Error(moteText("本地 macOS 助手不可用"))); });
    child.on('close', code => {
      clearTimeout(timeout);
      if (code !== 0 || length > 1024 * 1024) { reject(new Error(moteText("本地 macOS 助手执行失败，本次采集已跳过"))); return; }
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new Error(moteText("本地 macOS 助手返回值无效"))); }
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(input);
  });
}
export async function readVisibleNotifications(path:string,signal?:AbortSignal):Promise<string[]> {
  const raw=await runHelper(path,'notifications',undefined,signal) as {available?:boolean;items?:{text?:unknown}[]};
  if(!raw.available)return [];
  if(!Array.isArray(raw.items)||raw.items.length>20)throw new Error('Invalid notification observation');
  return raw.items.map(item=>{if(typeof item.text!=='string'||item.text.length>4000)throw new Error('Invalid notification content');return item.text;});
}
export async function readInstalledApplications(path: string): Promise<{ appId: string; appName: string }[]> {
  const value = await runHelper(path, 'installed-apps') as { applications?: unknown };
  if (!Array.isArray(value?.applications) || value.applications.length > 2048) throw new Error(moteText("无法读取应用列表"));
  const applications = new Map<string, { appId: string; appName: string }>();
  for (const item of value.applications) {
    if (!item || typeof item.appId !== 'string' || !item.appId || item.appId.length > 256 || typeof item.appName !== 'string' || !item.appName || item.appName.length > 512) continue;
    applications.set(item.appId, { appId: item.appId, appName: item.appName });
  }
  return [...applications.values()].sort((a, b) => a.appName.localeCompare(b.appName));
}
export async function activeApplication(path: string, signal?: AbortSignal): Promise<ActiveApplication> {
  const value = await runHelper(path, 'active', undefined, signal) as ActiveApplication;
  if (!value || typeof value.appId !== 'string' || !value.appId || value.appId.length > 256 || typeof value.appName !== 'string' || !value.appName || value.appName.length > 512 || !Number.isInteger(value.pid) || !Array.isArray(value.visibleAppIds) || value.visibleAppIds.some(id => typeof id !== 'string' || !id) || typeof value.unknownVisibleWindows !== 'boolean') throw new Error(moteText("无法确认屏幕应用身份，本次采集已跳过"));
  return value;
}
export async function recognizeText(path: string, image: Buffer, signal?: AbortSignal): Promise<string> {
  const value = await runHelper(path, 'ocr', image, signal) as { text: string };
  if (!value || typeof value.text !== 'string' || value.text.length > 100000) throw new Error(moteText("本地 OCR 返回值无效"));
  return value.text;
}

export interface PowerState { batteryPercent?: number; charging?: boolean; onBattery?: boolean }
export async function readPowerState(path: string, signal?: AbortSignal): Promise<PowerState> {
  const value = await runHelper(path, 'power', undefined, signal) as PowerState;
  if (!value || typeof value !== 'object') return {};
  return {
    ...(typeof value.batteryPercent === 'number' && Number.isFinite(value.batteryPercent) && value.batteryPercent >= 0 && value.batteryPercent <= 100 ? { batteryPercent: value.batteryPercent } : {}),
    ...(typeof value.charging === 'boolean' ? { charging: value.charging } : {}),
    ...(typeof value.onBattery === 'boolean' ? { onBattery: value.onBattery } : {}),
  };
}

export async function recognizeInvitationQr(path: string, image: Buffer): Promise<string> {
  if (image.length > 8 * 1024 * 1024) throw new Error(moteText("二维码图片不能超过 8 MiB"));
  try {
    const value = await runHelper(path, 'qr', image) as { payloads?: unknown };
    if (!Array.isArray(value?.payloads) || value.payloads.length !== 1 || typeof value.payloads[0] !== 'string' || Buffer.byteLength(value.payloads[0]) > 8192) throw new Error();
    return value.payloads[0];
  } catch { throw new Error(moteText("未找到唯一有效二维码，请选择清晰的单个连接二维码，或导入 JSON")); }
}

export type ForegroundApplication = Pick<ActiveApplication, 'appId' | 'appName' | 'pid'>;
export async function foregroundApplication(path: string, signal?: AbortSignal): Promise<ForegroundApplication> {
  const value = await runHelper(path, 'activity', undefined, signal) as ForegroundApplication;
  if (!value || typeof value.appId !== 'string' || !value.appId || value.appId.length > 256 || typeof value.appName !== 'string' || !value.appName || value.appName.length > 200 || !Number.isInteger(value.pid) || (value.pid <= 0 && !(value.pid === 0 && value.appId === UNKNOWN_FOREGROUND))) throw new Error(moteText("无法确认前台应用身份，本次记录已跳过"));
  return { appId: value.appId, appName: value.appName, pid: value.pid };
}
export async function readDeviceMetadata(path: string, signal?: AbortSignal): Promise<{ device?: import('@mote/shared').RecordMetadata['device']; state?: import('@mote/shared').RecordMetadata['state'] }> {
  const value = await runHelper(path, 'device', undefined, signal);
  const { recordMetadataSchema } = await import('@mote/shared/metadata');
  return recordMetadataSchema.parse({ ...(value as object), version: 1, observedAt: new Date().toISOString() });
}
