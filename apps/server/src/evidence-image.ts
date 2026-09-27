import type {Store} from './store.js';
import {StoreError} from './store.js';
import type {FileStore} from './files.js';
import type {ArchivedFileStore} from './archived-files.js';
import {FileRawReader,fileOriginalRawRef,archivedOriginalRawRef} from './file-raw-reader.js';
import {MAX_RAW_READ_BYTES} from './raw-reader.js';
import sharp from 'sharp';
import {createHash} from 'node:crypto';
import {ContextToolError} from '@mote/agent';
import {imageReadSchema,IMAGE_MAX_BYTES,IMAGE_MAX_PIXELS,IMAGE_REGION_MAX_SIDE,type ImageReadInput,type ImageReadResult,type ImageView} from '@mote/shared';

const MAX_IMAGE_BYTES=IMAGE_MAX_BYTES;
const imageTypes=new Set(['image/png','image/jpeg','image/webp']);

/** Read an exact original under the parent evidence grant. A referenced archive
 * ID alone is not authority: both the source declaration and saved link must
 * still exist. This reader never fetches paths/URLs or schedules processing. */
export async function readEvidenceImage(store:Store,files:FileStore|undefined,archived:ArchivedFileStore,
  input:ImageReadInput,authorize:()=>boolean){
  const denied=()=>new StoreError('Image not found in authorized evidence',404);
  let currentOriginal=()=>true;
  const permitted=()=>{try{return authorize()===true&&currentOriginal();}catch{return false;}};
  if(!permitted())throw denied();
  const attached=(id:string)=>Boolean(store.db.prepare(`SELECT 1 FROM capture_files f JOIN captures c ON c.id=f.capture_id
    WHERE f.capture_id=? AND f.file_id=? AND EXISTS(SELECT 1 FROM json_each(c.json,'$.provenance.document.attachments') a
      WHERE json_extract(a.value,'$.id')=f.file_id)`).get(input.id,id));
  let ref:string,mimeType:string,sizeBytes:number;
  if(input.attachmentId!==undefined){
    if(!/^[0-9a-f-]{36}$/.test(input.attachmentId)||!attached(input.attachmentId))throw denied();
    const file=archived.get(input.attachmentId);currentOriginal=()=>archived.get(file.id).hash===file.hash&&attached(file.id);ref=archivedOriginalRawRef(file.id,file.hash);mimeType=file.mimeType;sizeBytes=file.sizeBytes;
  }else{
    const version=store.db.prepare('SELECT object_hash,manifest FROM file_versions WHERE capture_id=?').get(input.id);
    if(version?.object_hash){
      currentOriginal=()=>store.db.prepare('SELECT object_hash FROM file_versions WHERE capture_id=?').get(input.id)?.object_hash===version.object_hash;
      const manifest=JSON.parse(String(version.manifest));ref=fileOriginalRawRef(input.id,String(version.object_hash));mimeType=manifest.item.mimeType;sizeBytes=manifest.sizeBytes;
    }else{
      const image=store.db.prepare('SELECT blob_hash,mime FROM captures WHERE id=?').get(input.id);
      if(!image?.blob_hash)throw denied();
      currentOriginal=()=>store.db.prepare('SELECT blob_hash FROM captures WHERE id=?').get(input.id)?.blob_hash===image.blob_hash;
      sizeBytes=store.assets.get(String(image.blob_hash)).bytes;mimeType=String(image.mime);
      validateImage(mimeType,sizeBytes);const value=await imageOutput(store.image(input.id).bytes,mimeType,input,permitted);if(!permitted())throw denied();
      return value;
    }
  }
  validateImage(mimeType,sizeBytes);
  // The archive branch does not use FileStore, but FileRawReader also supports
  // normal uploaded files, so both paths share byte/range/hash validation.
  if(!files)throw denied();
  const reader=new FileRawReader(store,files,archived,{
    mayReadFileVersion:(_source,id)=>id===input.id&&input.attachmentId===undefined&&permitted(),
    mayReadArchivedFile:id=>id===input.attachmentId&&attached(id)&&permitted(),
    mayListSourceFiles:()=>false,mayListArchivedFiles:()=>false,
  });
  const parts:Buffer[]=[];
  for(let offset=0;offset<sizeBytes;){
    const page=await reader.read(ref,{offset,length:Math.min(MAX_RAW_READ_BYTES,sizeBytes-offset)});
    if(page.status!=='available'||page.totalBytes!==sizeBytes||page.mediaType!==mimeType||!page.bytes.length)throw denied();
    parts.push(Buffer.from(page.bytes));offset+=page.bytes.length;
  }
  const value=await imageOutput(Buffer.concat(parts),mimeType,input,()=>permitted()&&(input.attachmentId===undefined||attached(input.attachmentId)));
  if(!permitted()||input.attachmentId!==undefined&&!attached(input.attachmentId))throw denied();
  return value;
}
function validateImage(mimeType:string,sizeBytes:number){
  if(!imageTypes.has(mimeType)&&mimeType!=='application/octet-stream')throw new StoreError('Evidence is not a supported image',415);
  if(!Number.isSafeInteger(sizeBytes)||sizeBytes<1||sizeBytes>MAX_IMAGE_BYTES)throw new StoreError('Image disclosure size limit exceeded',413);
}
/** libvips does not expose APNG pages. Count the bounded PNG animation header
 * rather than silently cropping its default frame. This is file structure only. */
