import { moteText } from '@mote/shared/i18n';
import type {CapturePreview} from '@mote/shared';
import type {Capture} from './api';

/** Imported originals and device-synced files use separate archive APIs. */
export function evidencePresentation(capture: Pick<Capture, 'id' | 'source' | 'platform' | 'provenance' | 'fileEvidence' | 'fileArchive'>) {
  const imported = capture.platform === 'import' || Boolean(capture.provenance?.document);
  const nativeFile: {captureId:string;startMs?:number}|undefined = capture.fileEvidence
    ? {captureId: capture.fileEvidence.captureId, startMs: capture.fileEvidence.startMs}
    : capture.fileArchive;
  const textLabel = capture.fileEvidence ? moteText("转写片段")
    : capture.source === 'media' ? moteText("媒体观察")
    : capture.source === 'activity' ? moteText("应用活动")
    : capture.source === 'note' ? moteText("用户原文")
    : capture.source === 'screen' ? moteText("OCR 全文")
    : nativeFile ? moteText("文件元信息")
    : imported ? moteText("原始文本") : moteText("捕获文本");
  const deleteDescription = nativeFile
    ? moteText("删除中央文件归档及其派生内容和依赖记忆，并清除已有洞察；来源设备上的原文件保留。")
    : moteText("删除这条原始记录及不再被引用的影像，并清除依赖记忆和已有洞察。") + (capture.provenance?.document?.fileId ? moteText("导入仍保留原始文件与解析资料；如需一并删除，请到导入页删除整次导入。") : '');
  return {nativeFile, textLabel, deleteDescription};
}

export function ocrPresentation(state: CapturePreview['ocr'], text: string, duplicate = false, jobs?: Capture['perceptionJobs']) {
  if (duplicate) return {label: moteText("图片去重 · 仅元数据"), description: moteText("画面命中所选去重档位，只保留时间、应用和采样元数据，未保存图片或 OCR 文本。"), tone: 'muted'};
  const central=jobs?.find(job=>job.kind==='ocr');
  if(central&&state.status!=='completed'){
    if(state.status==='disabled')return central.state==='cancelled'
      ? {label:moteText("OCR 已取消"),description:moteText("中央文字识别已取消，截图已保留；当前没有正在处理的识别任务。"),tone:'muted'}
      : {label:moteText("OCR 未启用"),description:moteText("中央文字识别未启用，截图已保留；当前不会自动识别文字。"),tone:'muted'};
    if(central.state==='blocked')return {label:moteText("OCR 暂不可用"),description:central.error==='model_missing'||central.error==='not_installed'?moteText("中央文字识别模型尚未安装，截图已保留。"):moteText("中央文字识别被阻止，请检查中央感知配置与处理状态。截图已保留。"),tone:'amber'};
  }
  switch (state.status) {
    case 'pending': return state.reason === 'charging'
      ? {label: moteText("OCR 待充电"), description: moteText("截图已保存，采集端接入电源后会自动补做文字识别，再同步识别结果。"), tone: 'amber'}
      : {label: moteText("OCR 待处理"), description: moteText("截图已保存，文字识别任务正在排队或处理。"), tone: 'amber'};
    case 'completed': return text.trim()
      ? {label: moteText("OCR 已完成"), description: moteText("文字识别已完成，下方显示这条记录保留的全文。"), tone: 'green'}
      : {label: moteText("OCR 未识别到文字"), description: moteText("文字识别已完成，但没有识别到文字。截图仍可查看。"), tone: 'muted'};
    case 'failed': return {label: moteText("OCR 失败"), description: moteText("文字识别失败，截图已保留。"), tone: 'amber'};
    case 'disabled': return {label: moteText("OCR 已关闭"), description: moteText("采集这条记录时未启用文字识别，截图仍可查看。"), tone: 'muted'};
    case 'not_applicable': return {label: moteText("无需 OCR"), description: moteText("此类记录不使用屏幕文字识别。"), tone: 'muted'};
    default: return {label: moteText("OCR 状态未知"), description: moteText("这条早期记录未上报文字识别状态，无法判断是否已处理。"), tone: 'muted'};
  }
}

/** Local calendar boundaries must follow daylight saving changes rather than fixed 24-hour days. */
export function captureDateRange(after: string, before: string) {
  const end = before ? new Date(`${before}T00:00:00`) : undefined;
  if (end) end.setDate(end.getDate() + 1);
  return {
    ...(after ? {after: new Date(`${after}T00:00:00`).toISOString()} : {}),
    ...(end ? {before: end.toISOString()} : {}),
  };
}

export function localDateInput(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
