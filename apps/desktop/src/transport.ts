import type { CaptureEvent, Config } from './contracts';
import { validateServerUrl } from './config';

export async function uploadCapture(config: Config, event: CaptureEvent, image?: Buffer, signal?: AbortSignal): Promise<void> {
  const origin = validateServerUrl(config.serverUrl);
  if (!config.token) throw new Error('请配置中央节点访问令牌');
  let response: Response;
  try {
    response = await fetch(`${origin}/api/captures`, {
      method: 'POST', headers: { 'Authorization': `Bearer ${config.token}`, 'Content-Type': 'application/json' },
      redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
      body: JSON.stringify({ ...event, ...(image ? { imageBase64: image.toString('base64') } : {}) }),
    });
  } catch { throw new Error('无法连接中央节点，已保留本地队列并等待重试'); }
  if (response.status !== 200 && response.status !== 201) {
    if (response.status === 401 || response.status === 403) throw new Error('中央节点拒绝访问，请检查令牌；队列已保留');
    if (response.status === 409) throw new Error('中央节点报告事件 ID 冲突；队列已保留，请检查服务端');
    throw new Error(`中央节点返回 HTTP ${response.status}；队列已保留`);
  }
  let ack: { id?: string };
  try { ack = await response.json() as { id?: string }; } catch { throw new Error('中央节点确认格式无效；队列已保留'); }
  if (ack.id !== event.id) throw new Error('中央节点确认 ID 不匹配；队列已保留');
}

export async function heartbeat(config: Config, body: object): Promise<void> {
  if (!config.token) return;
  try {
    await fetch(`${validateServerUrl(config.serverUrl)}/api/devices/heartbeat`, {
      method: 'POST', headers: { 'Authorization': `Bearer ${config.token}`, 'Content-Type': 'application/json' },
      redirect: 'error', signal: AbortSignal.timeout(5000), body: JSON.stringify(body),
    });
  } catch { /* Capture and upload status remain authoritative; heartbeats are best effort. */ }
}