function pngPages(bytes:Buffer){
 let offset=8,pages=1,animation=false,frames=0;
 const invalid=()=>new StoreError('Evidence is not a supported image: invalid PNG frame structure',415);
 while(offset+12<=bytes.length){
  const length=bytes.readUInt32BE(offset),end=offset+12+length;if(end>bytes.length)throw invalid();
  const kind=bytes.toString('ascii',offset+4,offset+8);
  if(kind==='acTL'){if(animation||length!==8)throw invalid();pages=bytes.readUInt32BE(offset+8);if(!pages)throw invalid();animation=true;}
  if(kind==='fcTL'){if(length!==26)throw invalid();frames++;}
  if(kind==='IEND')return Math.max(pages,frames);
  offset=end;
 }
 throw invalid();
}
/** Decode/crop under the caller's original grant. No OCR, orientation inference,
 * persistence or provider-specific image API. The metadata path returns no bytes. */
export async function imageOutput(bytes:Buffer,declaredMime:string,input:ImageReadInput,authorize:()=>boolean):Promise<ImageReadResult> {
 const permitted=()=>{try{return authorize()===true;}catch{return false;}};
 const denied=()=>new ContextToolError('image_unavailable','The image is no longer available in the authorized scope.','use_existing_evidence');
 if(!permitted())throw denied();
 const parsed=imageReadSchema.safeParse(input);
 if(!parsed.success)throw new ContextToolError('invalid_image_region','Use integer original pixel coordinates; a region requires expectedImageSha256 and each side must be 1–2048.','correct_arguments',{maxRegionSide:IMAGE_REGION_MAX_SIDE});
 validateImage(declaredMime,bytes.length);
 let metadata:Awaited<ReturnType<ReturnType<typeof sharp>['metadata']>>;
 try{metadata=await sharp(bytes,{limitInputPixels:IMAGE_MAX_PIXELS}).metadata();}catch{if(!permitted())throw denied();throw new StoreError('Evidence is not a supported image',415);}
 if(!permitted())throw denied();
 const mimeType:ImageView['original']['mimeType']|undefined=metadata.format==='png'?'image/png':metadata.format==='jpeg'?'image/jpeg':metadata.format==='webp'?'image/webp':undefined;
 if(!mimeType||declaredMime!=='application/octet-stream'&&declaredMime!==mimeType)throw new StoreError('Image format does not match its declaration',415);
 const width=metadata.width!,height=metadata.height!,sha256=createHash('sha256').update(bytes).digest('hex');
 if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<1||height<1||width*height>IMAGE_MAX_PIXELS)throw new StoreError('Image dimensions unsupported',413);
 if(input.expectedImageSha256&&input.expectedImageSha256!==sha256)throw new ContextToolError('image_version_changed','The original image does not match expectedImageSha256. Read metadata again before selecting a region.','correct_arguments');
 const original={sha256,width,height,mimeType,orientation:metadata.orientation??1,pages:metadata.format==='png'?pngPages(bytes):metadata.pages??1};
 const region=input.region??null,transform=input.view==='metadata'?'metadata@1':region?'crop-encoded-raster-png@1':'original-bytes@1';
 const imageView:ImageView={original,coordinateSpace:'encoded-raster-pixels-v1',region,transform,viewId:createHash('sha256').update(JSON.stringify([sha256,'encoded-raster-pixels-v1',region,transform])).digest('hex')};
 if(input.view==='metadata')return {mimeType,imageView};
 let output=bytes,outputMime=mimeType;
 if(region){
  if(original.pages!==1)throw new ContextToolError('image_region_multiframe','Regions of multi-frame images are not supported. Use the original image or existing evidence.','use_existing_evidence');
  if(region.x+region.width>width||region.y+region.height>height)throw new ContextToolError('invalid_image_region','The region must fit entirely within the original encoded raster.','correct_arguments',{width,height,maxRegionSide:IMAGE_REGION_MAX_SIDE});
  try{output=await sharp(bytes,{limitInputPixels:IMAGE_MAX_PIXELS}).extract({left:region.x,top:region.y,width:region.width,height:region.height}).toColourspace('srgb').png().toBuffer();}
  catch{if(!permitted())throw denied();throw new ContextToolError('image_decode_failed','The selected image region could not be decoded. Use available evidence.','use_existing_evidence');}
  outputMime='image/png';
 }
 if(!permitted())throw denied();
 if(output.length>IMAGE_MAX_BYTES)throw new ContextToolError('image_output_too_large','The selected image exceeds the output byte limit. Choose a smaller region.','correct_arguments',{maxOutputBytes:IMAGE_MAX_BYTES});
 imageView.output={sha256:createHash('sha256').update(output).digest('hex'),width:region?.width??width,height:region?.height??height,mimeType:outputMime,sizeBytes:output.length};
 return {mimeType:outputMime,data:output.toString('base64'),imageView};
}
