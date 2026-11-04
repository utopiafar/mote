import {moteText} from '@mote/shared/i18n';
import type {NativeStatusView} from '@mote/shared/native-status';
export function nativeStatusSummary(view:NativeStatusView):string{
  const archive={acknowledged:moteText('当前待发已获中央确认'),partial:moteText('部分资料已确认，仍有本机待发'),local:moteText('资料保存在本机，等待中央确认'),unknown:moteText('资料确认状态待查询')}[view.archive.state];
  return `${archive} · ${moteText('中央处理状态待查询，请在中央任务中心查看')}`;
}
