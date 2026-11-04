import type {OcrResult} from '@mote/shared';
/** Projection only: retained originals and job state are never rewritten. */
export function centralOcrState(job:{state:string;error?:string|null},enabled:boolean):OcrResult {
  if(!enabled||job.error==='processing_disabled')return {status:'disabled'};
  if(job.state==='cancelled')return {status:'disabled'};
  if(job.state==='waiting'||job.state==='running')return {status:'pending'};
  // A succeeded job without a retained current result cannot claim completion.
  return {status:'failed'};
}
