import {z} from 'zod';
import {imageViewSchema,type ImageView,type QueryResult} from '@mote/shared';

const digest=z.string().regex(/^[a-f0-9]{64}$/);
/** A model can select a delivered view; only the host supplies its complete proof. */
export const memoryImageSelectorSchema=z.object({originalSha256:digest,viewId:digest}).strict();
const receiptSchema=z.object({id:z.string().uuid(),imageView:imageViewSchema}).strict();
export type MemoryImageReadReceipt=z.infer<typeof receiptSchema>;
export const MEMORY_VISUAL_REVIEW_COVERAGE_CONTRACT='For each original-image anchor and hash still cited in the reviewed output, every draft-cited view requires a covering view that this review both received and cites in evidence.image. Reading a full image but citing only a noncovering crop does not satisfy this rule. Cite a delivered full view when needed; separate crops may cover separate draft views but cannot be stitched to cover one view. Uncited draft reads add no coverage requirement. Discarding all visual claims for a group removes its coverage requirement.';
export const MEMORY_VISUAL_EVIDENCE_CONTRACT='The host may supply authorized original-image locators alongside text ranges. A locator and a model interpretation are navigation, not original words or pixels already inspected. A selected original-image target (imageTarget) requires complete original pixel delivery before successful coverage; OCR/text targets assess only their supplied text. For context-only image grants use read_image only when visual content is necessary to assess a target or verify a claim. Stay within the host image grant. After confirmed pixel delivery, a visual evidence entry is {id:"the authorized original-image anchor UUID",image:{originalSha256:"the original hash returned by the host",viewId:"the delivered viewId"}} instead of a text quote. Never quote locator JSON or a model interpretation as original image content. OCR-supported claims use exact OCR text quotes and preserve recognition uncertainty. An independent reviewer must obtain its own necessary pixels; the draft and its image view metadata do not prove a reviewer read the image. If an image-dependent target cannot be assessed, report incomplete with the specific missing proof, not no_candidates. Do not manufacture author identity, dates or ownership from a screenshot. '+MEMORY_VISUAL_REVIEW_COVERAGE_CONTRACT;

/** Read only runner metadata, never a field inside the model's answer JSON. */
export function memoryImageReadReceipts(result:QueryResult):MemoryImageReadReceipt[]{
 const raw=(result as QueryResult&{imageReadReceipts?:unknown}).imageReadReceipts;
 if(raw===undefined)return [];
 const receipts=z.array(receiptSchema).parse(raw);
 if(receipts.some(receipt=>!receipt.imageView.output||receipt.imageView.transform==='metadata@1'))throw new Error('Memory image proof requires delivered pixels');
 return receipts;
}

export function hasMemoryImageProof(receipts:readonly MemoryImageReadReceipt[],span:{id?:unknown;image?:unknown}):boolean{
 const selector=memoryImageSelectorSchema.safeParse(span.image);
 return selector.success&&receipts.some(receipt=>receipt.id===span.id&&receipt.imageView.original.sha256===selector.data.originalSha256&&receipt.imageView.viewId===selector.data.viewId);
}

export function imageViewCovers(view:ImageView,required:ImageView):boolean{
 if(!view.output||view.transform==='metadata@1'||view.original.sha256!==required.original.sha256||view.original.width!==required.original.width||view.original.height!==required.original.height||view.original.orientation!==required.original.orientation||view.original.pages!==required.original.pages||view.original.mimeType!==required.original.mimeType||view.coordinateSpace!==required.coordinateSpace)return false;
 if(view.region===null)return true;
 if(required.region===null)return false;
 return view.region.x<=required.region.x&&view.region.y<=required.region.y&&view.region.x+view.region.width>=required.region.x+required.region.width&&view.region.y+view.region.height>=required.region.y+required.region.height;
}
