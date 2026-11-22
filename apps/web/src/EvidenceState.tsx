import {nativeStatusView} from '@mote/shared/native-status';
import {moteText} from '@mote/shared/i18n';
/** A successful central read proves archival presence, never completion of processing. */
export function EvidenceState(_props:{compact?:boolean}={}){
 const view=nativeStatusView({pending:0,archiveAcknowledged:true,syncState:'idle'});
 return <p className="muted" data-archive-state={view.archive.state} data-processing-state={view.processing.state}>{moteText('资料已归档')}</p>;
}
export function EvidenceProcessingHelp(){
 return <details className="evidence-processing-help"><summary>{moteText('归档与处理说明')}</summary><p>{moteText('OCR、索引和记忆分别处理；处理进度在任务中心查看。')}</p></details>;
}
