import {createHash} from 'node:crypto';
import {z} from 'zod';
import {IMAGE_MAX_BYTES,attributionContextSchema,documentSchema,imageViewSchema,sourceSchema,transcriptSchema} from '@mote/shared';
import {ImageInterpretationError,imageInterpretationSchema} from './image-recipes.js';

/** IMG-00's single local inference contract, for CORE-00 / IMG-01 / IMG-03.
 *
 * Boundary       Version / representation
 * Request        POST /v1/interpret, JSON v1, bounded base64 of host-approved pixels
 * Pixel lineage  Existing ImageView: original hash/geometry + exact delivered view
 * Result         Existing ImageInterpretation: text + integer ORIGINAL pixel regions
 * Model receipt  Actual model/revision/quantization/engine/prompt version; elapsed ms
 * Usage          Optional measured token counts; absent means unavailable, not zero
 * Errors         The table below; no failure authorizes cloud fallback
 * Cancellation   Existing AbortSignal aborts the HTTP request; no new job/lease ledger
 *
 * This is a worker transport, not a shared wire/storage format or an authorization
 * grant. The host checks its existing authority before upload and before commit.
 * No archive path/URL is accepted. OCR/context/pixels and interpretation are
 * untrusted evidence. Only image intake changes; Memory/review/chat select their
 * own models. A crop result still names original encoded pixels, never 0..1 or
 * crop-relative coordinates. Backend normalization belongs before this boundary.
 */
export const LOCAL_IMAGE_PROTOCOL={version:1,method:'POST',path:'/v1/interpret',maxRequestBytes:12*1024*1024,maxResponseBytes:1024*1024} as const;
export const LOCAL_IMAGE_MODEL={id:'InternVL3-14B-4bit',quantization:'4bit'} as const;
export const LOCAL_IMAGE_PROMPT_VERSION='1';
const digest=z.string().regex(/^[a-f0-9]{64}$/);
const identity=z.string().min(1).max(200);
const mime=z.enum(['image/png','image/jpeg','image/webp']);
const maxBase64=4*Math.ceil(IMAGE_MAX_BYTES/3);

export const localImagePixelsSchema=z.object({
 mimeType:mime,data:z.string().min(4).max(maxBase64),imageView:imageViewSchema,
}).strict().superRefine((value,ctx)=>{
 const fail=(message:string)=>ctx.addIssue({code:'custom',message});
 if(value.data.length>maxBase64)return;
 const bytes=Buffer.from(value.data,'base64'),view=value.imageView,output=view.output,region=view.region;
 if(!bytes.length||bytes.length>IMAGE_MAX_BYTES||bytes.toString('base64')!==value.data)fail('Canonical bounded base64 pixels required');
 if(!output||view.transform==='metadata@1'){fail('Metadata is not delivered pixels');return;}
 if(output.sizeBytes!==bytes.length||output.sha256!==createHash('sha256').update(bytes).digest('hex')||output.mimeType!==value.mimeType)fail('Delivered bytes do not match ImageView output');
 if(region){
  if(view.transform!=='crop-encoded-raster-png@1'||view.original.pages!==1||value.mimeType!=='image/png'||region.x+region.width>view.original.width||region.y+region.height>view.original.height||output.width!==region.width||output.height!==region.height)fail('Crop must retain exact original pixel lineage');
 }else if(view.transform!=='original-bytes@1'||output.sha256!==view.original.sha256||output.width!==view.original.width||output.height!==view.original.height||value.mimeType!==view.original.mimeType)fail('Original view must contain unchanged original bytes');
});

export const localImageRequestSchema=z.object({
 version:z.literal(LOCAL_IMAGE_PROTOCOL.version),operationId:identity,captureId:z.string().uuid(),
 image:localImagePixelsSchema,
 ocr:transcriptSchema.refine(value=>value.durationMs===0&&value.segments.map(segment=>segment.text).join('\n').length<=100000,'Bounded image OCR required').optional(),
 context:z.object({
  capturedAt:z.string().datetime({offset:true}),sourceType:sourceSchema,
  sourceId:z.string().min(1).max(128).optional(),sourceRevision:z.string().min(1).max(1000).optional(),
  title:z.string().max(4000).optional(),appName:z.string().max(200).optional(),
  document:documentSchema.pick({contentRole:true,timeBasis:true,recordedAt:true,occurredAt:true,attachmentOf:true}).optional(),
  attributionContext:attributionContextSchema.optional(),
 }).strict(),
}).strict().refine(value=>Buffer.byteLength(JSON.stringify(value))<=LOCAL_IMAGE_PROTOCOL.maxRequestBytes,'Local image request exceeds transport bound');
export type LocalImageRequest=z.infer<typeof localImageRequestSchema>;

