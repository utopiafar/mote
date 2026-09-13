import { spawn } from 'node:child_process';

export interface ActiveApplication { appId: string; appName: string; pid: number; visibleAppIds: string[]; unknownVisibleWindows: boolean }
export function runHelper(path: string, command: 'active' | 'ocr' | 'power', input?: Buffer, signal?: AbortSignal): Promise<unknown> {
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
    child.on('error', () => { clearTimeout(timeout); reject(new Error('本地 macOS 助手不可用')); });
    child.on('close', code => {
      clearTimeout(timeout);
      if (code !== 0 || length > 1024 * 1024) { reject(new Error('本地 macOS 助手执行失败，本次采集已跳过')); return; }
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new Error('本地 macOS 助手返回值无效')); }
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(input);
  });
}
export async function activeApplication(path: string, signal?: AbortSignal): Promise<ActiveApplication> {
  const value = await runHelper(path, 'active', undefined, signal) as ActiveApplication;
  if (!value || typeof value.appId !== 'string' || !value.appId || value.appId.length > 256 || typeof value.appName !== 'string' || !value.appName || value.appName.length > 512 || !Number.isInteger(value.pid) || !Array.isArray(value.visibleAppIds) || value.visibleAppIds.some(id => typeof id !== 'string' || !id) || typeof value.unknownVisibleWindows !== 'boolean') throw new Error('无法确认屏幕应用身份，本次采集已跳过');
  return value;
}
export async function recognizeText(path: string, image: Buffer, signal?: AbortSignal): Promise<string> {
  const value = await runHelper(path, 'ocr', image, signal) as { text: string };
  if (!value || typeof value.text !== 'string' || value.text.length > 100000) throw new Error('本地 OCR 返回值无效');
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
