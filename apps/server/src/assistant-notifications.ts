import {Temporal} from '@js-temporal/polyfill';
import type {QueryScope} from '@mote/shared';
import type {AssistantCards} from './assistant-cards.js';
import {notificationSettingsSchema,type NotificationSettings} from './notification-configuration.js';
import {resolveRoutineWallClock} from './routines-time.js';

type Card=ReturnType<AssistantCards['page']>['items'][number];
const MAX_AGE_MS=24*60*60*1000;

/** Use the same gap/overlap resolution as routine occurrences. A quiet window
 * belongs to its start date; checking yesterday handles a window at midnight. */
function quietEnd(at:number,settings:NotificationSettings):number|undefined {
 const hours=settings.quietHours;if(!hours)return undefined;
 const local=Temporal.Instant.fromEpochMilliseconds(at).toZonedDateTimeISO(settings.timeZone).toPlainDate();
 const startTime=Temporal.PlainTime.from(hours.start),endTime=Temporal.PlainTime.from(hours.end);
 for(const date of [local.subtract({days:1}),local]){
  const endDate=hours.start<hours.end?date:date.add({days:1});
  const start=resolveRoutineWallClock(settings.timeZone,date,startTime).epochMilliseconds;
  const end=resolveRoutineWallClock(settings.timeZone,endDate,endTime).epochMilliseconds;
  if(at>=start&&at<end)return end;
 }
 return undefined;
}

/** A snapshot over the card store, not an inbox or a record of delivery. Card
 * identity, revision, evidence, feedback and read state remain in that store. */
export class AssistantNotifications {
 constructor(private readonly cards:AssistantCards,private readonly settings:()=>NotificationSettings,private readonly now=()=>Date.now()){}
 snapshot(scope:QueryScope){
  return this.cards.readSnapshot(()=>this.project(scope));
 }
 private project(scope:QueryScope){
  const settings=notificationSettingsSchema.parse(this.settings()),now=this.now();
  if(!settings.enabled||quietEnd(now,settings)!==undefined)return {items:[]};
  const candidates:{card:Card;at:number;proposedAt:number;blocked:boolean}[]=[];
  let cursor:string|undefined;
  do{
   const page=this.cards.page({scope,limit:100,cursor});
   for(const card of page.items){
    if(!card.reminderReason)continue;
    const timing=this.cards.notificationTiming(card.id,scope);
    if(!timing||!this.cards.notificationFeedbackVisible(card.id,scope))continue;
    const origin=Date.parse(timing.origin),laters=card.feedback.filter(value=>value.action==='later');
    const stop=card.feedback.filter(value=>value.action==='ignore'||value.action==='never_remind');
    const episodes=[{at:origin,next:laters[0]?.createdAt,active:laters.length===0},...laters.flatMap((later,index)=>later.until?[{
     at:Math.max(origin,Date.parse(later.createdAt),Date.parse(later.until)),next:laters[index+1]?.createdAt,active:index===laters.length-1,
    }]:[])];
    for(const episode of episodes){
     const ready=quietEnd(episode.at,settings)??episode.at;
     // A decision made before a future due time prevents that occurrence;
     // a decision made after it retains the reservation for rate limiting.
     if(ready>now||episode.next&&ready>Date.parse(episode.next)||card.readAt&&Date.parse(card.readAt)<ready||
      stop.some(value=>Date.parse(value.createdAt)<ready)||card.state==='resolved'&&Date.parse(timing.currentVersionAt)<ready)continue;
     candidates.push({card,at:ready,proposedAt:episode.at,blocked:!episode.active||card.state!=='open'||card.readAt!==null||stop.length>0});
    }
   }
   cursor=page.nextCursor??undefined;
  }while(cursor);
  // Equal due times (e.g. a quiet window ending) coalesce to the most recent
  // proposal. Reservations come from current cards, including read/resolved ones;
  // polling never writes a delivery record or consumes an unread item.
  candidates.sort((a,b)=>a.at-b.at||Number(a.blocked)-Number(b.blocked)||b.proposedAt-a.proposedAt||a.card.id.localeCompare(b.card.id));
  const interval=settings.minIntervalMinutes*60_000;
  let latest:typeof candidates[number]|undefined;
  for(const candidate of candidates)if(!latest||candidate.at-latest.at>=interval)latest=candidate;
  if(!latest||latest.blocked)return {items:[]};
  // One slot cannot outlive the next slot. This prevents an older alert from
  // resurfacing after a newer one was read or withdrawn while offline.
  const expires=latest.at+Math.min(interval,MAX_AGE_MS);
  if(now>=expires)return {items:[]};
  return {items:[{id:latest.card.id,revision:latest.card.revision,title:latest.card.title,reason:latest.card.reminderReason!,
   eligibleAt:new Date(latest.at).toISOString(),expiresAt:new Date(expires).toISOString()}]};
 }
}
