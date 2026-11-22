import {moteText} from '@mote/shared/i18n';
import type {MessageBoxOptions} from 'electron';
import type {Status} from './contracts';

/** The existing collector total includes both captured records and source outboxes. */
export function canSendFromTray(status:Pick<Status,'config'|'sync'>):boolean {
  return status.sync.pendingRecords>0&&!status.config.syncPaused&&status.sync.state!=='uploading';
}

/** Keep diagnostics available through an explicit native disclosure, never in the default error. */
export async function showTraySendFailure(error:unknown,show:(options:MessageBoxOptions)=>Promise<{response:number}>):Promise<void>{
  const result=await show({type:'error',title:moteText('立即发送'),message:moteText('发送待确认。查看同步状态再重试。'),buttons:[moteText('返回'),moteText('技术详情')],defaultId:0,cancelId:0,noLink:true});
  if(result.response===1)await show({type:'error',title:moteText('技术详情'),message:error instanceof Error?error.message:String(error),buttons:[moteText('返回')],defaultId:0,cancelId:0,noLink:true});
}
