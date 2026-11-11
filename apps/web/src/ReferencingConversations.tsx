import {useEffect,useState} from 'react';
import type {Api} from './api';
import {LoadingText} from './Loading';
import {readResource} from './resource-cache';
import {confirmNavigation} from './unsaved';

type ConversationScope={evidenceIds?:string[];anchorEvidenceIds?:string[];anchorMaterialRef?:string};
type ConversationPage={items:{id:string;title:string;scope:ConversationScope}[];nextCursor?:string|null};

/** Conversations whose saved scope names this exact record or its Material, counted the way the phone readers count them. */
export function ReferencingConversations({api,captureId,materialRef}:{api:Api;captureId:string;materialRef?:string}) {
  const [state,setState]=useState<{items?:{id:string;title:string}[];failed?:boolean}>({});
  useEffect(()=>{
    const controller=new AbortController();
    setState({});
    void (async()=>{
      const items:{id:string;title:string}[]=[];
      let cursor:string|null|undefined;
      do {
        const page=await readResource<ConversationPage>(api,'/api/conversations?limit=100'+(cursor?'&cursor='+encodeURIComponent(cursor):''),controller.signal);
        for(const item of page.items){
          const scope=item.scope??{};
          if(scope.evidenceIds?.includes(captureId)||scope.anchorEvidenceIds?.includes(captureId)||(materialRef!==undefined&&scope.anchorMaterialRef===materialRef))items.push({id:item.id,title:item.title});
        }
        cursor=page.nextCursor;
      } while(cursor);
      if(!controller.signal.aborted)setState({items});
    })().catch(()=>{if(!controller.signal.aborted)setState({failed:true});});
    return()=>controller.abort();
  },[api,captureId,materialRef]);
  if(state.failed)return <>—</>;
  if(!state.items)return <LoadingText/>;
  if(!state.items.length)return <>0</>;
  return <ul className="evidence-conversations">{state.items.map(item=><li key={item.id}>
    <a href={'#/ask?conversation='+encodeURIComponent(item.id)} onClick={event=>{if(!confirmNavigation())event.preventDefault();}}>{item.title}</a>
  </li>)}</ul>;
}
