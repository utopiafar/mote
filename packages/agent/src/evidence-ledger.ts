import type {ContextRecord} from './types.js';
import {sourceTextBoundaries} from '@mote/shared';
export type DeliveredRange={start:number;end:number;text:string};
// Display-only coordinates, never model input or citation authority. They hold
// no decoded original text: excerpts are made from delivered raw spans only.
const presentations=new WeakMap<ContextRecord,number[]>();
export function projectEvidencePresentation(source:ContextRecord,projected:ContextRecord){
  if(source.contentLayer==='L2_model_interpretation')return projected;
  const format=source.evidencePresentation;
  if(format==='source-record-json-v1'||format==='speech-json-v1'){
    const boundaries=sourceTextBoundaries(format,source.ocrText);if(boundaries)presentations.set(projected,boundaries);
  }
  return projected;
}
/** Preserve private display coordinates through the tool's JSON safety copy. */
export function copyEvidencePresentation(source:ContextRecord,target:ContextRecord){
  const plan=presentations.get(source);if(plan)presentations.set(target,plan);return target;
}
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
  const presentation=presentations.get(record);
  if(presentation)presentations.set(delivered,presentation);
  const current=records.get(record.id);
  if(record.contentLayer!=='L2_model_interpretation'||!current||current.contentLayer==='L2_model_interpretation')records.set(record.id,delivered);
}
export function excerptSlice(text:string,length:number){
  let end=Math.min(length,text.length);
  if(end>0&&end<text.length&&/[\uD800-\uDBFF]/.test(text[end-1])&&/[\uDC00-\uDFFF]/.test(text[end]))end--;
  return text.slice(0,end);
}
function mergedSpans(spans:DeliveredRange[]){
  const merged:DeliveredRange[]=[];
  for(const span of [...spans].sort((a,b)=>a.start-b.start||a.end-b.end)){
    const prior=merged.at(-1);
    if(prior&&span.start<=prior.end){
      const overlap=Math.min(prior.end,span.end)-span.start;
      if(prior.text.slice(span.start-prior.start,span.start-prior.start+overlap)===span.text.slice(0,overlap)){
        if(span.end>prior.end){prior.text+=span.text.slice(overlap);prior.end=span.end;}continue;
      }
    }
    merged.push({...span});
  }
  return merged;
}
function lowerBound(values:number[],target:number){let lo=0,hi=values.length;while(lo<hi){const mid=(lo+hi)>>>1;if(values[mid]<target)lo=mid+1;else hi=mid;}return lo;}
export function evidenceExcerpt(record:ContextRecord){
  const spans=record.deliveredRanges as DeliveredRange[]|undefined;
  if(!spans?.length)return excerptSlice(record.ocrText,600);
  const plan=presentations.get(record);
  const readable=mergedSpans(spans).flatMap(span=>{
    if(!plan)return [span];
    const start=plan[lowerBound(plan,span.start)],endIndex=lowerBound(plan,span.end),end=plan[endIndex]===span.end?span.end:plan[endIndex-1];
    if(start===undefined||end===undefined||start>=end)return [];
    // Complete JSON escape/code-point boundaries, wholly inside this delivered
    // range. Never decode a full body and fill the unread tail from it.
    try{return [{start,end,text:JSON.parse('"'+span.text.slice(start-span.start,end-span.start)+'"') as string}];}catch{return []}
  });
  if(!readable.length)return plan?'…':'';
  const length=Math.max(40,Math.floor(560/Math.min(readable.length,6)));
  const selected=readable.slice(0,6),pieces=selected.map(r=>excerptSlice(r.text,length));
  const prefix=plan&&selected[0].start>plan[0]?'… ':'';
  const tail=selected.at(-1)!,last=pieces.at(-1)!;
  const suffix=tail.text.length>last.length||readable.length>selected.length||plan&&tail.end<plan.at(-1)!?' …':'';
  return prefix+pieces.join(' … ')+suffix;
}
