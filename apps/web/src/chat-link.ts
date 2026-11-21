import {CHAT_ABOUT_PARAM, formatAboutRef, pageHash, type AboutRef} from '@mote/shared';

/** The one owner entry into Chat with a referenced object. Pages call this
 * instead of assembling `#/chat` query strings; the chat page reads the same
 * parameter back with `parseAboutRef`. */
export function chatHref(ref: AboutRef): string {
  return pageHash('chat', {[CHAT_ABOUT_PARAM]: formatAboutRef(ref)});
}
