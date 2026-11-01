import {featureRequirementsAvailable,type FeatureInventory} from '@mote/shared';
import {sourceMaterialExcerpt} from './material-source-preview';
import {useEffect,useRef,useState,type RefObject} from 'react';
import {ChevronRight,FileText} from 'lucide-react';
import {moteText} from '@mote/shared/i18n';
import {dateTime,type Api} from './api';
import type {Material} from './Materials';
import {materialKind,sourceDisplay} from './material-presentation';
import {materialTextExcerpt,type MaterialExcerpt} from './material-preview-text';
import {useResource} from './useResource';

export type RecentMaterial=Material&{createdAt:string;updatedAt:string;origin:Material['origin']&{firstAt?:string;lastAt?:string;deviceId?:string}};
type OriginalFile={hasOriginal:boolean;sizeBytes:number;item:{mimeType?:string}};
const thumbnailLimit=4;
let thumbnailActive=0;
const thumbnailPending:{signal:AbortSignal;job:()=>Promise<void>}[]=[];
function thumbnailPump(){
 while(thumbnailActive<thumbnailLimit){
  const next=thumbnailPending.shift();
  if(!next)break;
  if(next.signal.aborted)continue;
  thumbnailActive++;
  void next.job().catch(()=>{/* A missing thumbnail keeps the type icon. */}).finally(()=>{thumbnailActive--;thumbnailPump();});
 }
}
/** Thumbnail fetches share one module gate; queued work is dropped when its row goes away. */
function enqueueThumbnail(signal:AbortSignal,job:()=>Promise<void>){
 if(signal.aborted)return;
 const task={signal,job};
 signal.addEventListener('abort',()=>{const index=thumbnailPending.indexOf(task);if(index>=0)thumbnailPending.splice(index,1);},{once:true});
 thumbnailPending.push(task);
 thumbnailPump();
}

/** Rows beyond the margin stay unread; without IntersectionObserver every row is near. */
export function useNearViewport(ref:RefObject<Element|null>,margin='200px'){
 const [near,setNear]=useState(()=>typeof IntersectionObserver==='undefined');
 useEffect(()=>{
  const element=ref.current;
  if(!element||typeof IntersectionObserver==='undefined'){setNear(true);return;}
  const observer=new IntersectionObserver(entries=>setNear(entries.some(entry=>entry.isIntersecting)),{rootMargin:margin});
  observer.observe(element);
  return()=>observer.disconnect();
 },[ref,margin]);
 return near;
}

