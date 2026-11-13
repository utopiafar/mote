import type {BuiltinWebPlugin} from './types';
import {createElement,lazy} from 'react';
import {assistantEntrypoints} from '../assistant-entrypoints';
import {moteText} from '@mote/shared/i18n';
import {AssistantWorkbenchPage} from './assistant-workbench';

const Memories=lazy(()=>import('./memory/Memories').then(module=>({default:module.Memories})));
const memory=assistantEntrypoints.find(entry=>entry.pageId==='assistantMemory')!;
/** Ready assistant pages register here; reserved pages stay unavailable until their owners register. */
export const assistant:BuiltinWebPlugin={id:'mote.assistant',pages:[{
  id:memory.pageId,route:memory.href.slice(2),featureId:'mote.assistant',requires:[...memory.requires??[]],
  get label(){return moteText('记忆与人物');},
  render:({api,range,onOpen,timelineRevision,refresh})=>createElement(Memories,{api,range,onOpen,refreshVersion:timelineRevision,onChanged:refresh}),
},{
  id:'assistantWorkbench',route:'assistant/workbench',label:moteText('工作台'),featureId:'mote.assistant',
  requires:[{id:'http:GET:/api/assistant/workbench',version:'1',host:'server'}],
  render:props=>createElement(AssistantWorkbenchPage,props),
}]};
