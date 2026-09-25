import { moteText } from '@mote/shared/i18n';
/** Owner-authorized saved representation. This is not an exported MEMORY.md or historical model input. */
export function MemoryRecordPanel({record}:{record:object}){return <details className="memory-record"><summary>{moteText('保存记录（只读）')}</summary><p>{moteText('这是中央端返回的结构化记忆记录；下载文本是导出表示，实际模型输入请查看运行追踪。')}</p><pre className="feature-json">{JSON.stringify(record,null,2)}</pre></details>;}
