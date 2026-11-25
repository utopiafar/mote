import type {UsageActivity, UsageCaptureKind, UsageFailureKind, UsageRetryResult, UsageToolResult, UsageTurnResult} from '@mote/shared';
import {getLocale, moteText} from '@mote/shared/i18n';

export const statisticNumber = (value:number) => value.toLocaleString(getLocale());
export function statisticDay(day:string, options:Intl.DateTimeFormatOptions={month:'short',day:'numeric'}) {
  return new Intl.DateTimeFormat(getLocale(),{...options,timeZone:'UTC'}).format(new Date(`${day}T00:00:00Z`));
}
export function captureLabel(kind:UsageCaptureKind) {
  return {projection:moteText('投屏截图'),screen:moteText('其他截图'),unknownScreen:moteText('采集方式未记录'),
    page:moteText('页面记录'),system:moteText('系统事件'),other:moteText('其他记录')}[kind];
}
export function toolLabel(name:string) {
  const labels:Record<string,string>={search_context:moteText('搜索资料'),timeline:moteText('时间线'),
    evidence:moteText('读取原文'),read_image:moteText('读取图片'),unknown_tool:moteText('未知工具')};
  return labels[name]??name;
}
export function failureLabel(kind:UsageFailureKind) {
  return {tool:moteText('工具失败'),turn:moteText('对话失败'),processing:moteText('图片处理失败')}[kind];
}
export function activityLabel(activity:UsageActivity) {
  if(activity.kind==='capture')return captureLabel(activity.captureKind);
  return activity.kind==='tool'?toolLabel(activity.name):moteText('对话轮次');
}
export function resultLabel(state:UsageToolResult|UsageTurnResult) {
  return {completed:moteText('已完成'),failed:moteText('失败'),unknown:moteText('未记录'),cancelled:moteText('已取消'),
    accepted:moteText('已接收'),queued:moteText('排队中'),running:moteText('运行中')}[state]??moteText('未记录');
}
export function retryLabel(state:UsageRetryResult) {
  return {unrecorded:moteText('未记录'),waiting:moteText('待重试'),running:moteText('运行中'),
    completed:moteText('重试成功'),failed:moteText('重试失败'),cancelled:moteText('已取消')}[state];
}
