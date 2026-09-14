import type { CaptureEvent, Config } from './contracts';
import { validateServerUrl } from './config';
import { TransportFailure, failureCode, httpFailure, type EventJournal } from './support';
import { readResponseText } from './response-body';

export async function uploadCapture(config: Config, event: CaptureEvent, image?: Buffer, signal?: AbortSignal): Promise<void> {
  const origin = validateServerUrl(config.serverUrl);
  if (!config.token) throw new TransportFailure('请配置中央节点访问令牌', 'CONFIG_INVALID');
  let response: Response;
  try {
    response = await fetch(`${origin}/api/captures`, {
      method: 'POST', headers: { 'Authorization': `Bearer ${config.token}`, 'Content-Type': 'application/json' },
      redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
      body: JSON.stringify({ ...event, ...(image ? { imageBase64: image.toString('base64') } : {}) }),
    });
  } catch (error) { const code = failureCode(error, 'UPLOAD'); throw new TransportFailure('无法连接中央节点，已保留本地队列并等待重试', code === 'RESPONSE' ? 'NETWORK' : code); }
  if (response.status !== 200 && response.status !== 201) {
    await response.body?.cancel().catch(() => undefined);
    if (response.status === 401 || response.status === 403) throw new TransportFailure('中央节点拒绝访问，请检查令牌；队列已保留', 'AUTH', response.status);
    if (response.status === 409) throw new TransportFailure('中央节点报告事件 ID 冲突；队列已保留，请检查服务端', 'CONFLICT', response.status);
    throw new TransportFailure(`中央节点返回 HTTP ${response.status}；队列已保留`, httpFailure(response.status), response.status);
  }
  let ack: { id?: string };
  try { ack = JSON.parse(await readResponseText(response, 16384)) as { id?: string }; } catch { throw new TransportFailure('中央节点确认格式无效；队列已保留', 'RESPONSE', response.status); }
  if (ack.id !== event.id) throw new TransportFailure('中央节点确认 ID 不匹配；队列已保留', 'RESPONSE', response.status);
}

export async function heartbeat(config: Config, body: object, events?: EventJournal): Promise<void> {
  if (!config.token) return;
  try {
    const response = await fetch(`${validateServerUrl(config.serverUrl)}/api/devices/heartbeat`, {
      method: 'POST', headers: { 'Authorization': `Bearer ${config.token}`, 'Content-Type': 'application/json' },
      redirect: 'error', signal: AbortSignal.timeout(5000), body: JSON.stringify(body),
    });
    await response.body?.cancel().catch(() => undefined);
    if (!response.ok) void events?.record('HEARTBEAT', httpFailure(response.status), { httpStatus: response.status });
  } catch (error) { const code = failureCode(error, 'HEARTBEAT'); void events?.record('HEARTBEAT', code === 'RESPONSE' ? 'NETWORK' : code); }
}
