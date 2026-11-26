import {z} from 'zod';
import type {FastifyInstance} from 'fastify';
import {collectedMaterialVersions,decodeSourceText,sourceTextFormat,sourceItemKinds,systemEventText,uiPageV3Schema,uiPageText} from '@mote/shared';
import {moteText} from '@mote/shared/i18n';
import {MaterialStore,formatMaterialRef,type MaterialStoredBlock} from './materials.js';
import {StoreError} from './evidence-store.js';

// Presentation of the source-item organizer's declared block formats, never
// intent inference. Unknown structures remain literal text in the fallback.
type Display={type:'text'|'source'|'asset'|'raw';text:string;speaker?:string;confirmedName?:string;capturedAt?:string;recordedAt?:string;occurredAt?:string;appName?:string;sourceRef?:string;sourceType?:string;referenceOnly?:boolean;startMs?:number;endMs?:number;mimeType?:string};

const capturedObservation=z.object({
  captureId:z.string().uuid(),capturedAt:z.string().datetime({offset:true}),source:z.string(),
  appName:z.string().optional(),text:z.string().optional(),durationMs:z.number().nonnegative().optional(),
  deviceEvent:z.object({action:z.enum(['screen_on','screen_off','user_present','state_observed']),keyguardLocked:z.boolean(),screenInteractive:z.boolean()}).optional(),
});
const readingField=z.object({name:z.string(),text:z.string()});
const originalFrame=z.object({captureId:z.string().uuid()});
const playbackInterval=z.object({measuredPlaybackMs:z.number().nonnegative(),sessions:z.array(z.object({title:z.string().optional(),artist:z.string().optional()}))});
const notificationRecord=z.object({capturedAt:z.string().datetime({offset:true}),notification:z.object({
  action:z.enum(['posted','updated','removed']),notificationKey:z.string(),postedAt:z.string(),ongoing:z.boolean(),groupSummary:z.boolean(),
  title:z.string().optional(),text:z.string().optional(),bigText:z.string().optional(),subText:z.string().optional(),textLines:z.array(z.string()).optional(),
})});

/** Built-in capture organizers declare these blocks. Internal locators and
 * processing metadata stay available in the pinned raw structure. */
function captureDisplay(kind:string,title:string,block:MaterialStoredBlock):Display|undefined {
  if(block.kind!=='text')return display(block);
  if(kind==='mote.screen-segment'){
    if(block.format==='plain')return {type:'text',text:block.text};
    const original=originalFrame.safeParse(block.locator?.memoryImageOriginal);
    if(original.success&&block.memberIds.includes(original.data.captureId))return {type:'source',text:'',sourceType:'screen',sourceRef:'capture:'+original.data.captureId};
    return;
  }
  if(block.format!=='json')return;
  let value:unknown;
  try {value=JSON.parse(block.text);} catch {return;}
  switch(kind){
    case 'mote.ui-page-object': {
      if(!block.id.startsWith('field:'))return;
      const result=readingField.safeParse(value);
      if(result.success&&(result.data.name!=='title'||result.data.text!==title))return {type:'text',text:result.data.text};
      return;
    }
    case 'mote.notification': {
      if(block.id!=='record-metadata')return;
      const result=notificationRecord.safeParse(value);
      if(result.success)return {type:'text',text:systemEventText({version:1,observedAt:result.data.capturedAt,notification:result.data.notification})};
      return;
    }
    case 'mote.state-series':
      if(block.id==='playback-interval'){
        const result=playbackInterval.safeParse(value);
        if(!result.success)return;
        const {sessions,measuredPlaybackMs}=result.data;
        return {type:'text',text:[...sessions.map(session=>[session.title,session.artist].filter(Boolean).join(' · ')),
          moteText('此记录的已观察播放时长：{0} 秒（不含观测缺口）',measuredPlaybackMs/1000)].filter(Boolean).join('\n')};
      }
      if(block.id!=='samples')return;
      break;
    case 'mote.capture-event':
      if(block.id!=='observation'||!value||typeof value!=='object'||!('capture' in value))return;
      const page=uiPageV3Schema.safeParse('uiPage' in value?value.uiPage:undefined);
      const capture=capturedObservation.safeParse(value.capture);
      if(!capture.success||!block.memberIds.includes(capture.data.captureId))return;
      const {captureId,capturedAt,source,text}=capture.data;
      return {type:'source',text:page.success?uiPageText(page.data):text??'',capturedAt,sourceRef:'capture:'+captureId,sourceType:source};
  }
  const observation=capturedObservation.safeParse(value);
  if(!observation.success||!block.memberIds.includes(observation.data.captureId))return;
  const {captureId,capturedAt,source,deviceEvent,durationMs,appName}=observation.data;
  const text=deviceEvent?systemEventText({version:1,observedAt:capturedAt,deviceEvent}):durationMs?
    [appName,moteText('前台应用采样时长'),moteText('{0} 秒',durationMs/1000)].filter(Boolean).join(' · '):appName??'';
  return {type:'source',text,capturedAt,sourceType:source,sourceRef:'capture:'+captureId};
}