/** Preview only a retained, bounded original from this material's exact membership. */
export function useMaterialPreview(api:Api,item:Material,canRead:boolean,canPreview:boolean,near:boolean){
 const inventory=useResource<FeatureInventory>(api,canRead&&item.kind==='mote.file'?'/api/features':null,5000);
 const sourceView=canRead&&item.kind==='mote.file'&&inventory.error===undefined&&featureRequirementsAvailable(['http:GET:/api/materials/:id/source-view'],inventory.data);
 const thumbnails=inventory.error===undefined&&featureRequirementsAvailable(['http:GET:/api/files/:id/thumbnail'],inventory.data);
 const [source,setSource]=useState<{api:Api;ref:string;text?:string}>();
 useEffect(()=>{if(!near||!sourceView||item.textLength<=0)return;const controller=new AbortController();void sourceMaterialExcerpt(api,item,controller.signal).then(text=>{if(!controller.signal.aborted)setSource({api,ref:item.ref,text});}).catch(()=>{if(!controller.signal.aborted)setSource({api,ref:item.ref});});return()=>controller.abort();},[api,item.ref,sourceView,item.textLength,near]);
 const preview=useResource<MaterialExcerpt&{material?:{ref:string}}>(api,canRead&&near&&!sourceView&&item.textLength>0?`/api/materials/${encodeURIComponent(item.id)}/read?revision=${encodeURIComponent(item.revision)}&offset=0&length=240`:null);
 const members=useResource<{items:{kind:string;ref:string}[]}>(api,canPreview&&near&&item.kind==='mote.file'?`/api/materials/${encodeURIComponent(item.id)}/members?revision=${encodeURIComponent(item.revision)}&offset=0&limit=1`:null);
 const capture=members.error===undefined?members.data?.items.find(member=>member.kind==='capture'&&/^capture:[a-f0-9-]{36}$/i.test(member.ref))?.ref.slice(8):undefined;
 const file=useResource<OriginalFile>(api,capture?`/api/files/${encodeURIComponent(capture)}`:null);
 const original=file.error===undefined?file.data:undefined;
 const mime=original?.item.mimeType;
 const imageFile=Boolean(mime&&['image/png','image/jpeg','image/webp','image/gif'].includes(mime));
 const kindLabel=imageFile?moteText('图片'):mime?.startsWith('text/')?moteText('文档'):mime?.startsWith('audio/')?moteText('音频'):materialKind(item.kind);
 const [image,setImage]=useState<{api:Api;ref:string;capture:string;url:string}>();
 useEffect(()=>{
  setImage(undefined);
  if(!capture||!imageFile||!thumbnails||!near||!original?.hasOriginal)return;
  const controller=new AbortController();let objectUrl:string|undefined;
  enqueueThumbnail(controller.signal,async()=>{
   const response=await api.raw(`/api/files/${encodeURIComponent(capture)}/thumbnail`,{signal:controller.signal});
   if(controller.signal.aborted)return;
   const blob=await response.blob();
   if(controller.signal.aborted)return;
   objectUrl=URL.createObjectURL(blob);setImage({api,ref:item.ref,capture,url:objectUrl});
  });
  return()=>{controller.abort();if(objectUrl)URL.revokeObjectURL(objectUrl);};
 },[api,item.ref,capture,imageFile,thumbnails,near,original?.hasOriginal]);
 const visibleImage=canPreview&&near&&imageFile&&original?.hasOriginal&&image?.api===api&&image.ref===item.ref&&image.capture===capture?image.url:undefined;
 const value=preview.error===undefined?preview.data:undefined;
 const text=sourceView?source?.api===api&&source.ref===item.ref?source.text:undefined:item.kind==='mote.note'?value?.material?.ref===item.ref?materialTextExcerpt(value):undefined:item.kind==='mote.file'?value?.material?.ref===item.ref?materialTextExcerpt({...value,spans:value.spans?.filter(span=>span.format==='plain'||span.format==='transcript')}):undefined:value?.text;
 return {image:visibleImage,clearImage:()=>setImage(undefined),kindLabel,text};
}
export function HomeMaterialRow({api,item,label,deviceName,onOpen,canRead,canPreview}:{api:Api;item:RecentMaterial;label?:string;deviceName?:string;onOpen:(ref:string)=>void;canRead:boolean;canPreview:boolean}){
 const rowRef=useRef<HTMLButtonElement>(null),near=useNearViewport(rowRef);
 const {image,clearImage,kindLabel,text}=useMaterialPreview(api,item,canRead,canPreview,near);
 const at=item.origin.lastAt??item.origin.firstAt??item.updatedAt,source=sourceDisplay(item.origin.sourceId,label);
 return <button ref={rowRef} className="home-material-row" onClick={()=>onOpen(item.ref)}>
  <span className="home-material-icon">{image?<img src={image} alt="" onError={clearImage}/>:<FileText size={18}/>}</span>
  <span className="home-material-copy"><strong>{item.title}</strong><small>{kindLabel} · {source}{deviceName&&deviceName!==source?' · '+deviceName:''}</small>{text&&<span className="home-material-excerpt">{text}</span>}</span>
  {at&&<time dateTime={at}>{dateTime(at,{hour:'2-digit',minute:'2-digit',hour12:false})}</time>}<ChevronRight size={14}/>
 </button>;
}
