import {createHash} from 'node:crypto';
import {z} from 'zod';
import {captureSchema,type CaptureInput} from '@mote/shared';

const image=z.object({hash:z.string().regex(/^[a-f0-9]{64}$/),mime:z.enum(['image/jpeg','image/png','image/webp'])}).strict();
export type StoredCapture=Omit<CaptureInput,'imageBase64'|'imageMime'>&{originalImage?:z.infer<typeof image>;ingressSourceId?:string};
/** Raw screenshot bytes live only in M03's original store. The canonical record
 * retains immutable input identity without duplicating temporary originals in
 * SQLite or personal data exports. Requests cannot supply this internal field. */
export function storeCapture(input:CaptureInput):StoredCapture{
 const {imageBase64,imageMime,...record}=input;
 return {...record,...(imageBase64?{originalImage:{hash:createHash('sha256').update(Buffer.from(imageBase64,'base64')).digest('hex'),mime:imageMime!}}:{})};
}
export const storedCaptureSchema=z.unknown().transform((raw):StoredCapture=>{
 if(!raw||typeof raw!=='object'||Array.isArray(raw))return storeCapture(captureSchema.parse(raw));
 const {originalImage,ingressSourceId,...record}=raw as Record<string,unknown>;
 const binding=ingressSourceId===undefined?{}:{ingressSourceId:z.string().regex(/^[a-zA-Z0-9_.:-]{1,128}$/).parse(ingressSourceId)};
 if(originalImage===undefined)return {...storeCapture(captureSchema.parse(record)),...binding};
 const descriptor=image.parse(originalImage);
 // Validate all original capture invariants using an inert nonempty image.
 // The descriptor itself cannot grant access to those bytes.
 if('imageBase64' in record||'imageMime' in record)throw new Error('Invalid stored capture');
 const parsed=captureSchema.parse({...record,imageBase64:'AA==',imageMime:descriptor.mime});
 const {imageBase64:_,imageMime:__,...value}=parsed;return {...value,originalImage:descriptor,...binding};
});
