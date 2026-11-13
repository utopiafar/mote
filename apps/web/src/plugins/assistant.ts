import type {BuiltinWebPlugin} from './types';
import {createElement,lazy} from 'react';
import {assistantEntrypoints} from '../assistant-entrypoints';
import {moteText} from '@mote/shared/i18n';

const Memories=lazy(()=>import('./memory/Memories').then(module=>({default:module.Memories})));
const entry=assistantEntrypoints.find(entry=>entry.pageId==='assistantMemory')!;
/** This page uses the existing Memory workspace and its owner mutations. The other
 * reserved assistant pages remain unavailable until their owners register. */
export const assistant:BuiltinWebPlugin={id:'mote.assistant',pages:[{
  id:entry.pageId,route:entry.href.slice(2),featureId:'mote.assistant',requires:[...entry.requires??[]],
  get label(){return moteText('记忆与人物');},
  render:({api,range,onOpen,timelineRevision,refresh})=>createElement(Memories,{api,range,onOpen,refreshVersion:timelineRevision,onChanged:refresh}),
}]};