/** Desired enablement and actual availability are independent. In particular,
 * enabled + failed/waiting/stopped must never select the configured cloud model.
 * This domain value adds no host runtime state or model permission system. */
export const localImagePluginStateSchema=z.object({
 enabled:z.boolean(),state:z.enum(['ready','waiting','failed','stopped']),reason:z.string().min(1).max(200).optional(),
}).strict();
export type LocalImagePluginState=z.infer<typeof localImagePluginStateSchema>;

/** Worker-declared failures use a JSON error envelope (HTTP 200) so the existing
 * bounded local JSON transport can retain the domain code. HTTP auth/admission
 * failures may still use 401/403/429/503 and keep existing transport semantics.
 * Missing model / stopped worker wait for owner/lifecycle recovery, never cloud.
 */
export const LOCAL_IMAGE_ERRORS={
 model_missing:{category:'blocked',hostCode:'model_missing'},
 worker_unavailable:{category:'blocked',hostCode:'image_worker_unavailable'},
 busy:{category:'transient',hostCode:'rate_limited'},
 cancelled:{category:'blocked',hostCode:'cancelled'},
 invalid_request:{category:'permanent',hostCode:'invalid_image_request'},
 unsupported_image:{category:'permanent',hostCode:'unsupported_image'},
 invalid_model_output:{category:'permanent',hostCode:'invalid_image_product'},
 invalid_image_region:{category:'permanent',hostCode:'invalid_image_region'},
 version_mismatch:{category:'permanent',hostCode:'image_protocol_version_mismatch'},
 inference_failed:{category:'permanent',hostCode:'image_processing_failed'},
} as const;
export type LocalImageErrorCode=keyof typeof LOCAL_IMAGE_ERRORS;
const correlation={version:z.literal(LOCAL_IMAGE_PROTOCOL.version),operationId:identity,captureId:z.string().uuid(),originalSha256:digest,imageViewId:digest};
export const localImageSuccessSchema=z.object({
 ...correlation,status:z.literal('ok'),execution:z.literal('local'),result:imageInterpretationSchema,
 model:z.object({
  id:z.literal(LOCAL_IMAGE_MODEL.id),quantization:z.literal(LOCAL_IMAGE_MODEL.quantization),
  revision:z.string().min(1).max(200),engine:z.literal('mlx'),engineVersion:z.string().min(1).max(100),
  promptVersion:z.literal(LOCAL_IMAGE_PROMPT_VERSION),
 }).strict(),
 elapsedMs:z.number().finite().nonnegative(),
 usage:z.object({inputTokens:z.number().int().nonnegative().optional(),outputTokens:z.number().int().nonnegative().optional()}).strict().refine(value=>Object.keys(value).length>0,'Omit unavailable usage').optional(),
}).strict();
export const localImageFailureSchema=z.object({
 ...correlation,status:z.literal('error'),execution:z.literal('local'),
 error:z.object({code:z.enum(Object.keys(LOCAL_IMAGE_ERRORS) as [LocalImageErrorCode,...LocalImageErrorCode[]]),retryAfterMs:z.number().int().positive().optional()}).strict(),
}).strict();
export const localImageResponseSchema=z.discriminatedUnion('status',[localImageSuccessSchema,localImageFailureSchema]);
export type LocalImageResponse=z.infer<typeof localImageResponseSchema>;
export type LocalImageSuccess=z.infer<typeof localImageSuccessSchema>;

/** Validate transport shape and bind the response to the exact host input.
 * ImageProcessing remains the real publication consumer and checks region
 * bounds against the archived original. No parallel downstream result format. */
export function parseLocalImageResponse(raw:unknown,request:LocalImageRequest):LocalImageResponse {
 const parsed=localImageResponseSchema.safeParse(raw);
 if(!parsed.success)throw new ImageInterpretationError('Invalid local image response contract');
 const value=parsed.data;
 if(value.operationId!==request.operationId||value.captureId!==request.captureId||value.originalSha256!==request.image.imageView.original.sha256||value.imageViewId!==request.image.imageView.viewId)throw new ImageInterpretationError('Local image response does not match the requested original and view');
 return value;
}
