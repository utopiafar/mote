import type {Api} from './api';
import {moteText} from '@mote/shared/i18n';
import {unsentDrafts,unsentImages} from './plugins/ask/chat-drafts';
/** Preparing a question is navigation only. Existing unsent work requires the same explicit guard. */
export function openQuestionDraft(api:Api,question:string){
 const draft=unsentDrafts.get(api);
 if(question&&(draft?.question||draft?.attachments.length||unsentImages.get(api)?.length)&&!window.confirm(moteText('有未保存的修改。离开并丢弃修改？')))return;
 window.location.hash='#/ask'+(question?'?'+new URLSearchParams({questionDraft:question}):'');
}
