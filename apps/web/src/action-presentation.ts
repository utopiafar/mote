import {commonFailureMessage,httpStatusMessage} from '@mote/shared';
import {ApiError,errorMessage} from './api';
import type {ActionProposal,CalendarDraft} from '@mote/shared';
import {moteText,getLocale} from '@mote/shared/i18n';
export function calendarNeedsTime(item:ActionProposal){return item.kind!=='message.send'&&item.status==='proposed'&&!item.resolution&&(!item.event.start||!item.event.end||!item.event.timeZone);}
export function calendarNeedsAttention(item:ActionProposal){return calendarNeedsTime(item)||item.status==='uncertain'||item.status==='stale'||item.managed?.state==='cancel_requested'||item.status==='proposed';}
export function calendarStateLabel(item:ActionProposal){
 if(item.kind==='message.send')return ({proposed:moteText('待确认'),dismissed:moteText('已忽略'),approved:moteText('排队中'),executing:moteText('正在发送'),succeeded:moteText('已完成'),uncertain:moteText('结果需要核实'),stale:moteText('原文已变化')} as const)[item.status];
 if(item.resolution)return item.resolution==='completed'?moteText('已完成'):moteText('已取消');
 if(item.managed?.state==='cancel_requested')return moteText('已请求取消，写入结果仍待核实');
 if(item.managed?.state==='cancelled')return moteText('已取消等待执行');
 if(calendarNeedsTime(item))return moteText('时间待补充');
 return ({proposed:moteText('需要核对'),dismissed:moteText('已忽略'),approved:moteText('待设备同步'),executing:moteText('同步中'),succeeded:item.kind==='calendar.complete'?moteText('已完成'):item.kind==='calendar.cancel'?moteText('已取消'):moteText('已写入已有日历 · #Mote'),uncertain:moteText('结果需要核实'),stale:moteText('原文已变化')} as const)[item.status];
}
export function actionEventTime(event:CalendarDraft){if(!event.start||!event.end)return moteText('时间待补充');if(event.allDay)return event.start+' → '+event.end+' · '+moteText('全天');try{const format=new Intl.DateTimeFormat(getLocale(),{dateStyle:'medium',timeStyle:'short',timeZone:event.timeZone??'UTC'});return format.formatRange(new Date(event.start),new Date(event.end));}catch{return moteText('时间待补充');}}

/** Keep protocol diagnostics in HTTP/logs while the task UI explains recovery. */
export function actionFailure(error:unknown){return error instanceof ApiError?(error.code&&commonFailureMessage(error.code,error.status)||httpStatusMessage(error.status)):errorMessage(error);}
