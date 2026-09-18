import type {ContextRecord} from './types.js';
export type DeliveredRange={start:number;end:number;text:string};
/** Per-run evidence, scoped by revision and content layer. No cross-run authority. */
export function rememberEvidence(records:Map<string,ContextRecord>,record:ContextRecord){
  const previous=records.get(record.id);
  const same=previous?.evidenceFingerprint===record.evidenceFingerprint&&previous?.contentLayer===record.contentLayer;
  const ranges:DeliveredRange[]=same?[...((previous?.deliveredRanges as DeliveredRange[]|undefined)??[])]:[];
  const range=record.textRange as {start:number;end:number}|undefined;
  if(range&&!ranges.some(r=>r.start===range.start&&r.end===range.end))ranges.push({...range,text:record.ocrText});
  // Keep every delivered span. Never pretend disjoint spans are contiguous text.
  records.set(record.id,{...record,deliveredRanges:ranges.sort((a,b)=>a.start-b.start)});
}
export function evidenceExcerpt(record:ContextRecord){
  const spans=record.deliveredRanges as DeliveredRange[]|undefined;
  if(!spans?.length)return record.ocrText;
  const length=Math.max(40,Math.floor(560/Math.min(spans.length,6)));
  return spans.slice(0,6).map(r=>r.text.slice(0,length)).join(' … ');
}