function display(block:MaterialStoredBlock):Display {
  if(block.kind==='asset')return {type:'asset',text:'',mimeType:block.asset?.mimeType};
  const timing=typeof block.locator?.startMs==='number'&&Number.isFinite(block.locator.startMs)&&block.locator.startMs>=0?{startMs:block.locator.startMs,...(typeof block.locator.endMs==='number'&&Number.isFinite(block.locator.endMs)?{endMs:block.locator.endMs}:{})}:{};
  if(block.format==='json'||block.format==='speech-text'){
    const format=sourceTextFormat(block),value=format&&decodeSourceText(format,block.text);
    if(value?.kind==='source'){
      const version='sourceVersion' in value?value.sourceVersion:undefined;
      const referenceOnly=version!==null&&typeof version==='object'&&'layer' in version&&version.layer==='reference';
      return {type:'source',text:value.text,capturedAt:value.capturedAt,recordedAt:value.documentTime?.recordedAt,occurredAt:value.documentTime?.occurredAt,appName:value.appName,sourceRef:'capture:'+value.captureId,sourceType:value.source,...(referenceOnly?{referenceOnly}: {})};
    }
    if(value?.kind==='speech')return {type:'text',text:value.text,speaker:value.speaker,...(value.speakerAttribution?{confirmedName:value.speakerAttribution.name}:{}),...timing};
    return {type:'raw',text:block.text,...timing};
  }
  return {type:'text',text:block.text,...timing};
}

function fileDisplay(block:MaterialStoredBlock):Display|undefined {
  if(block.kind==='text'&&block.format==='json'&&block.id==='image:original'){
    const image=originalFrame.safeParse(block.locator?.memoryImageOriginal);
    if(image.success&&block.memberIds.includes(image.data.captureId))return;
  }
  return display(block);
}

const query=z.object({revision:z.string().regex(/^[a-f0-9]{64}$/),block:z.coerce.number().int().nonnegative().default(0),offset:z.coerce.number().int().nonnegative().max(250000).default(0),length:z.coerce.number().int().min(2).max(8000).default(4000)}).strict();
export function sourceMaterialView(materials:MaterialStore,id:string,input:unknown){
  const args=query.parse(input),ref=formatMaterialRef(id,args.revision),material=materials.get(ref);
  const captureView=material&&collectedMaterialVersions[material.kind]===material.schemaVersion;
  if(!material||!captureView&&(!sourceItemKinds.some(kind=>material.kind==='mote.'+kind)||![1,2].includes(material.schemaVersion)))throw new StoreError('Source material view is unavailable',404);
  let index=args.block,offset=args.offset,remaining=args.length;
  if(index>material.blockCount||index===material.blockCount&&offset)throw new StoreError('Invalid material view range');
  const items:(Omit<Display,'text'>&{attributionContext:MaterialStoredBlock['attributionContext'];locator?:MaterialStoredBlock['locator'];blockId:string;text:string;offset:number;total:number;continued:boolean})[]=[];
  const readUntil=captureView?Math.min(material.blockCount,index+128):material.blockCount;
  while(index<readUntil&&items.length<32&&remaining>0){
    const entry=materials.block(ref,index);if(!entry)break;
    const body=captureView?captureDisplay(material.kind,material.title,entry.block):material.kind==='mote.file'?fileDisplay(entry.block):display(entry.block);
    if(!body){
      if(offset)throw new StoreError('Invalid material view offset');
      index++;continue;
    }
    if(offset>body.text.length)throw new StoreError('Invalid material view offset');
    // The cursor counts decoded UTF-16 text, independently of JSON escaping and
    // the raw Material coordinate system. Never split a surrogate pair.
    const split=(at:number)=>at>0&&at<body.text.length&&/[\uD800-\uDBFF]/.test(body.text[at-1])&&/[\uDC00-\uDFFF]/.test(body.text[at]);
    if(split(offset))throw new StoreError('Invalid material view character boundary');
    let end=Math.min(body.text.length,offset+remaining);if(split(end))end--;
    if(end===offset&&offset<body.text.length){if(items.length)break;end=Math.min(offset+2,body.text.length);}
    items.push({...body,attributionContext:entry.block.attributionContext,...(entry.block.locator?{locator:entry.block.locator}:{}),blockId:entry.block.id,text:body.text.slice(offset,end),offset,total:body.text.length,continued:end<body.text.length});
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
