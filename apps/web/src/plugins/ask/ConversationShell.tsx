import React,{type ReactNode} from 'react';
import {Sparkles} from 'lucide-react';
import {moteText} from '@mote/shared/i18n';

/** Shared Ask chrome. Feature-owned dialogue content keeps its own commands. */
export function ConversationHeading({title,description,action,plain=false}:{title:string;description?:string;action?:ReactNode;plain?:boolean}){
  if(plain)return <div className="conversation-heading conversation-heading-plain"><h1>{title}</h1>{action}</div>;
  return <div className="conversation-heading"><div className="chat-heading-main"><div className="chat-avatar"><Sparkles size={17}/></div><div><h2>{title}</h2><p>{description??moteText('你的个人上下文助手')}</p></div></div>{action}</div>;
}
export function ConversationComposer({label,placeholder,value,onChange,onSubmit,disabled=false,maxLength=8000,hintId,children}:{label:string;placeholder:string;value:string;onChange:(value:string)=>void;onSubmit:()=>void;disabled?:boolean;maxLength?:number;hintId?:string;children:ReactNode}){
  return <form className="ask-form" onSubmit={event=>{event.preventDefault();onSubmit();}}><textarea aria-label={label} aria-describedby={hintId} placeholder={placeholder} value={value} onChange={event=>onChange(event.target.value)} onKeyDown={event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.nativeEvent.isComposing){event.preventDefault();onSubmit();}}} disabled={disabled} maxLength={maxLength} rows={2}/>{children}</form>;
}
