import {CHAT_ABOUT_PARAM,formatAboutRef,pageHash,type AboutRef} from '@mote/shared';

/** One typed reference for the chat page. Pages never assemble `about` values themselves. */
export function chatHref(ref:AboutRef):string{
  return pageHash('chat',{[CHAT_ABOUT_PARAM]:formatAboutRef(ref)});
}
