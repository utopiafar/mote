import {ChevronRight,FileText} from 'lucide-react';
import {moteText} from '@mote/shared/i18n';
import type {CapturePreview,LibrarySourceFacet,LibraryTypeDescriptor} from '@mote/shared';
import {dateTime} from '../../api';
import type {Material} from '../../Materials';
export type OwnerBrowseEntry={entryType:'material';ref:string;contentAt:string;material:Material}|{entryType:'capture';ref:string;contentAt:string;revision:string;capture:CapturePreview};
export type OwnerBrowsePage={schemaVersion:1;revision:string;types:LibraryTypeDescriptor[];sources:LibrarySourceFacet[];sourcesTruncated:boolean;noteOrigin:{origin:'notes';label:string;count?:number};items:OwnerBrowseEntry[];nextCursor:string|null};
export function OriginalNoteRow({entry,onOpen,home=false}:{entry:Extract<OwnerBrowseEntry,{entryType:'capture'}>;onOpen:(ref:string)=>void;home?:boolean}){
 const value=entry.capture,title=value.windowTitle||value.textPreview?.split('\n')[0]?.slice(0,100)||moteText('记录');
 return <button className={home?'home-material-row original-note-row':'library-record original-note-row'} data-reference={entry.ref} onClick={()=>onOpen(entry.ref)}><span className={home?'home-material-icon':'library-record-icon'}><FileText size={18}/></span><span className={home?'home-material-copy':'library-record-copy'}><strong>{title}</strong><small>{moteText('记录')} · {value.deviceName}</small>{value.textPreview&&<span className={home?'home-material-excerpt':'library-record-preview'}>{value.textPreview}</span>}</span><span className="library-record-trailing"><time dateTime={entry.contentAt}>{dateTime(entry.contentAt,{hour:'2-digit',minute:'2-digit',hour12:false})}</time><ChevronRight size={14}/></span></button>;
}
