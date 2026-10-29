import {useEffect,useState} from 'react';
import {ChevronRight,FileText} from 'lucide-react';
import {moteText} from '@mote/shared/i18n';
import {dateTime,type Api} from './api';
import type {Material} from './Materials';
import {materialKind,sourceDisplay} from './material-presentation';
import {useResource} from './useResource';

export type RecentMaterial=Material&{createdAt:string;updatedAt:string;origin:Material['origin']&{firstAt?:string;lastAt?:string;deviceId?:string}};
type OriginalFile={hasOriginal:boolean;sizeBytes:number;item:{mimeType?:string}};
const previewLimit=8*1024*1024;

/** Preview only a retained, bounded original from this material's exact membership. */
export function HomeMaterialRow({api,item,label,deviceName,onOpen,canRead,canPreview}:{api:Api;item:RecentMaterial;label?:string;deviceName?:string;onOpen:(ref:string)=>void;canRead:boolean;canPreview:boolean}){
 const preview=useResource<{text:string}>(api,canRead&&item.textLength>0?`/api/materials/${encodeURIComponent(item.id)}/read?revision=${encodeURIComponent(item.revision)}&offset=0&length=240`:null);
 const members=useResource<{items:{kind:string;ref:string}[]}>(api,canPreview&&item.kind==='mote.file'?`/api/materials/${encodeURIComponent(item.id)}/members?revision=${encodeURIComponent(item.revision)}&offset=0&limit=1`:null);
 const capture=members.error===undefined?members.data?.items.find(member=>member.kind==='capture'&&/^capture:[a-f0-9-]{36}$/i.test(member.ref))?.ref.slice(8):undefined;
 const file=useResource<OriginalFile>(api,capture?`/api/files/${encodeURIComponent(capture)}`:null);
 const original=file.error===undefined?file.data:undefined;
 const mime=original?.item.mimeType;
 const imageFile=Boolean(mime&&['image/png','image/jpeg','image/webp','image/gif'].includes(mime));
 const kindLabel=imageFile?moteText('图片'):mime?.startsWith('text/')?moteText('文档'):mime?.startsWith('audio/')?moteText('音频'):materialKind(item.kind);
 const [image,setImage]=useState<string>();
 useEffect(()=>{
  setImage(undefined);
  if(!capture||!imageFile||!original?.hasOriginal||!Number.isSafeInteger(original.sizeBytes)||original.sizeBytes<=0||original.sizeBytes>previewLimit)return;
  const controller=new AbortController();let objectUrl:string|undefined;
  void api.raw(`/api/files/${encodeURIComponent(capture)}/content`,{signal:controller.signal}).then(async response=>{
   const bytes=await response.arrayBuffer();
   if(controller.signal.aborted||bytes.byteLength!==original.sizeBytes||bytes.byteLength>previewLimit)return;
   objectUrl=URL.createObjectURL(new Blob([bytes],{type:mime}));setImage(objectUrl);
  }).catch(()=>{/* The original remains available through the ordinary reader. */});
  return()=>{controller.abort();if(objectUrl)URL.revokeObjectURL(objectUrl);};
 },[api,capture,imageFile,mime,original?.hasOriginal,original?.sizeBytes]);
 const at=item.origin.lastAt??item.origin.firstAt??item.updatedAt,source=sourceDisplay(item.origin.sourceId,label);
 return <button className="home-material-row" onClick={()=>onOpen(item.ref)}>
  <span className="home-material-icon">{image?<img src={image} alt="" onError={()=>setImage(undefined)}/>:<FileText size={18}/>}</span>
  <span className="home-material-copy"><strong>{item.title}</strong><small>{kindLabel} · {source}{deviceName&&deviceName!==source?' · '+deviceName:''}</small>{preview.error===undefined&&preview.data?.text&&<span className="home-material-excerpt">{preview.data.text}</span>}</span>
  {at&&<time dateTime={at}>{dateTime(at,{hour:'2-digit',minute:'2-digit',hour12:false})}</time>}<ChevronRight size={14}/>
 </button>;
}
