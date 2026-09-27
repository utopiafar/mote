import {z} from 'zod';

export const IMAGE_MAX_BYTES=8*1024*1024;
export const IMAGE_MAX_PIXELS=40_000_000;
export const IMAGE_REGION_MAX_SIDE=2048;
export const imageRegionSchema=z.object({x:z.number().int().nonnegative().max(IMAGE_MAX_PIXELS),y:z.number().int().nonnegative().max(IMAGE_MAX_PIXELS),width:z.number().int().positive().max(IMAGE_REGION_MAX_SIDE),height:z.number().int().positive().max(IMAGE_REGION_MAX_SIDE)}).strict();
const digest=z.string().regex(/^[a-f0-9]{64}$/);
const mime=z.enum(['image/png','image/jpeg','image/webp']);
export const imageReadSchema=z.object({id:z.string().min(1).max(200),attachmentId:z.string().min(1).max(200).optional(),view:z.enum(['image','metadata']).optional(),expectedImageSha256:digest.optional(),region:imageRegionSchema.optional()}).strict().superRefine((value,ctx)=>{
 if(value.region&&(value.view==='metadata'||!value.expectedImageSha256))ctx.addIssue({code:'custom',message:'A region requires expectedImageSha256 and image view'});
});
export const imageViewSchema=z.object({
 original:z.object({sha256:digest,width:z.number().int().positive().max(IMAGE_MAX_PIXELS),height:z.number().int().positive().max(IMAGE_MAX_PIXELS),mimeType:mime,orientation:z.number().int().min(1).max(8),pages:z.number().int().positive()}).strict(),
 coordinateSpace:z.literal('encoded-raster-pixels-v1'),region:imageRegionSchema.nullable(),
 transform:z.enum(['original-bytes@1','crop-encoded-raster-png@1','metadata@1']),viewId:digest,
 output:z.object({sha256:digest,width:z.number().int().positive(),height:z.number().int().positive(),mimeType:mime,sizeBytes:z.number().int().positive().max(IMAGE_MAX_BYTES)}).strict().optional(),
}).strict().refine(value=>value.original.width*value.original.height<=IMAGE_MAX_PIXELS,'Original decoded pixel limit exceeded');
export type ImageReadInput=z.infer<typeof imageReadSchema>;
export type ImageView=z.infer<typeof imageViewSchema>;
/** A view identifies delivered pixels, never an independent citation or grant. */
export type ImageViewTrace=ImageView&{id:string;attachmentId?:string;delivery:'metadata'|'pending'|'prepared'|'failed'|'already_disclosed'};
export type ImageReadResult={mimeType:string;data?:string;imageView?:ImageView};
