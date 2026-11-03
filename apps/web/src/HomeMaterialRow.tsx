import {useEffect,useRef,useState,type RefObject} from 'react';
import {ChevronRight,FileText} from 'lucide-react';
import {dateTime,type Api} from './api';
import type {Material} from './Materials';
import {sourceDisplay} from './material-presentation';
import {useMaterialPreview} from './plugins/home/material-reads';

export type RecentMaterial=Material&{createdAt:string;updatedAt:string;origin:Material['origin']&{firstAt?:string;lastAt?:string;deviceId?:string}};
export {useMaterialPreview};

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
