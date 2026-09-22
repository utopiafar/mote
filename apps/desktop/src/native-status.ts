import {nativeStatusView,type NativeStatusFacts,type NativeStatusView} from '@mote/shared/native-status';
import {moteText} from '@mote/shared/i18n';
import type {SyncStatus} from './contracts';
export function collectorStatusView(sync:SyncStatus,blocked=0,inventoryAvailable=true):NativeStatusView{
  return nativeStatusView({pending:inventoryAvailable?sync.pendingRecords:null,lastAcknowledgedAt:sync.lastUploadAt,
    syncState:!inventoryAvailable?'blocked':blocked?'blocked':sync.state==='manual'?'waiting':sync.state,
    errorCode:!inventoryAvailable?'local_state_unavailable':blocked?'retained_conflict':null,retryAt:sync.nextUploadAt});
}
export function nativeStatusSummary(view:NativeStatusView):string{
  const archive={acknowledged:moteText('当前待发已获中央确认'),partial:moteText('部分资料已确认，仍有本机待发'),local:moteText('资料保存在本机，等待中央确认'),unknown:moteText('资料确认状态待查询')}[view.archive.state];
  return `${archive} · ${moteText('中央处理状态待查询，请在中央任务中心查看')}`;
}
export {nativeStatusView};
export type {NativeStatusFacts};
