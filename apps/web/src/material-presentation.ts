import { moteText } from '@mote/shared/i18n';
/** Exact protocol fields only. Human-supplied titles and source names stay literal. */
const kinds: Record<string, string> = { 'mote.screen-segment': '屏幕片段', 'mote.ui-page-object': '页面资料', 'mote.capture-event': '采集事件', 'mote.state-series': '设备状态线索', 'mote.note': '随手记', 'mote.file': '文件与录音', 'mote.message': '消息', 'mote.calendar': '日历安排', 'mote.coding-session': 'Coding Agent 会话' };
export function materialKind(kind: string, registered?: string) { return registered ? moteText(registered) : moteText(kinds[kind] ?? '其他资料'); }
/** Existing wire kinds, including generic kinds without a custom card renderer. */
export function materialKindOptions(){return Object.keys(kinds).map(kind=>({kind,label:materialKind(kind)}));}
export function materialState(state: string) { return moteText(({ complete: '处理完成', partial: '内容不完整', pending: '仍在整理', ready: '已就绪', waiting: '等待处理', running: '处理中', failed: '处理失败', blocked: '需要处理', unavailable: '不可用', retained: '原件已保留', derived: '派生资料', reference: '仅保留引用', removed: '原件已删除', not_retained: '未保留原件' } as Record<string, string>)[state] ?? '状态暂未识别'); }
export function sourceDisplay(id: string, label?: string) {
    if (label && label !== id)
        return label;
    if (/^authored:[a-f0-9]{64}$/.test(id))
        return moteText('用户记录来源');
    if (/^screen:[a-f0-9]{64}$/.test(id))
        return moteText('设备屏幕来源');
    if (/^state:[a-f0-9]{64}$/.test(id))
        return moteText('设备状态来源');
    return moteText('资料来源');
}
export function artifactDisplay(key: string) { return moteText(({ 'source-body': '来源正文', 'extracted-text': '提取文本', 'authored-record': '用户记录', 'screen-segment': '屏幕片段', 'capture-event': '采集事件', 'transcript': '转写文本', 'original': '原件' } as Record<string, string>)[key] ?? '处理产物'); }
