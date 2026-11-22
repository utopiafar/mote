import { moteText } from '@mote/shared/i18n';
/** Owner-authorized saved representation. This is not an exported MEMORY.md or historical model input. */
export function MemoryRecordPanel({record}:{record:object}){return <details className="memory-record"><summary>{moteText('保存记录（只读）')}</summary><p>{moteText('导出为文本。实际模型输入见运行追踪。')}</p><pre className="feature-json">{JSON.stringify(record,null,2)}</pre></details>;}
