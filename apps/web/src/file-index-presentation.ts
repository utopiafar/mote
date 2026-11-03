import { moteText } from '@mote/shared/i18n';

/** Coverage describes the processed span only; it never proves retained body text or read permission. */
export type FileIndexCoverage = 'full' | 'lightweight' | 'none' | 'excerpt' | undefined;

export function fileIndexCoverageLabel(coverage: FileIndexCoverage): string {
  return coverage === 'full' ? moteText('索引处理完成') : coverage === 'lightweight' ? moteText('部分索引就绪') : moteText('已登记目录');
}

/** Only an explicit read policy grants the retained-body note; an empty metadata DTO proves nothing. */
export function fileIndexReadNote(allowRead: boolean | undefined): string | null {
  return allowRead ? ' · ' + moteText('允许中央保留提取出的完整正文，设备离线仍可查阅') : null;
}
