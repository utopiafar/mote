import {useEffect,useState,type ReactNode} from 'react';

/** Open a requested setup section once per accepted query change; polling must not reopen it. */
export function RequestedDetails({requested,children,className}:{requested:boolean;children:ReactNode;className?:string}){
 const [open,setOpen]=useState(requested);
 useEffect(()=>setOpen(requested),[requested]);
 return <details className={className} open={open} onToggle={event=>setOpen(event.currentTarget.open)}>{children}</details>;
}
