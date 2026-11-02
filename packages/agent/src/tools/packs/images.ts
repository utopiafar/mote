import {createHash} from 'node:crypto';
import {
  IMAGE_MAX_BYTES,
  IMAGE_REGION_MAX_SIDE,
  imageReadSchema,
  imageViewSchema,
  type ImageReadInput,
  type ImageReadResult,
  type ImageView,
  type ImageViewTrace,
} from '@mote/shared';
import {CONTEXT_TOOLS} from '../../context-tools.js';
import {ContextToolError} from '../../tool-errors.js';
import {defineToolDescriptor, type ToolDescriptor, type ToolFields} from '../descriptor.js';
import type {HostSessionPort} from '../host-session.js';
import type {ImagePayload} from '../image-result.js';

/** A08F image-read pack. It owns the read_image schema/parse, thin view
 * verification and the pure payload shape. The parent Host still owns
 * disclosure grants, image budget, byte dedupe/cache, the sender and the actual
 * imageDelivery receipt; a returned id or prepared attachment grants nothing. */

export interface ImageReadPackOptions {}

const spec=():readonly [string,string,ToolFields]=>{
  const entry=CONTEXT_TOOLS.find(([name])=>name==='read_image');
  if(!entry)throw new Error('Missing context-tool schema for read_image');
  return entry as unknown as readonly [string,string,ToolFields];
};

const invalid=(message:string,details:Record<string,unknown>={})=>new ContextToolError('invalid_image_region',message,'correct_arguments',details);

function publicView(view:ImageView|undefined,input:ImageReadInput,metadata:boolean):ImageViewTrace|undefined{
  if(!view)return undefined;
  return {...view,id:input.id,...(input.attachmentId===undefined?{}:{attachmentId:input.attachmentId}),delivery:metadata?'metadata':'pending'};
}

/** Verify the reader's view metadata against the requested original/region.
 * Grant, budget and disclosure state stay with the parent. */
function verifiedView(image:ImageReadResult,input:ImageReadInput,metadata:boolean):ImageView|undefined{
  if(!image.imageView){
    if(metadata||input.region||input.expectedImageSha256)
      throw new ContextToolError('image_view_unsupported','This image reader cannot verify metadata or regions. Use existing evidence or a plain original image request.','use_existing_evidence');
    return undefined;
  }
  const checked=imageViewSchema.safeParse(image.imageView);
  if(!checked.success)throw invalid('Invalid image view metadata');
  const view=checked.data;
  const expectedTransform=metadata?'metadata@1':input.region?'crop-encoded-raster-png@1':'original-bytes@1';
  const expectedId=createHash('sha256').update(JSON.stringify([view.original.sha256,'encoded-raster-pixels-v1',input.region??null,expectedTransform])).digest('hex');
  if(JSON.stringify(view.region)!==JSON.stringify(input.region??null)||view.transform!==expectedTransform||view.viewId!==expectedId||
    input.expectedImageSha256&&view.original.sha256!==input.expectedImageSha256||
    view.region&&(view.region.x+view.region.width>view.original.width||view.region.y+view.region.height>view.original.height||view.original.pages!==1))
    throw invalid('Image view does not match the requested original and region');
  return view;
}

/** The single image descriptor. Versioning is explicit so a pinned snapshot
 * cannot silently inherit a schema change. */
export function createImageReadPack(_options:ImageReadPackOptions={}):readonly ToolDescriptor[]{
  const imageSpec=spec();
  const readImage=defineToolDescriptor({
    apiVersion:'1',name:'read_image',version:'1',description:imageSpec[1],fields:imageSpec[2],kind:'image',exposure:'native',requires:['readImage'],
    parse(args){
      const parsed=imageReadSchema.safeParse(args);
      if(!parsed.success)throw new ContextToolError('invalid_image_region','Use the declared image arguments. Regions require expectedImageSha256, integer original coordinates and sides of 1–2048.','correct_arguments',{maxRegionSide:IMAGE_REGION_MAX_SIDE});
      return parsed.data as unknown as Readonly<Record<string,unknown>>;
    },
    async execute(args,port:HostSessionPort){
      const input=args as unknown as ImageReadInput,metadata=input.view==='metadata';
      port.assertCurrent();
      const image=await port.read('readImage',input);
      port.assertCurrent();
      const view=verifiedView(image,input,metadata);
      const trace=publicView(view,input,metadata);
      if(metadata){
        if(image.data!==undefined||view?.output)throw invalid('Metadata must not include image bytes');
        return {source:'untrusted_personal_context',...input,...(trace===undefined?{}:{imageView:trace})} satisfies ImagePayload;
      }
      if(!['image/png','image/jpeg','image/webp'].includes(image.mimeType)||typeof image.data!=='string'||!image.data.length||image.data.length>12*1024*1024)
        throw invalid('Invalid image output');
      const bytes=Buffer.from(image.data,'base64'),sha256=createHash('sha256').update(bytes).digest('hex');
      if(bytes.length>IMAGE_MAX_BYTES)throw invalid('Invalid image output size');
      if(view&&(!view.output||view.output.sha256!==sha256||view.output.mimeType!==image.mimeType||view.output.sizeBytes!==bytes.length||
        view.output.width!==(view.region?.width??view.original.width)||view.output.height!==(view.region?.height??view.original.height)||
        !view.region&&(sha256!==view.original.sha256||image.mimeType!==view.original.mimeType)))
        throw invalid('Image output does not match its declared view');
      // No imageDelivery token, imageBudget or dedupe/cache bookkeeping: the
      // parent Host issues the receipt only after the real sender confirms.
      return {source:'untrusted_personal_context',...input,...(trace===undefined?{}:{imageView:trace}),image:{mimeType:image.mimeType,data:image.data}} satisfies ImagePayload;
    },
  });
  return Object.freeze([readImage]);
}
