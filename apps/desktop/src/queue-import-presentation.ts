import {moteText} from '@mote/shared/i18n';
import type {DesktopApi} from './contracts';
type QueueImportResult=Awaited<ReturnType<DesktopApi['importQueue']>>;
/** Completed is a confirmed lower bound when the current write could not be acknowledged. */
export function queueImportPresentation(result:QueueImportResult):{phase:'canceled'|'complete'|'error';message:string}{
  if(result.canceled)return {phase:'canceled',message:moteText('已取消')};
  if(result.state==='imported')return {phase:'complete',message:moteText('已导入 {0} 条待上传记录，重复记录自动跳过。',result.imported)};
  if(result.phase==='validation')return {phase:'error',message:moteText('备份未导入')};
  if(result.phase==='cleanup')return {phase:'error',message:moteText('{0} 条记录已保存在本机，临时文件清理未完成。',result.imported)};
  return {phase:'error',message:result.imported>0?moteText('导入尚未完成；已确认保存 {0} 条，其余记录状态待核实。',result.imported):moteText('导入尚未完成，当前写入结果待核实。检查本机内容。')};
}
