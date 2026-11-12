import {calendarSchema} from '@mote/shared';
import {Temporal} from '@js-temporal/polyfill';
import {z} from 'zod';

/** A routine stores its wall clock and IANA zone, never a fixed UTC offset.
 * Intl also accepts offset strings such as "+08:00", so the leading-letter
 * guard rejects those before resolution. */
const isIanaTimeZone=(value:string)=>{
 if(!/^[A-Za-z]/.test(value))return false;
 try{new Intl.DateTimeFormat('en',{timeZone:value});return true;}catch{return false;}
};
export const routineTimeZoneSchema=z.string().min(1).max(100).refine(isIanaTimeZone,{message:'Use an IANA time zone, not a UTC offset'});
/** 24-hour wall clock with minute precision. */
export const routineLocalTimeSchema=z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/,'Use a 24-hour HH:mm local time');

/** Only the finite trigger kinds this release needs. Weekday is ISO-8601
 * (1=Monday .. 7=Sunday). No cron expression or interval DSL. */
export const routineTriggerSchema=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('daily'),localTime:routineLocalTimeSchema}).strict(),
 z.object({kind:z.literal('weekly'),weekday:z.number().int().min(1).max(7),localTime:routineLocalTimeSchema}).strict(),
 z.object({kind:z.literal('before-event'),leadMinutes:z.number().int().min(1).max(525600)}).strict(),
]);
export type RoutineTrigger=z.infer<typeof routineTriggerSchema>;

/** The persisted rule shape. The local wall clock and IANA zone stay intact
 * so a later revision resolves under the zone rules in force at that time. */
export const routineScheduleSchema=z.object({
 revision:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
 timeZone:routineTimeZoneSchema,
 trigger:routineTriggerSchema,
}).strict();
export type RoutineSchedule=z.infer<typeof routineScheduleSchema>;

/** A before-event occurrence is pinned to the current calendar source version.
 * The caller must supply the current revision; cached event data is not an
 * occurrence. */
export const routineCalendarEventSchema=z.object({
 revision:z.string().min(1).max(200),
 calendar:calendarSchema,
}).strict();
export type RoutineCalendarEvent=z.infer<typeof routineCalendarEventSchema>;

export interface RoutineOccurrence {
 /** Absolute instant. Two consecutive occurrences always satisfy
  * scheduledAt(next) > scheduledAt(previous). */
 scheduledAt:string;
 /** Effective wall clock after DST resolution, in the rule's IANA zone. */
 localDate:string;
 localTime:string;
 timeZone:string;
 revision:number;
 /** Present for a before-event occurrence so a stale event revision cannot
  * publish under the current event. */
 eventRevision?:string;
}

const absoluteEpochMs=(value:Date|string)=>{
 if(typeof value==='string'){
  if(!/(?:Z|[+-]\d{2}:\d{2})$/i.test(value))throw new Error('A routine clock must be an absolute instant with an offset');
  const parsed=Date.parse(value);
  if(!Number.isFinite(parsed))throw new Error('A valid absolute instant is required');
  return parsed;
 }
 const parsed=value.getTime();
 if(!Number.isFinite(parsed))throw new Error('A valid absolute instant is required');
 return parsed;
};

const wallTime=(value:Temporal.ZonedDateTime)=>{
 const time=`${String(value.hour).padStart(2,'0')}:${String(value.minute).padStart(2,'0')}`;
 return value.second===0&&value.millisecond===0?time:`${time}:${String(value.second).padStart(2,'0')}`;
};

const occurrence=(schedule:RoutineSchedule,value:Temporal.ZonedDateTime,eventRevision?:string):RoutineOccurrence=>({
 scheduledAt:new Date(value.epochMilliseconds).toISOString(),
 localDate:value.toPlainDate().toString(),
 localTime:wallTime(value),
 timeZone:schedule.timeZone,
 revision:schedule.revision,
 ...(eventRevision===undefined?{}:{eventRevision}),
});

/** Time zone gaps are skipped wall clocks, not a duration to add. The
 * "compatible" resolution shifts by the gap length (02:00-03:00 requested
 * 02:30 becomes 03:30); this resolves to the first valid instant after the
 * gap instead (03:00). An ambiguous wall clock takes its first occurrence. */
const resolveWallClock=(timeZone:string,date:Temporal.PlainDate,time:Temporal.PlainTime)=>{
 const fields={year:date.year,month:date.month,day:date.day,hour:time.hour,minute:time.minute,second:0,timeZone};
 const earlier=Temporal.ZonedDateTime.from(fields,{disambiguation:'earlier'});
 const later=Temporal.ZonedDateTime.from(fields,{disambiguation:'later'});
 if(earlier.epochNanoseconds===later.epochNanoseconds)return earlier;
 const requested=date.toPlainDateTime(time);
 if(earlier.toPlainDateTime().equals(requested)&&later.toPlainDateTime().equals(requested))return earlier;
 const gapEnd=earlier.getTimeZoneTransition('next');
 if(!gapEnd)throw new Error(`No valid instant follows the skipped local time in ${timeZone}`);
 return gapEnd;
};

/** Returns exactly one occurrence strictly after `after`. Missed periods are
 * not enumerated: pause/resume or a delayed caller passes its current clock and
 * gets the next future occurrence, so an old due time cannot retrigger itself.
 * A before-event rule returns null when its one preparation window has passed
 * or the current event is cancelled. */
export function nextRoutineOccurrence(schedule:RoutineSchedule,after:Date|string,event?:RoutineCalendarEvent):RoutineOccurrence|null {
 const rule=routineScheduleSchema.parse(schedule),afterMs=absoluteEpochMs(after);
 if(rule.trigger.kind==='before-event'){
  if(!event)throw new Error('A before-event routine requires its current calendar event');
  const current=routineCalendarEventSchema.parse(event);
  if(current.calendar.status==='cancelled')return null;
  const dueMs=Temporal.Instant.from(current.calendar.start).epochMilliseconds-rule.trigger.leadMinutes*60000;
  if(dueMs<=afterMs)return null;
  return occurrence(rule,Temporal.Instant.fromEpochMilliseconds(dueMs).toZonedDateTimeISO(rule.timeZone),current.revision);
 }
 const zonedAfter=Temporal.Instant.fromEpochMilliseconds(afterMs).toZonedDateTimeISO(rule.timeZone);
 const time=Temporal.PlainTime.from(rule.trigger.localTime);
 let date=zonedAfter.toPlainDate();
 // One weekly cycle plus a skipped local day is enough; the bound prevents a
 // malformed zone or clock from becoming an unbounded catch-up loop.
 for(let offset=0;offset<15;offset++){
  if(rule.trigger.kind==='daily'||date.dayOfWeek===rule.trigger.weekday){
   const resolved=resolveWallClock(rule.timeZone,date,time);
   if(resolved.epochMilliseconds>afterMs)return occurrence(rule,resolved);
  }
  date=date.add({days:1});
 }
 throw new Error('No future routine occurrence could be resolved');
}
