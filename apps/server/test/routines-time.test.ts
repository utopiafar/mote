import test from 'node:test';
import assert from 'node:assert/strict';
import {nextRoutineOccurrence,routineScheduleSchema,type RoutineSchedule} from '../src/routines-time.js';

test('routine schedules persist the IANA zone, local wall clock and revision',()=>{
 const daily:RoutineSchedule={revision:1,timeZone:'Asia/Shanghai',trigger:{kind:'daily',localTime:'09:00'}};
 const weekly:RoutineSchedule={revision:7,timeZone:'America/New_York',trigger:{kind:'weekly',weekday:5,localTime:'17:00'}};
 const before:RoutineSchedule={revision:2,timeZone:'Europe/Berlin',trigger:{kind:'before-event',leadMinutes:30}};
 for(const rule of [daily,weekly,before])assert.deepEqual(routineScheduleSchema.parse(JSON.parse(JSON.stringify(rule))),rule);
 for(const timeZone of ['+08:00','-05:00','08:00','local'])assert.equal(routineScheduleSchema.safeParse({...daily,timeZone}).success,false,'offset or unknown zone must be rejected');
 assert.equal(routineScheduleSchema.safeParse({...daily,timeZone:'UTC'}).success,true);
 for(const trigger of [
  {kind:'daily',localTime:'24:00'},
  {kind:'weekly',weekday:0,localTime:'09:00'},
  {kind:'daily',localTime:'09:00',timeZone:'Asia/Shanghai'},
  {kind:'cron',expression:'* * * * *'},
 ])assert.equal(routineScheduleSchema.safeParse({...daily,trigger}).success,false);
 assert.equal(routineScheduleSchema.safeParse({...daily,revision:0}).success,false);
});

test('daily rules cross midnight and every next due strictly advances',()=>{
 const rule:RoutineSchedule={revision:1,timeZone:'Asia/Shanghai',trigger:{kind:'daily',localTime:'00:30'}};
 const first=nextRoutineOccurrence(rule,'2026-01-01T23:45:00+08:00')!;
 assert.equal(first.scheduledAt,'2026-01-01T16:30:00.000Z');
 assert.equal(first.localDate,'2026-01-02');
 assert.equal(first.localTime,'00:30');
 assert.equal(first.timeZone,'Asia/Shanghai');
 assert.equal(first.revision,1);
 const next=nextRoutineOccurrence(rule,first.scheduledAt)!;
 assert.equal(next.scheduledAt,'2026-01-02T16:30:00.000Z');
 assert.equal(next.localDate,'2026-01-03');
 assert.ok(Date.parse(next.scheduledAt)>Date.parse(first.scheduledAt));
 // A stored past due is advanced once, never replayed as the same instant.
 assert.notEqual(nextRoutineOccurrence(rule,first.scheduledAt)!.scheduledAt,first.scheduledAt);
 assert.throws(()=>nextRoutineOccurrence(rule,'2026-01-01T23:45:00'),/absolute instant/);
});

test('weekly rules cross the week boundary using ISO weekdays',()=>{
 const monday:RoutineSchedule={revision:2,timeZone:'Asia/Shanghai',trigger:{kind:'weekly',weekday:1,localTime:'09:00'}};
 const fromSunday=nextRoutineOccurrence(monday,'2026-01-04T23:00:00+08:00')!;
 assert.equal(fromSunday.localDate,'2026-01-05');
 assert.equal(fromSunday.scheduledAt,'2026-01-05T01:00:00.000Z');
 const afterMonday=nextRoutineOccurrence(monday,'2026-01-05T10:00:00+08:00')!;
 assert.equal(afterMonday.localDate,'2026-01-12');
 assert.equal(afterMonday.scheduledAt,'2026-01-12T01:00:00.000Z');
 const friday:RoutineSchedule={...monday,trigger:{kind:'weekly',weekday:5,localTime:'17:00'}};
 assert.equal(nextRoutineOccurrence(friday,'2026-01-01T23:00:00+08:00')!.localDate,'2026-01-02');
});

test('DST gaps move to the first valid moment after the gap instead of adding its length',()=>{
 const newYork:RoutineSchedule={revision:1,timeZone:'America/New_York',trigger:{kind:'daily',localTime:'02:30'}};
 const gap=nextRoutineOccurrence(newYork,'2026-03-08T00:00:00-05:00')!;
 assert.equal(gap.scheduledAt,'2026-03-08T07:00:00.000Z');
 assert.equal(gap.localDate,'2026-03-08');
 assert.equal(gap.localTime,'03:00');
 const next=nextRoutineOccurrence(newYork,gap.scheduledAt)!;
 assert.equal(next.scheduledAt,'2026-03-09T06:30:00.000Z');
 assert.equal(next.localTime,'02:30');
 // The gap start itself also resolves to the gap end, not to a much older transition.
 const atGapStart:RoutineSchedule={...newYork,trigger:{kind:'daily',localTime:'02:00'}};
 assert.equal(nextRoutineOccurrence(atGapStart,'2026-03-08T00:00:00-05:00')!.scheduledAt,'2026-03-08T07:00:00.000Z');
 const lordHowe:RoutineSchedule={revision:1,timeZone:'Australia/Lord_Howe',trigger:{kind:'daily',localTime:'02:15'}};
 const halfHourGap=nextRoutineOccurrence(lordHowe,'2026-10-04T00:00:00+10:30')!;
 assert.equal(halfHourGap.scheduledAt,'2026-10-03T15:30:00.000Z');
 assert.equal(halfHourGap.localTime,'02:30');
 // A weekly occurrence on the gap day resolves the same way.
 const weeklySunday:RoutineSchedule={...newYork,trigger:{kind:'weekly',weekday:7,localTime:'02:30'}};
 const weeklyGap=nextRoutineOccurrence(weeklySunday,'2026-03-01T03:00:00-05:00')!;
 assert.equal(weeklyGap.scheduledAt,'2026-03-08T07:00:00.000Z');
 assert.equal(weeklyGap.localDate,'2026-03-08');
});

