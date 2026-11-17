import type {Api} from './api';
import {moteText} from '@mote/shared/i18n';
import {unsentDrafts,unsentImages} from './plugins/ask/chat-drafts';
import {originalReferenceRoute,rememberOriginalReturn} from './ask-original-reference';
/** Preparing a question is navigation only. Existing unsent work requires the same explicit guard. */
export function openQuestionDraft(api:Api,question:string,reference?:string|{kind:'material';ref:string}){
 const draft=unsentDrafts.get(api);
 if(question&&(draft?.question||draft?.attachments.length||unsentImages.get(api)?.length)&&!window.confirm(moteText('有未保存的修改。离开并丢弃修改？')))return;
 const kind=typeof reference==='string'?'capture':reference?.kind,id=typeof reference==='string'?reference:reference?.ref;
 if(kind&&id)rememberOriginalReturn(api,kind,id);
 const route=kind&&id?originalReferenceRoute(kind,id):'#/ask';
 const query=new URLSearchParams({...(question?{questionDraft:question}:{}),...(kind==='material'?{materialOnly:'1'}:{})});
 window.location.hash=route+(query.size?(kind?'&':'?')+query:'');
}
