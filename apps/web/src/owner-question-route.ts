import {pageHash,pageRoutes} from '@mote/shared';
import type {Api} from './api';
const listOrigins=new WeakMap<Api,string>();
export function openOwnerQuestionList(api:Api){listOrigins.set(api,window.location.hash);window.location.hash=ownerQuestionRoute();}
export function ownerQuestionListOrigin(api:Api){return listOrigins.get(api);}
export function clearOwnerQuestionListOrigin(api:Api){listOrigins.delete(api);}
/** Owner questions live within Chat; identifiers never carry answer semantics. */
export function ownerQuestionRoute(id=''){return pageHash('chat',{question:id});}
export function readOwnerQuestion(hash:string){
  const [route,query]=hash.split('?');
  return route.replace(/^#\/?/,'')===pageRoutes.chat?new URLSearchParams(query).get('question'):null;
}
export function ownerQuestionListPath(scope:{workId?:string;materialId?:string;operationIds?:string[]}={},cursor?:string,state='open,deferred'){
  const {operationIds,...ids}=scope;
  return '/api/owner-questions?'+new URLSearchParams({limit:'20',state,...ids,...operationIds?.length?{operationIds:JSON.stringify(operationIds.slice(0,100))}:{},...cursor?{cursor}:{}});
}
