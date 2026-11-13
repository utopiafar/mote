import {z} from 'zod';
import {IMAGE_MAX_PIXELS,imageViewSchema,transcriptSchema,type CaptureRecord,type ImageView,type Transcript} from '@mote/shared';
import type {Store} from './store.js';
import type {ImageInputRow} from './image-inputs.js';
import {imageInterpretationSchema,type ImageInterpretation} from './image-recipes.js';
import {fileAttachmentAvailable} from './file-attachments.js';
import type {MaterialDraft,MaterialEvidenceContext} from './materials.js';

type ImageEvidence={ref:string;revision:string;original:ImageView['original'];coordinateSpace:ImageView['coordinateSpace']};
type ImageProduct={name:string;kind:string;revision:string;text?:string;transcript?:Transcript;evidence?:ImageEvidence;regions?:ImageInterpretation['regions']};
type ImageJob={name:string;kind?:string;state:'ready'|'pending'|'failed'|'unavailable';reason?:string};
export type ImageMaterialProjection={
 original?:{captureId:string;sha256:string};
 archiveOnly:boolean;products:ImageProduct[];jobs:ImageJob[];
};
/** A read snapshot of the current producer's persisted envelope. This is an
 * in-memory projection input, not another wire format or readiness authority. */
export type ImageMaterialSnapshot={
 input:Pick<ImageInputRow,'capture_id'|'hash'|'mime'|'revision'|'policy_json'|'understanding_enabled'|'semantic_withdrawn'>;
 originalAvailable:boolean;understandingEnabled:boolean;
 products:{id:string;name:string;kind:string;json:string}[];
 jobs:{name:string;kind?:string;state:string;error?:string|null}[];
};
const evidenceSchema=imageViewSchema.innerType().pick({original:true,coordinateSpace:true}).extend({ref:z.string(),revision:z.string()}).strict()
 .refine(value=>value.original.width*value.original.height<=IMAGE_MAX_PIXELS,'Original decoded pixel limit exceeded');

/** Only host-bound products enter Material text. Local/cloud model receipts
 * stay in image_products for diagnostics; neither is OCR or an original quote.
 * Successful empty OCR is ready because its serialized Transcript exists, not
 * merely because a job says succeeded. A bad semantic product cannot hide OCR.
 */
export function projectImageMaterial(snapshot:ImageMaterialSnapshot):ImageMaterialProjection {
 const {input}=snapshot,policy=input.policy_json?JSON.parse(input.policy_json):undefined;
 const archiveOnly=policy?.profile?.processorId==='archive',products:ImageProduct[]=[],invalid=new Set<string>();
 for(const row of snapshot.products){
  try{
   const value=JSON.parse(row.json),source=value.input;
   if(value.kind!==row.kind||source?.captureId!==input.capture_id||source.hash!==input.hash||source.revision!==input.revision||source.mimeType!==input.mime)throw Error('Image input changed');
   if(row.kind==='ocr'){
    const transcript=transcriptSchema.parse(value.payload),text=transcript.segments.map(segment=>segment.text).join('\n');
    if(transcript.durationMs!==0||text.length>100000)throw Error('Invalid image OCR');
    products.push({name:row.name,kind:row.kind,revision:row.id,text,transcript});
   }else{
    if(input.semantic_withdrawn)continue;
    const payload=imageInterpretationSchema.parse(value.payload),evidence=evidenceSchema.parse(value.evidence);
    if(evidence.ref!=='capture:'+input.capture_id||evidence.revision!==input.revision||evidence.original.sha256!==input.hash||
      input.mime!=='application/octet-stream'&&evidence.original.mimeType!==input.mime||
      payload.regions.some(region=>region.x+region.width>evidence.original.width||region.y+region.height>evidence.original.height))throw Error('Image evidence changed');
    products.push({name:row.name,kind:row.kind,revision:row.id,text:payload.text,regions:payload.regions,evidence});
   }
  }catch{invalid.add(row.name);}
 }
 const kinds=new Map(snapshot.products.map(row=>[row.name,row.kind]));
 const jobs:ImageJob[]=snapshot.jobs.map(job=>{
  const kind=job.kind??kinds.get(job.name),product=products.find(candidate=>candidate.name===job.name);
  if(input.semantic_withdrawn&&kind&&kind!=='ocr')return {name:job.name,kind,state:'unavailable',reason:'attribution_context_changed'};
  if(product)return {name:job.name,kind:product.kind,state:'ready'};
  if(invalid.has(job.name))return {name:job.name,kind,state:'failed',reason:'invalid_image_product'};
  const state=['waiting','running'].includes(job.state)?'pending':['failed','blocked'].includes(job.state)?'failed':'unavailable';
  return {name:job.name,kind,state,...(job.error?{reason:job.error}:job.state==='succeeded'?{reason:'image_product_missing'}:{})};
 });
 for(const product of products)if(!jobs.some(job=>job.name===product.name))jobs.push({name:product.name,kind:product.kind,state:'ready'});
 if(!jobs.length&&!archiveOnly)jobs.push({name:'ocr',kind:'ocr',state:'pending'});
 if(input.understanding_enabled&&!input.semantic_withdrawn&&snapshot.understandingEnabled&&!archiveOnly&&!policy?.profile?.imageRecipe&&!jobs.some(job=>job.name==='understanding'))jobs.push({name:'understanding',kind:'understanding',state:'pending'});
 return {archiveOnly,...(snapshot.originalAvailable&&input.hash?{original:{captureId:input.capture_id,sha256:input.hash}}:{}),products,jobs};
}

/** Read only current source/attachment evidence. Existing source visibility and
 * original retention stay authoritative; a saved hash alone is not ready. */
