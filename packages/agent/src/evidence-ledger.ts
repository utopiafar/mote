import type {ContextRecord} from './types.js';
export type DeliveredRange={start:number;end:number;text:string};
/** Per-run evidence, scoped by revision and content layer. No cross-run authority. */
const ledgers=new WeakMap<Map<string,ContextRecord>,Map<string,ContextRecord>>();
export function evidenceLayers(records:Map<string,ContextRecord>){return [...(ledgers.get(records)?.values()??[])];}
export function rememberEvidence(records:Map<string,ContextRecord>,record:ContextRecord){
  const ledger=ledgers.get(records)??new Map<string,ContextRecord>();ledgers.set(records,ledger);
  const key=JSON.stringify([record.id,record.evidenceFingerprint??(record.fileEvidence as {revision?:string}|undefined)?.revision??(record.provenance as {revision?:string}|undefined)?.revision,record.contentLayer]);
  const previous=ledger.get(key);
  const same=previous?.evidenceFingerprint===record.evidenceFingerprint&&previous?.contentLayer===record.contentLayer;
  const ranges:DeliveredRange[]=same?[...((previous?.deliveredRanges as DeliveredRange[]|undefined)??[])]:[];
  const range=record.textRange as {start:number;end:number}|undefined;
  if(range&&!ranges.some(r=>r.start===range.start&&r.end===range.end))ranges.push({...range,text:record.ocrText});
  // Keep every delivered span. Never pretend disjoint spans are contiguous text.
  const delivered={...record,deliveredRanges:ranges.sort((a,b)=>a.start-b.start)};ledger.set(key,delivered);
  const current=records.get(record.id);
  if(record.contentLayer!=='L2_model_interpretation'||!current||current.contentLayer==='L2_model_interpretation')records.set(record.id,delivered);
}
export function evidenceExcerpt(record:ContextRecord){
  const spans=record.deliveredRanges as DeliveredRange[]|undefined;
  if(!spans?.length)return record.ocrText;
  const length=Math.max(40,Math.floor(560/Math.min(spans.length,6)));
  return spans.slice(0,6).map(r=>r.text.slice(0,length)).join(' … ');
}
