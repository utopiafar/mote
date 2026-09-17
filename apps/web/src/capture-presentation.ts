import { moteText } from '@mote/shared/i18n';
import type {CapturePreview} from '@mote/shared';
import type {Capture} from './api';

/** Imported originals and device-synced files use separate archive APIs. */
export function evidencePresentation(capture: Pick<Capture, 'id' | 'source' | 'platform' | 'provenance' | 'fileEvidence'>) {
  const imported = capture.platform === 'import' || Boolean(capture.provenance?.document);
  const nativeFile = capture.fileEvidence
    ? {captureId: capture.fileEvidence.captureId, startMs: capture.fileEvidence.startMs}
    : capture.source === 'file' && !imported ? {captureId: capture.id} : undefined;
  const textLabel = capture.fileEvidence ? moteText("转写片段")
    : capture.source === 'media' ? moteText("媒体观察")
    : capture.source === 'activity' ? moteText("应用活动")
    : capture.source === 'note' ? moteText("用户原文")
    : capture.source === 'screen' ? moteText("OCR 全文")
    : imported ? moteText("原始文本")
    : nativeFile ? moteText("文件元信息") : moteText("捕获文本");
  const deleteDescription = nativeFile
    ? moteText("删除中央文件归档及其派生内容和依赖记忆，并清除已有洞察；来源设备上的原文件保留。")
    : moteText("删除这条原始记录及不再被引用的影像，并清除依赖记忆和已有洞察。") + (capture.provenance?.document?.fileId ? moteText("导入仍保留原始文件与解析资料；如需一并删除，请到导入页删除整次导入。") : '');
  return {nativeFile, textLabel, deleteDescription};
}

export function ocrPresentation(state: CapturePreview['ocr'], text: string, duplicate = false) {
  if (duplicate) return {label: moteText("图片去重 · 仅元数据"), description: moteText("画面命中所选去重档位，只保留时间、应用和采样元数据，未保存图片或 OCR 文本。"), tone: 'muted'};
  switch (state.status) {
    case 'pending': return state.reason === 'charging'
      ? {label: moteText("OCR 待充电"), description: moteText("截图已保存，采集端接入电源后会自动补做文字识别，再同步识别结果。"), tone: 'amber'}
      : {label: moteText("OCR 待处理"), description: moteText("截图已保存，正在等待采集端处理并同步文字识别结果。"), tone: 'amber'};
    case 'completed': return text.trim()
      ? {label: moteText("OCR 已完成"), description: moteText("采集端已完成文字识别，下方显示这条记录保留的全文。"), tone: 'green'}
      : {label: moteText("OCR 未识别到文字"), description: moteText("文字识别已完成，但没有识别到文字。截图仍可查看。"), tone: 'muted'};
    case 'failed': return {label: moteText("OCR 失败"), description: moteText("采集端报告文字识别失败，截图已保留。"), tone: 'amber'};
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