export function imageMaterialProjection(store:Store,id:string):ImageMaterialProjection|undefined {
 if(!store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='image_inputs'").get()||!store.isCurrentEvidence(id))return;
 const input=store.db.prepare('SELECT * FROM image_inputs WHERE capture_id=?').get(id) as ImageInputRow|undefined;
 if(!input||!fileAttachmentAvailable(store,id))return;
 const products=store.db.prepare('SELECT id,name,kind,json FROM image_products WHERE capture_id=? AND current=1 ORDER BY rowid').all(id) as ImageMaterialSnapshot['products'];
 // Step names are plugin-defined; active execution membership pins stage kind
 // even when it failed before publishing a product.
 const stages=store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='execution_steps'").get()?store.db.prepare("SELECT m.slot AS name,substr(s.kind,8) AS kind FROM execution_operation_steps m JOIN execution_steps s ON s.id=m.step_id WHERE m.operation_id=? AND m.active=1 AND s.kind LIKE 'images.%'").all('image:'+id):[];
 const kinds=new Map(stages.map(row=>[String(row.name),String(row.kind)]));
 const jobs=store.db.prepare('SELECT kind,state,error FROM perception_jobs WHERE capture_id=?').all(id).map(row=>({name:String(row.kind),kind:kinds.get(String(row.kind)),state:String(row.state),error:row.error?String(row.error):null}));
 const settings=store.db.prepare("SELECT value FROM settings WHERE key='perception-effective'").get();
 let originalAvailable=false;
 if(input.hash){
  const original=input.adapter==='mote.capture-image'?store.db.prepare('SELECT blob_hash AS hash FROM captures WHERE id=?').get(id):store.db.prepare(`SELECT coalesce(v.object_hash,(SELECT object_hash FROM file_snapshot_inputs s WHERE s.capture_id=v.capture_id AND s.expires>?)) AS hash FROM file_versions v WHERE v.capture_id=?`).get(Date.now(),id);
  if(original?.hash===input.hash)try{store.assets.get(input.hash);originalAvailable=true;}catch{/* Removed originals never become ready from a stale input hash. */}
 }
 return projectImageMaterial({input,products,jobs,originalAvailable,understandingEnabled:!settings||JSON.parse(String(settings.value)).understandingEnabled!==false});
}

export type ImageMaterialSection={
 artifact:Omit<NonNullable<MaterialDraft['artifacts']>[number],'blockIds'>;
 blocks:(Omit<Extract<MaterialDraft['blocks'][number],{kind:'text'}>,'format'>&{format:'plain'|'json'})[];
};
const context=(record:CaptureRecord,contentRole:MaterialEvidenceContext['document']['contentRole']):MaterialEvidenceContext=>{
 const document=record.provenance?.document;
 return {observedAt:record.capturedAt,document:{recordedAt:document?.recordedAt,occurredAt:document?.occurredAt,timeBasis:document?.timeBasis??'unknown',contentRole}};
};
/** Pure image sections for the shared organizer. It retains responsibility for
 * text chunking, parent members, screen grouping and automatic Memory claims.
 * No inference, installation, historical scan or model selection occurs here. */
export function imageMaterialSections(record:CaptureRecord,image:ImageMaterialProjection|undefined,prefix='image'):ImageMaterialSection[]{
 if(!image||image.archiveOnly)return [];
 const sections:ImageMaterialSection[]=[];
 if(image.original)sections.push({artifact:{key:prefix==='image'?'image-original':`${prefix}/original-image`,state:'ready',revision:image.original.sha256},blocks:[{
  id:`${prefix}:original`,kind:'text',format:'json',memberIds:[record.id],
  text:JSON.stringify({originalImage:{sha256:image.original.sha256},evidenceKind:'original_image_reference',instruction:'This locator contains no image contents. Use read_image on this evidence ID only when OCR cannot establish the needed visual fact. Interpretation text is navigation, never original proof.'}),
  locator:{memoryImageOriginal:image.original},evidenceContext:context(record,'reference'),
 }]});
 // Screens keep the existing canonical per-frame OCR output even when a recipe
 // names its extraction stage differently. The last published OCR is also the
 // capture's current text; its producer revision includes successful empty OCR.
 if(prefix.startsWith('frame/')){
  const product=image.products.filter(product=>product.kind==='ocr').at(-1),job=product?image.jobs.find(job=>job.name===product.name):image.jobs.filter(job=>job.kind==='ocr').at(-1),text=product?.text??'';
  if(job)sections.push({artifact:{key:`${prefix}/ocr`,state:job.state,...(product?{revision:product.revision}:{}),...(job.reason?{reason:job.reason}:{})},blocks:text?[{
   id:`${prefix}:ocr`,kind:'text',format:'plain',text,memberIds:[record.id],evidenceContext:context(record,'other'),
  }]:[]});
 }
 for(const job of image.jobs.filter(job=>job.kind&&job.kind!=='ocr')){
  const product=image.products.find(product=>product.name===job.name);
  sections.push({artifact:{key:prefix==='image'?`image-${job.name}`:`${prefix}/${job.name}`,state:job.state,...(product?{revision:product.revision}:{}),...(job.reason?{reason:job.reason}:{})},blocks:product?.text?[{
   id:`${prefix}:${job.name}`,kind:'text',format:'json',memberIds:[record.id],
   text:JSON.stringify({imageInterpretation:product.text,regions:product.regions,originalEvidence:product.evidence,productVersion:product.revision,evidenceKind:'model_interpretation',attribution:'Preserve the depicted author and uncertainty; this is not a verbatim original or an owner statement.'}),
   locator:{imageEvidence:product.evidence,productVersion:product.revision},evidenceContext:context(record,'summary'),
  }]:[]});
 }
 return sections;
}
