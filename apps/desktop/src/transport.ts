import { meteredBody } from './upload-meter';
import { moteText, getLocale } from '@mote/shared/i18n';
import type { CaptureEvent, Config } from './contracts';
import { validateServerUrl } from './config';
import { TransportFailure, failureCode, httpFailure, type EventJournal } from './support';
import { readResponseText } from './response-body';

// Authentication is the explicit Bearer header. Omit ambient HTTP credentials so
// fetch does not attempt to replay a streaming upload after a 401 response.
export class DeletedCaptureFailure extends TransportFailure {}

export async function uploadDeferredOcr(config: Config, id: string, ocrText: string, signal?: AbortSignal): Promise<void> {
  if (!config.token || !/^[a-f0-9-]{36}$/i.test(id)) throw new TransportFailure(moteText("OCR 补写配置无效"), 'CONFIG_INVALID');
  let response: Response;
  try {
    response = await fetch(`${validateServerUrl(config.serverUrl)}/api/capture-browser/${id}/ocr`, {
      method: 'POST', headers: { 'Accept-Language': getLocale(), Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
      credentials: 'omit', redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
      body: meteredBody(JSON.stringify({ ocrText, status: 'completed' })), ...({duplex:'half'} as object),
    });
  } catch { throw new TransportFailure(moteText("OCR 结果上传失败，已保留等待重试"), 'NETWORK'); }
  if (!response.ok) {
    if (response.status === 404) {
      let code: unknown; try { code = (JSON.parse(await readResponseText(response, 16384)) as { error?: unknown }).error; } catch { /* Unrecognized responses may come from an older node. */ }
      if (code === 'capture_not_found') throw new DeletedCaptureFailure(moteText("中央记录已删除，OCR 结果保留在本机待处理"), 'RESPONSE', 404);
      throw new TransportFailure(moteText("中央节点暂不支持 OCR 补写，请升级至 0.0.2 或更新版本；结果已保留等待重试"), 'RESPONSE', 404);
    }
    await response.body?.cancel().catch(() => undefined);
    if (response.status === 410) throw new DeletedCaptureFailure(moteText("中央记录已删除，OCR 结果保留在本机待处理"), 'RESPONSE', 410);
    throw new TransportFailure(moteText("OCR 补写返回 HTTP {0}，已保留等待重试", response.status), httpFailure(response.status), response.status);
  }
  const ack = JSON.parse(await readResponseText(response, 16384)) as { id?: string };
  if (ack.id !== id) throw new TransportFailure(moteText("OCR 补写确认 ID 不匹配，已保留等待重试"), 'RESPONSE');
}

export async function uploadCapture(config: Config, event: CaptureEvent, image?: Buffer, signal?: AbortSignal): Promise<void> {
  const origin = validateServerUrl(config.serverUrl);
  if (!config.token) throw new TransportFailure(moteText("请配置中央节点访问令牌"), 'CONFIG_INVALID');
  let response: Response;
  try {
    response = await fetch(`${origin}/api/captures`, {
      method: 'POST', headers: { 'Accept-Language': getLocale(), 'Authorization': `Bearer ${config.token}`, 'Content-Type': 'application/json' },
      credentials: 'omit', redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
      body: meteredBody(JSON.stringify({ ...event, ...(image ? { imageBase64: image.toString('base64') } : {}) })),
      ...({ duplex: 'half' } as object),
    });
  } catch (error) { const code = failureCode(error, 'UPLOAD'); throw new TransportFailure(moteText("无法连接中央节点，已保留本地队列并等待重试"), code === 'RESPONSE' ? 'NETWORK' : code); }
  if (response.status !== 200 && response.status !== 201) {
    await response.body?.cancel().catch(() => undefined);
    if (response.status === 401 || response.status === 403) throw new TransportFailure(moteText("中央节点拒绝访问，请检查令牌；队列已保留"), 'AUTH', response.status);
    if (response.status === 409) throw new TransportFailure(moteText("中央节点报告事件 ID 冲突；队列已保留，请检查服务端"), 'CONFLICT', response.status);
    if (response.status === 400 && event.ocr) throw new TransportFailure(moteText("当前截图协议未被接受，请先确认中央节点已升级至 0.0.2 或更新版本；队列已保留"), 'RESPONSE', 400);
    throw new TransportFailure(moteText("中央节点返回 HTTP {0}；队列已保留", response.status), httpFailure(response.status), response.status);
  }
  let ack: { id?: string };
  try { ack = JSON.parse(await readResponseText(response, 16384)) as { id?: string }; } catch { throw new TransportFailure(moteText("中央节点确认格式无效；队列已保留"), 'RESPONSE', response.status); }
  if (ack.id !== event.id) throw new TransportFailure(moteText("中央节点确认 ID 不匹配；队列已保留"), 'RESPONSE', response.status);
}

export async function heartbeat(config: Config, body: object, events?: EventJournal, signal?: AbortSignal): Promise<void> {
  if (!config.token) return;
  try {
    const response = await fetch(`${validateServerUrl(config.serverUrl)}/api/devices/heartbeat`, {
      method: 'POST', headers: { 'Accept-Language': getLocale(), 'Authorization': `Bearer ${config.token}`, 'Content-Type': 'application/json' },
      credentials: 'omit', redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000), body: JSON.stringify(body),
    });
    await response.body?.cancel().catch(() => undefined);
    if (!response.ok) void events?.record('HEARTBEAT', httpFailure(response.status), { httpStatus: response.status });
  } catch (error) { const code = failureCode(error, 'HEARTBEAT'); void events?.record('HEARTBEAT', code === 'RESPONSE' ? 'NETWORK' : code); }
}

export async function uploadCaptureBatch(config: Config, entries: { event: CaptureEvent; image?: Buffer }[], signal?: AbortSignal): Promise<Map<string, number>> {
  if (!config.token) throw new TransportFailure(moteText("请配置中央节点访问令牌"), 'CONFIG_INVALID');
  const response = await fetch(`${validateServerUrl(config.serverUrl)}/api/captures/batch`, {
    method: 'POST', credentials: 'omit', redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000),
    headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json', 'Accept-Language': getLocale() },
    body: meteredBody(JSON.stringify({ captures: entries.map(({event, image}) => ({ ...event, ...(image ? { imageBase64: image.toString('base64') } : {}) })) })),
    ...({ duplex: 'half' } as object),
  });
  if ([403, 404, 405, 413].includes(response.status)) {
    await response.body?.cancel();
    const receipts = new Map<string, number>();
    for (const entry of entries) {
      await uploadCapture(config, entry.event, entry.image, signal); receipts.set(entry.event.id, 201);
    }
    return receipts;
  }
  if (response.status !== 200) { await response.body?.cancel(); throw new TransportFailure(moteText("批量上传未确认（HTTP {0}）", response.status), httpFailure(response.status), response.status); }
  const body = JSON.parse(await readResponseText(response, 65536)) as { results?: {id: string; status: number}[] };
  const expected = new Set(entries.map(entry => entry.event.id)), result = new Map<string, number>();
  if (!Array.isArray(body.results) || body.results.length > entries.length) throw new TransportFailure('Invalid batch receipts', 'RESPONSE');
  for (const receipt of body.results) {
    if (!expected.has(receipt.id) || result.has(receipt.id) || !Number.isInteger(receipt.status) || !([200, 201].includes(receipt.status) || receipt.status >= 400 && receipt.status <= 599)) throw new TransportFailure('Invalid batch receipts', 'RESPONSE');
    result.set(receipt.id, receipt.status);
  }
  return result;
}
