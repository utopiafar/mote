import { moteText } from '@mote/shared/i18n';
import { spawn } from 'node:child_process';
import { sourceHash } from './source-sync';
import { redactSourceText, type CalendarChoice, type SourceOptions, type SourceScan } from './source-types';
export class CalendarPermissionError extends Error { constructor() { super(moteText("日历未授权或权限已撤销，请点击连接日历并检查系统设置")); } }
export async function calendarHelper(path: string, command: 'calendar-permission' | 'calendar-list' | 'calendar-scan' | 'calendar-create', input?: unknown, signal?: AbortSignal): Promise<unknown> {
  if (process.platform !== 'darwin') throw new Error(moteText("本地日历当前仅支持 macOS"));
  return new Promise((resolve, reject) => {
    const child = spawn(path, [command], { stdio: ['pipe', 'pipe', 'ignore'] });
    const chunks: Buffer[] = []; let bytes = 0; let done = false;
    const finish = (error?: Error, value?: unknown) => { if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); error ? reject(error) : resolve(value); };
    const abort = () => { child.kill('SIGKILL'); finish(new Error(moteText("日历读取已取消"))); };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(new Error(moteText("日历读取超时，可重试或检查系统权限"))); }, command === 'calendar-permission' ? 120000 : 20000);
    signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
    child.stdout.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 9 * 1024 * 1024) { child.kill('SIGKILL'); finish(new Error(moteText("日历读取超过安全上限"))); } else chunks.push(chunk); });
    child.on('error', () => finish(new Error(moteText("无法启动日历助手，请检查应用安装"))));
    child.on('close', code => { if (done) return; if (code !== 0) return finish(new Error(moteText("日历读取失败，请检查日历权限后重试"))); try { finish(undefined, JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { finish(new Error(moteText("日历助手返回格式无效"))); } });
    child.stdin.on('error', () => {}); child.stdin.end(input ? JSON.stringify(input) : '');
  });
}
export function decodeCalendarChoices(raw: unknown): CalendarChoice[] {
  const value = raw as { permission?: string; calendars?: CalendarChoice[] };
  if (value?.permission !== 'granted') throw new CalendarPermissionError();
  if (!Array.isArray(value.calendars) || value.calendars.length > 500 || value.calendars.some(c => typeof c.id !== 'string' || c.id.length > 1000 || typeof c.title !== 'string' || c.title.length > 2000)) throw new Error(moteText("日历列表格式无效"));
  return value.calendars;
}
export function decodeCalendarScan(raw: unknown, options: SourceOptions, scope: { start: string; end: string }): SourceScan {
  const data = raw as { permission?: string; missingCalendar?: boolean; complete?: boolean; events?: Record<string, unknown>[] };
  if (data?.permission !== 'granted') throw new CalendarPermissionError();
  if (data.missingCalendar) throw new Error(moteText("所选日历已不可用；已暂停删除判断，请重新选择"));
  if (!Array.isArray(data.events) || data.events.length > 2000 || typeof data.complete !== 'boolean') throw new Error(moteText("日历数据格式无效"));
  const result: SourceScan = { items: [], seen: [], complete: data.complete, skipped: 0, scope };
  const iso = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value));
  for (const event of data.events) {
    if (typeof event.id !== 'string' || event.id.length > 3000 || typeof event.title !== 'string' || event.title.length > 4000 || typeof event.text !== 'string' || event.text.length > 200000 || !iso(event.start) || !iso(event.end) || event.end < event.start || typeof event.allDay !== 'boolean' || !['confirmed', 'tentative', 'cancelled'].includes(String(event.status)) || (event.modifiedAt !== undefined && !iso(event.modifiedAt)) || (event.createdAt !== undefined && !iso(event.createdAt)) || (event.timeZone !== undefined && (typeof event.timeZone !== 'string' || event.timeZone.length > 100))) throw new Error(moteText("日历条目格式无效，未将此扫描用于删除判断"));
    const externalId = 'calendar:' + sourceHash(event.id); result.seen.push(externalId);
    result.items.push({ externalId, title: redactSourceText(event.title, options.redactLiterals).slice(0, 2000), text: options.retention === 'reference' ? '' : redactSourceText(event.text, options.redactLiterals).slice(0, 100000), kind: 'calendar', layer: options.retention, metadata: { version: 1, provider: { ...(event.createdAt ? { createdAt: event.createdAt as string } : {}), ...(event.modifiedAt ? { updatedAt: event.modifiedAt as string } : {}) } }, modifiedAt: event.modifiedAt as string | undefined, calendar: { start: event.start, end: event.end, allDay: event.allDay, timeZone: event.timeZone as string | undefined, status: event.status as 'confirmed' | 'tentative' | 'cancelled' }, deleted: false });
  }
  return result;
}
