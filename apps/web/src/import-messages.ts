import type {ImportJob} from '@mote/shared';
import {moteText} from '@mote/shared/i18n';
const missingAssessment='The parser did not provide a confirmation assessment.';
const unexplainedAssessment='The parser did not explain its confirmation assessment.';
const missingOriginals='The parser did not account for every original file.';
const unparsedOriginals='Some originals were not parsed as evidence.';
/** Public facts must prove the gate's host branch; an exact sentence alone is not provenance. */
function hostGateKey(job:ImportJob):string|undefined {
 const gate=job.reviewGate,decision=job.reviewDecision;if(!gate)return;
 // A model assessment may supply any literal reason, including a host fallback.
 if(decision?.reason===gate.reason)return;
 // Manual processing is not public. Its sentence cannot prove a host branch.
 if(gate.decision==='confirmation'){
  if(gate.reason===missingAssessment&&!decision)return '解析未说明是否需要确认，请核对预览。';
  if(gate.reason===unexplainedAssessment&&decision&&!decision.reason?.trim())return '解析未说明继续处理的依据，核对预览。';
  if(decision?.requiresConfirmation===false&&decision.reason?.trim()){
   if(gate.reason===missingOriginals&&(!job.dispositions||job.dispositions.items.length!==job.files.length))return '尚未核对全部原件，检查文件解析情况。';
   if(gate.reason===unparsedOriginals&&job.dispositions&&job.dispositions.items.length===job.files.length&&(job.dispositions.counts.unsupported||(!job.dispositions.counts.parsed&&!job.dispositions.counts.processing)))return '部分原件未作为证据解析，核对原件与预览。';
  }
 }
}
export const importReviewMessage=(job:ImportJob)=>{const key=hostGateKey(job);return key?moteText(key):job.reviewGate?.reason;};
/** Warnings merge provider and worker prose without per-item provenance: preserve every byte. */
export const importHostDiagnostics=(job:ImportJob)=>hostGateKey(job)?[job.reviewGate!.reason]:[];
