import {z} from 'zod';
import type {FastifyInstance} from 'fastify';
import {decodeSourceText,sourceTextFormat,sourceItemKinds} from '@mote/shared';
import {MaterialStore,formatMaterialRef,type MaterialStoredBlock} from './materials.js';
import {StoreError} from './store.js';

// Presentation of the source-item organizer's declared block formats, never
// intent inference. Unknown structures remain literal text in the fallback.
type Display={type:'text'|'source'|'asset'|'raw';text:string;speaker?:string;confirmedName?:string;capturedAt?:string;recordedAt?:string;occurredAt?:string;appName?:string;sourceRef?:string;sourceType?:string;startMs?:number;endMs?:number;mimeType?:string};
function display(block:MaterialStoredBlock):Display {
  if(block.kind==='asset')return {type:'asset',text:'',mimeType:block.asset?.mimeType};
  const timing=typeof block.locator?.startMs==='number'&&Number.isFinite(block.locator.startMs)&&block.locator.startMs>=0?{startMs:block.locator.startMs,...(typeof block.locator.endMs==='number'&&Number.isFinite(block.locator.endMs)?{endMs:block.locator.endMs}:{})}:{};
  if(block.format==='json'){
    const format=sourceTextFormat(block),value=format&&decodeSourceText(format,block.text);
    if(value?.kind==='source')return {type:'source',text:value.text,capturedAt:value.capturedAt,recordedAt:value.documentTime?.recordedAt,occurredAt:value.documentTime?.occurredAt,appName:value.appName,sourceRef:'capture:'+value.captureId,sourceType:value.source};
    if(value?.kind==='speech')return {type:'text',text:value.text,speaker:value.speaker,...(value.speakerAttribution?{confirmedName:value.speakerAttribution.name}:{}),...timing};
    return {type:'raw',text:block.text,...timing};
  }
  return {type:'text',text:block.text,...timing};
}
const query=z.object({revision:z.string().regex(/^[a-f0-9]{64}$/),block:z.coerce.number().int().nonnegative().default(0),offset:z.coerce.number().int().nonnegative().max(250000).default(0),length:z.coerce.number().int().min(2).max(8000).default(4000)}).strict();
export function sourceMaterialView(materials:MaterialStore,id:string,input:unknown){
  const args=query.parse(input),ref=formatMaterialRef(id,args.revision),material=materials.get(ref);
  if(!material||!sourceItemKinds.some(kind=>material.kind==='mote.'+kind)||material.schemaVersion!==1)throw new StoreError('Source material view is unavailable',404);
  let index=args.block,offset=args.offset,remaining=args.length;
  if(index>material.blockCount||index===material.blockCount&&offset)throw new StoreError('Invalid material view range');
  const items:(Omit<Display,'text'>&{blockId:string;text:string;offset:number;total:number;continued:boolean})[]=[];
  while(index<material.blockCount&&items.length<32&&remaining>0){
    const entry=materials.block(ref,index);if(!entry)break;
    const body=display(entry.block);if(offset>body.text.length)throw new StoreError('Invalid material view offset');
    // The cursor counts decoded UTF-16 text, independently of JSON escaping and
    // the raw Material coordinate system. Never split a surrogate pair.
    const split=(at:number)=>at>0&&at<body.text.length&&/[\uD800-\uDBFF]/.test(body.text[at-1])&&/[\uDC00-\uDFFF]/.test(body.text[at]);
    if(split(offset))throw new StoreError('Invalid material view character boundary');
    let end=Math.min(body.text.length,offset+remaining);if(split(end))end--;
    if(end===offset&&offset<body.text.length){if(items.length)break;end=Math.min(offset+2,body.text.length);}
    items.push({...body,blockId:entry.block.id,text:body.text.slice(offset,end),offset,total:body.text.length,continued:end<body.text.length});
    remaining-=end-offset;
    if(end<body.text.length){offset=end;break;}
    index++;offset=0;
  }
  // Even an empty/end page must honor a newly invalidated current revision.
  if(material.coverage.reason==='source_evidence_changed')throw new StoreError('Material source evidence changed; reconstruction is pending',409);
  return {material,items,next:index<material.blockCount?{block:index,offset}:null};
}

/** Owner-only transport contributed by the source presentation feature. */
export function registerSourceMaterialView(app:FastifyInstance,materials:MaterialStore){
  app.get('/api/materials/:id/source-view',async req=>sourceMaterialView(materials,z.string().regex(/^mat_[a-f0-9]{64}$/).parse((req.params as {id:string}).id),req.query));
}