test('DST repeated wall clocks take one first occurrence',()=>{
 const rule:RoutineSchedule={revision:1,timeZone:'America/New_York',trigger:{kind:'daily',localTime:'01:30'}};
 const first=nextRoutineOccurrence(rule,'2026-11-01T00:00:00-04:00')!;
 assert.equal(first.scheduledAt,'2026-11-01T05:30:00.000Z');
 const afterFirst=nextRoutineOccurrence(rule,first.scheduledAt)!;
 assert.equal(afterFirst.scheduledAt,'2026-11-02T06:30:00.000Z');
 assert.equal(afterFirst.localDate,'2026-11-02');
 // A clock between the two 01:30s still must not produce the second one.
 const between=nextRoutineOccurrence(rule,'2026-11-01T01:00:00-05:00')!;
 assert.equal(between.scheduledAt,'2026-11-02T06:30:00.000Z');
 // The transition day has exactly one 01:30 occurrence.
 const transitionDay=nextRoutineOccurrence(rule,'2026-10-31T01:30:00-04:00')!;
 assert.equal(transitionDay.scheduledAt,'2026-11-01T05:30:00.000Z');
});

test('changing the stored IANA zone re-resolves the same local wall clock',()=>{
 const after='2026-05-31T20:00:00Z';
 const pacific:RoutineSchedule={revision:1,timeZone:'America/Los_Angeles',trigger:{kind:'daily',localTime:'09:00'}};
 const japan:RoutineSchedule={...pacific,revision:2,timeZone:'Asia/Tokyo'};
 const inPacific=nextRoutineOccurrence(pacific,after)!;
 const inJapan=nextRoutineOccurrence(japan,after)!;
 assert.equal(inPacific.scheduledAt,'2026-06-01T16:00:00.000Z');
 assert.equal(inJapan.scheduledAt,'2026-06-01T00:00:00.000Z');
 assert.notEqual(inPacific.scheduledAt,inJapan.scheduledAt);
 assert.equal(inJapan.localTime,'09:00');
 assert.equal(inJapan.revision,2);
});

test('pause and resume returns one next future occurrence without replaying missed periods',()=>{
 const rule:RoutineSchedule={revision:3,timeZone:'Asia/Shanghai',trigger:{kind:'daily',localTime:'09:00'}};
 const pausedThrough='2026-01-06T10:00:00+08:00';
 const resumed=nextRoutineOccurrence(rule,pausedThrough)!;
 assert.equal(resumed.scheduledAt,'2026-01-07T01:00:00.000Z');
 assert.equal(resumed.localDate,'2026-01-07');
 assert.ok(Date.parse(resumed.scheduledAt)>Date.parse(pausedThrough));
});

test('before-event rules use the current calendar version and one preparation window',()=>{
 const rule:RoutineSchedule={revision:4,timeZone:'Asia/Shanghai',trigger:{kind:'before-event',leadMinutes:30}};
 const event={revision:'event-7',calendar:{start:'2026-01-05T09:00:00+08:00',end:'2026-01-05T10:00:00+08:00',allDay:false,timeZone:'Asia/Shanghai',status:'confirmed'}};
 const due=nextRoutineOccurrence(rule,'2026-01-05T08:00:00+08:00',event)!;
 assert.equal(due.scheduledAt,'2026-01-05T00:30:00.000Z');
 assert.equal(due.localDate,'2026-01-05');
 assert.equal(due.localTime,'08:30');
 assert.equal(due.eventRevision,'event-7');
 assert.equal(nextRoutineOccurrence(rule,'2026-01-05T08:30:00+08:00',event),null);
 const moved=nextRoutineOccurrence(rule,'2026-01-05T08:00:00+08:00',{...event,revision:'event-8',calendar:{...event.calendar,start:'2026-01-05T09:30:00+08:00',end:'2026-01-05T10:30:00+08:00'}})!;
 assert.equal(moved.scheduledAt,'2026-01-05T01:00:00.000Z');
 assert.equal(moved.eventRevision,'event-8');
 assert.equal(nextRoutineOccurrence(rule,'2026-01-05T08:00:00+08:00',{...event,calendar:{...event.calendar,status:'cancelled'}}),null);
 assert.throws(()=>nextRoutineOccurrence(rule,'2026-01-05T08:00:00+08:00'),/current calendar event/);
});
