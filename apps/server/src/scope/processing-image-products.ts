import {createHash} from 'node:crypto';
import {z} from 'zod';
import {transcriptSchema,diarizationSchema,type Transcript} from '@mote/shared';
import {imageInterpretationSchema} from '../image-recipes.js';
import {processingInputSchema} from './processing-schema.js';

const hash=z.string().regex(/^[a-f0-9]{64}$/),name=z.string().regex(/^[a-z][a-z0-9.-]{0,63}$/),component=z.object({id:z.string().regex(/^[a-z][a-z0-9.-]{2,127}$/),version:z.string().min(1).max(128)}).strict();
export const imageProductSchema=z.object({format:z.literal('mote-image-product-v1'),interpretation:imageInterpretationSchema,original:z.object({sha256:hash,width:z.number().int().positive(),height:z.number().int().positive(),mime:z.string().regex(/^image\//)}).strict()}).strict().superRefine((value,ctx)=>{if(value.interpretation.regions.some(region=>region.x+region.width>value.original.width||region.y+region.height>value.original.height))ctx.addIssue({code:'custom',message:'Image region outside original'});});
export type ImageProduct=z.infer<typeof imageProductSchema>;
export const processingArtifactSchema=z.union([transcriptSchema,diarizationSchema,imageProductSchema]);
export const imageRecipeInputSchema=processingInputSchema.extend({imageStep:z.object({recipe:component,fingerprint:hash,name,dependencies:z.record(hash)}).strict()}).strict();
export type ImageRecipeInput=z.infer<typeof imageRecipeInputSchema>;
export const imageUnderstandingInputSchema=processingInputSchema.extend({ocrArtifactId:hash.optional()}).strict();
export const imageStepKey=(planId:string,fingerprint:string,stepName:string,dependencies?:Readonly<Record<string,string>>)=>'image:'+planId+':'+fingerprint+':'+stepName+(dependencies?':'+createHash('sha256').update(JSON.stringify(Object.entries(dependencies).sort(([a],[b])=>a.localeCompare(b)))).digest('hex'):'');
export const imageStepKeySchema=z.string().regex(/^image:[a-f0-9]{64}:[a-f0-9]{64}:[a-z][a-z0-9.-]{0,63}(?::[a-f0-9]{64})?$/);
export const imageDerivationKind=z.string().regex(/^image(?:-ocr)?:[a-z][a-z0-9.-]{0,63}$/);
/** Display/publication view only. The exact interpretation including empty
 * region descriptions remains in the immutable typed product, never as OCR. */
export function imageProductTranscript(value:ImageProduct):Transcript{
 const segments:Transcript['segments']=[];for(let offset=0;offset<value.interpretation.text.length;){let end=Math.min(value.interpretation.text.length,offset+4000);if(end<value.interpretation.text.length&&/[\uD800-\uDBFF]/.test(value.interpretation.text[end-1]))end--;segments.push({startMs:0,endMs:0,text:value.interpretation.text.slice(offset,end)});offset=end;}
 for(const region of value.interpretation.regions)if(region.description)segments.push({startMs:0,endMs:0,text:region.description,imageLocation:{width:value.original.width,height:value.original.height,polygon:[[region.x,region.y],[region.x+region.width,region.y],[region.x+region.width,region.y+region.height],[region.x,region.y+region.height]]}});
 return transcriptSchema.parse({durationMs:0,segments,engine:'mote-image-interpretation-v1',coverage:'full'});
}
