import {moteText} from '@mote/shared/i18n';
import type {Status} from './contracts';

export function renderStorageLocation(root:Document,status:Status|undefined,draftDirectory:string):void{
  const id=(name:string)=>root.getElementById(name)!;
  const recovery=status?.storage?.recoveryRequired;
  const selected=draftDirectory||status?.storage?.defaultDirectory||'';
  id('storage-location-name').textContent=recovery?moteText('暂时无法确认当前目录'):draftDirectory?selected.split(/[\\/]/).filter(Boolean).at(-1)||selected:moteText('默认位置（当前环境目录）');
  id('storage-location-count').textContent=moteText('待同步 {0} 条',status?.queueDepth??0);
  id('storage-restart').hidden=!recovery;
  (id('capture-directory') as HTMLInputElement).value=selected||moteText('默认位置（当前环境目录）');
  id('capture-directory-state').textContent=recovery|| (status?.storage?.cleanupPending?moteText('新目录已生效；旧副本尚未清理，请连接原磁盘后重新打开 Mote。'):draftDirectory!==(status?.config.captureStorageDirectory||'')?moteText('保存设置后迁移本机已有记录，过程中会自动暂停并恢复。'):moteText('这里保存本机待同步的截图。完整内容识别与已归档图片保存在中央。'));
}
