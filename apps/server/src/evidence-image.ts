import type {Store} from './store.js';
import {StoreError} from './store.js';
import type {FileStore} from './files.js';
import type {ArchivedFileStore} from './archived-files.js';
import {FileRawReader,fileOriginalRawRef,archivedOriginalRawRef} from './file-raw-reader.js';
import {MAX_RAW_READ_BYTES} from './raw-reader.js';
import sharp from 'sharp';

const MAX_IMAGE_BYTES=8*1024*1024;
const imageTypes=new Set(['image/png','image/jpeg','image/webp']);

/** Read an exact original under the parent evidence grant. A referenced archive
 * ID alone is not authority: both the source declaration and saved link must
 * still exist. This reader never fetches paths/URLs or schedules processing. */
export async function readEvidenceImage(store:Store,files:FileStore|undefined,archived:ArchivedFileStore,
  input:{id:string;attachmentId?:string},authorize:()=>boolean){
  const denied=()=>new StoreError('Image not found in authorized evidence',404);
  const permitted=()=>{try{return authorize()===true;}catch{return false;}};
  if(!permitted())throw denied();
  const attached=(id:string)=>Boolean(store.db.prepare(`SELECT 1 FROM capture_files f JOIN captures c ON c.id=f.capture_id
    WHERE f.capture_id=? AND f.file_id=? AND EXISTS(SELECT 1 FROM json_each(c.json,'$.provenance.document.attachments') a
      WHERE json_extract(a.value,'$.id')=f.file_id)`).get(input.id,id));
  let ref:string,mimeType:string,sizeBytes:number;
  if(input.attachmentId!==undefined){
    if(!/^[0-9a-f-]{36}$/.test(input.attachmentId)||!attached(input.attachmentId))throw denied();
    const file=archived.get(input.attachmentId);ref=archivedOriginalRawRef(file.id,file.hash);mimeType=file.mimeType;sizeBytes=file.sizeBytes;
  }else{
    const version=store.db.prepare('SELECT object_hash,manifest FROM file_versions WHERE capture_id=?').get(input.id);
    if(version?.object_hash){
      const manifest=JSON.parse(String(version.manifest));ref=fileOriginalRawRef(input.id,String(version.object_hash));mimeType=manifest.item.mimeType;sizeBytes=manifest.sizeBytes;
    }else{
      const image=store.db.prepare('SELECT blob_hash,mime FROM captures WHERE id=?').get(input.id);
      if(!image?.blob_hash)throw denied();
      sizeBytes=store.assets.get(String(image.blob_hash)).bytes;mimeType=String(image.mime);
      validateImage(mimeType,sizeBytes);const value=await imageOutput(store.image(input.id).bytes,mimeType);if(!permitted())throw denied();
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
  const value=await imageOutput(Buffer.concat(parts),mimeType);
  if(!permitted()||input.attachmentId!==undefined&&!attached(input.attachmentId))throw denied();
  return value;
}
function validateImage(mimeType:string,sizeBytes:number){
  if(!imageTypes.has(mimeType)&&mimeType!=='application/octet-stream')throw new StoreError('Evidence is not a supported image',415);
  if(!Number.isSafeInteger(sizeBytes)||sizeBytes<1||sizeBytes>MAX_IMAGE_BYTES)throw new StoreError('Image disclosure size limit exceeded',413);
}
async function imageOutput(bytes:Buffer,declaredMime:string){
 // ZIP members need not carry a MIME declaration. Decode the actual bounded
 // original instead of trusting a filename or changing archived metadata.
 let format:string|undefined;
 try{format=(await sharp(bytes,{limitInputPixels:40_000_000}).metadata()).format;}catch{throw new StoreError('Evidence is not a supported image',415);}
 const mimeType=format==='png'?'image/png':format==='jpeg'?'image/jpeg':format==='webp'?'image/webp':undefined;
 if(!mimeType||declaredMime!=='application/octet-stream'&&declaredMime!==mimeType)throw new StoreError('Image format does not match its declaration',415);
 return {mimeType,data:bytes.toString('base64')};
}
