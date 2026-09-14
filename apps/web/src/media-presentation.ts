import type {MediaMetadata, MediaSession} from '@mote/shared';
import {duration} from './api';

/** Short media samples retain seconds so their displayed totals remain useful. */
export function mediaDuration(ms:number) {
  const seconds=Math.max(0,Math.round(ms/1000));
  if(seconds<60||seconds>=3600)return duration(ms);
  return `${Math.floor(seconds/60)} 分钟${seconds%60?` ${seconds%60} 秒`:''}`;
}

export const playbackLabels: Record<MediaSession['playbackState'], string> = {
  playing:'正在播放', paused:'已暂停', stopped:'已停止', buffering:'正在缓冲', connecting:'正在连接',
  seeking:'正在定位', skipping:'正在切换', error:'播放出错', none:'无播放状态', unknown:'播放状态未知',
};
export const visibilityLabels: Record<MediaSession['appVisibility'], string> = {foreground:'前台应用',background:'后台应用',unknown:'前后台未知'};
export const playbackTypeLabels: Record<MediaSession['playbackType'], string> = {local:'本机播放',remote:'远程播放',unknown:'播放位置未知'};
export function mediaStatus(media?: MediaMetadata) {
  if (!media) return {label:'媒体状态未上报',description:'此设备或记录没有上报媒体状态，无法判断当时是否有音频播放。',tone:'muted'};
  if (media.status === 'disabled') return {label:'媒体采集已关闭',description:'当时没有启用媒体采集，无法判断是否有音频播放。',tone:'muted'};
  if (media.status === 'permission_required') return {label:'媒体采集等待授权',description:'请在 Android 客户端开启媒体采集，并在系统设置授权通知使用权，以读取应用公开的媒体会话。',tone:'amber'};
  if (media.status === 'unavailable') return {label:'媒体状态不可用',description:'系统当时未能提供媒体状态，不能据此认定没有音频播放。',tone:'amber'};
  if (!media.sessions.length) return {label:'未观察到媒体会话',description:'这次观察没有发现可见的媒体会话；未公开媒体会话的应用可能无法被记录。',tone:'muted'};
  const playing=media.sessions.filter(session=>session.playbackState==='playing').length;
  return {label:playing ? `正在播放${playing>1?` · ${playing} 个会话`:''}` : `${media.sessions.length} 个媒体会话`,description:'应用通过系统公开的媒体状态；播放状态不代表你实际收听或专注。',tone:playing?'green':'muted'};
}
export function mediaCardText(media?:MediaMetadata, collection?:string) {
  const status=mediaStatus(media);
  const session=media?.sessions.find(value=>value.playbackState==='playing')??media?.sessions[0];
  if (!session) return status.label;
  const title=collection==='activity' ? undefined : session.title;
  return [title || playbackLabels[session.playbackState], visibilityLabels[session.appVisibility], playbackTypeLabels[session.playbackType]].join(' · ');
}
export const mediaExplanation='应用通过系统公开的媒体状态，不包含音频录制或语音转写。播放时长只累计已观察到的播放区间；暂停、未授权和采样空隙不会补齐，也不能据此确定你实际收听。';
