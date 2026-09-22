import {nativeStatusView} from '@mote/shared/native-status';
import {moteText} from '@mote/shared/i18n';
/** A successful central read proves archival presence, never completion of processing. */
export function EvidenceState(){
 const view=nativeStatusView({pending:0,archiveAcknowledged:true,syncState:'idle'});
 return <p className="muted" data-archive-state={view.archive.state} data-processing-state={view.processing.state}>{moteText('资料已归档')} · {moteText('OCR、索引和记忆分别处理；处理进度请在任务中心查看。')}</p>;
}
