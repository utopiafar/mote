import {useEffect,useRef,useState} from 'react';
import {ApiError,INSIGHT_HISTORY_PATH,type Api,type Answer,type InsightPage} from './api';
import {useResource} from './useResource';
import {resources} from './resource-cache';

/** Extra pages belong to the exact first-page boundary and authenticated API.
 * A changed boundary or invalid cursor discards them before they can be reused. */
export function useInsightHistory(api:Api,revision?:unknown){
 const first=useResource<InsightPage>(api,INSIGHT_HISTORY_PATH,undefined,revision);
 const boundary=first.data?JSON.stringify([first.data.items.map(item=>item.runId),first.data.nextCursor]):'';
 const [extra,setExtra]=useState<{api:Api;boundary:string;pages:InsightPage[];loading:boolean;error?:unknown}>({api,boundary,pages:[],loading:false});
 const pending=useRef<AbortController|null>(null);
 useEffect(()=>{pending.current?.abort();pending.current=null;setExtra(current=>({api,boundary,pages:current.api===api&&current.boundary===boundary?current.pages:[],loading:false}));return()=>{pending.current?.abort();pending.current=null;};},[api,boundary,first.data]);
 const current=extra.api===api&&extra.boundary===boundary?extra:undefined;
 const denied=(error:unknown)=>error instanceof ApiError&&[401,403].includes(error.status);
 const accessDenied=denied(first.error)||denied(current?.error);
 const pages=accessDenied?[]:current?.pages??[];
 const items:Answer[]=accessDenied?[]:[...(first.data?.items??[]),...pages.flatMap(page=>page.items)];
 const nextCursor=pages.at(-1)?.nextCursor??(pages.length?null:first.data?.nextCursor);
 async function more(){
  if(!nextCursor||pending.current||accessDenied)return;
  const controller=new AbortController();pending.current=controller;
  setExtra({api,boundary,pages,loading:true});
  try{
   const page=await api.request<InsightPage>(INSIGHT_HISTORY_PATH+'&cursor='+encodeURIComponent(nextCursor),{signal:controller.signal});
   if(!controller.signal.aborted)setExtra({api,boundary,pages:[...pages,page],loading:false});
  }catch(error){if(!controller.signal.aborted){
   setExtra({api,boundary,pages:error instanceof ApiError&&[401,403,409].includes(error.status)?[]:pages,loading:false,error});
   if(error instanceof ApiError&&[401,403,409].includes(error.status)){
    first.refresh();
    resources(api).invalidate(path=>path.startsWith('/api/insights/'));
   }
  }}finally{if(pending.current===controller)pending.current=null;}
 }
 return {...first,items,nextCursor,more,moreLoading:current?.loading??false,moreError:current?.error,accessDenied};
}
