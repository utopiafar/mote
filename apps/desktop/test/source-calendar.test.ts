import { describe, expect, it } from 'vitest';
import { CalendarPermissionError, decodeCalendarChoices, decodeCalendarScan } from '../src/source-calendar';
import { DEFAULT_SOURCE_OPTIONS } from '../src/source-types';
const scope = { start: '2026-09-01T00:00:00Z', end: '2026-12-01T00:00:00Z' };
const event = { id: 'synthetic-recurring-occurrence:2026-09-14', title: '日程 🗓️', text: '只用合成数据\nsynthetic-secret', start: '2026-09-14T01:00:00Z', end: '2026-09-14T02:00:00Z', allDay: false, status: 'confirmed', timeZone: 'Asia/Shanghai' };
describe('EventKit adapter fixtures (no calendar reads or permission requests)', () => {
  it('validates the permission result and prevents denied/missing calendars being treated as empty scans', () => {
    expect(() => decodeCalendarChoices({ permission: 'required' })).toThrow(CalendarPermissionError);
    expect(() => decodeCalendarScan({ permission: 'required' }, DEFAULT_SOURCE_OPTIONS, scope)).toThrow(CalendarPermissionError);
    expect(() => decodeCalendarScan({ permission: 'granted', missingCalendar: true }, DEFAULT_SOURCE_OPTIONS, scope)).toThrow('不可用');
  });
  it('preserves independent calendar start/end metadata and masks explicit literals', () => {
    const result = decodeCalendarScan({ permission: 'granted', complete: true, events: [event] }, { ...DEFAULT_SOURCE_OPTIONS, redactLiterals: ['synthetic-secret'] }, scope);
    expect(result.items[0].calendar?.start).toBe(event.start); expect(result.items[0].text).toBe('只用合成数据\n[已遮盖]'); expect(result.scope).toEqual(scope);
    expect(result.items[0].externalId).not.toContain(event.id);
  });
  it('reference suppresses notes and rejects invalid event ranges without deletion classification', () => {
    expect(decodeCalendarScan({ permission: 'granted', complete: true, events: [event] }, { ...DEFAULT_SOURCE_OPTIONS, retention: 'reference' }, scope).items[0].text).toBe('');
    expect(() => decodeCalendarScan({ permission: 'granted', complete: true, events: [{ ...event, end: '2026-09-13T01:00:00Z' }] }, DEFAULT_SOURCE_OPTIONS, scope)).toThrow('无效');
  });
});
