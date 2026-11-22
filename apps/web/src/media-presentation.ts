import { moteText } from '@mote/shared/i18n';
import type {MediaMetadata, MediaSession} from '@mote/shared';
import {duration} from './api';

/** Short media samples retain seconds so their displayed totals remain useful. */
export function mediaDuration(ms:number) {
  const seconds=Math.max(0,Math.round(ms/1000));
  if(seconds<60||seconds>=3600)return duration(ms);
  return moteText("{0} 分钟{1}", Math.floor(seconds/60), seconds%60?moteText(" {0} 秒", seconds%60):'');
}

export const playbackLabels: Record<MediaSession['playbackState'], string> = {
  playing:moteText("正在播放"), paused:moteText("已暂停"), stopped:moteText("已停止"), buffering:moteText("正在缓冲"), connecting:moteText("正在连接"),
  seeking:moteText("正在定位"), skipping:moteText("正在切换"), error:moteText("播放出错"), none:moteText("无播放状态"), unknown:moteText("播放状态未知"),
};
export const visibilityLabels: Record<MediaSession['appVisibility'], string> = {foreground:moteText("前台应用"),background:moteText("后台应用"),unknown:moteText("前后台未知")};
export const playbackTypeLabels: Record<MediaSession['playbackType'], string> = {local:moteText("本机播放"),remote:moteText("远程播放"),unknown:moteText("播放位置未知")};
export function mediaStatus(media?: MediaMetadata) {
  if (!media) return {label:moteText("媒体状态未上报"),description:moteText("设备未上报媒体状态，播放情况未知。"),tone:'muted'};
  if (media.status === 'disabled') return {label:moteText("媒体采集已关闭"),description:moteText("当时没有启用媒体采集，无法判断是否有音频播放。"),tone:'muted'};
  if (media.status === 'permission_required') return {label:moteText("媒体采集等待授权"),description:moteText("在 Android 开启媒体采集和通知使用权。"),tone:'amber'};
  if (media.status === 'unavailable') return {label:moteText("媒体状态不可用"),description:moteText("系统当时未能提供媒体状态，不能据此认定没有音频播放。"),tone:'amber'};
  if (!media.sessions.length) return {label:moteText("未观察到媒体会话"),description:moteText("本次无可见的媒体会话。应用未公开的会话可能无法记录。"),tone:'muted'};
  const playing=media.sessions.filter(session=>session.playbackState==='playing').length;
  return {label:playing ? moteText("正在播放{0}", playing>1?moteText(" · {0} 个会话", playing):'') : moteText("{0} 个媒体会话", media.sessions.length),description:moteText("系统公开的媒体播放状态"),tone:playing?'green':'muted'};
}
export function mediaCardText(media?:MediaMetadata, collection?:string) {
  const status=mediaStatus(media);
  const session=media?.sessions.find(value=>value.playbackState==='playing')??media?.sessions[0];
  if (!session) return status.label;
  const title=collection==='activity' ? undefined : session.title;
  return [title || playbackLabels[session.playbackState], visibilityLabels[session.appVisibility], playbackTypeLabels[session.playbackType]].join(' · ');
}
export const mediaExplanation=moteText("仅记录系统公开的媒体状态，无音频或转写。只计可观察的播放区间，暂停、未授权和采样空隙留空。时长无法确认实际收听。");
