import type {CapturePreview} from '@mote/shared';

export function ocrPresentation(state: CapturePreview['ocr'], text: string, duplicate = false) {
  if (duplicate) return {label: '图片去重 · 仅元数据', description: '画面命中所选去重档位，只保留时间、应用和采样元数据，未保存图片或 OCR 文本。', tone: 'muted'};
  switch (state.status) {
    case 'pending': return state.reason === 'charging'
      ? {label: 'OCR 待充电', description: '截图已保存，采集端接入电源后会自动补做文字识别，再同步识别结果。', tone: 'amber'}
      : {label: 'OCR 待处理', description: '截图已保存，正在等待采集端处理并同步文字识别结果。', tone: 'amber'};
    case 'completed': return text.trim()
      ? {label: 'OCR 已完成', description: '采集端已完成文字识别，下方显示这条记录保留的全文。', tone: 'green'}
      : {label: 'OCR 未识别到文字', description: '文字识别已完成，但没有识别到文字。截图仍可查看。', tone: 'muted'};
    case 'failed': return {label: 'OCR 失败', description: '采集端报告文字识别失败，截图已保留。', tone: 'amber'};
    case 'disabled': return {label: 'OCR 已关闭', description: '采集这条记录时未启用文字识别，截图仍可查看。', tone: 'muted'};
    case 'not_applicable': return {label: '无需 OCR', description: '此类记录不使用屏幕文字识别。', tone: 'muted'};
    default: return {label: 'OCR 状态未知', description: '这条早期记录未上报文字识别状态，无法判断是否已处理。', tone: 'muted'};
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
