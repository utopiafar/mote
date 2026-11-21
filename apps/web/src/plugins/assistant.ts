import type {BuiltinWebPlugin} from './types';
import React,{createElement,lazy} from 'react';
import {assistantEntrypoints} from '../assistant-entrypoints';
import {moteText} from '@mote/shared/i18n';
import {AssistantWorkbenchPage} from './assistant-workbench';
import {AssistantMatters} from './assistant/AssistantMatters';
import {FeedPage} from './assistant/FeedPage';

const MemoryPage=lazy(()=>import('./memory/MemoryPage').then(module=>({default:module.MemoryPage})));
const memory=assistantEntrypoints.find(entry=>entry.pageId==='assistantMemory')!;
/** Ready assistant pages register here; reserved pages stay unavailable until their owners register. */
export const assistant:BuiltinWebPlugin={id:'mote.assistant',pages:[{
  id:'assistantFeed',route:'feed',navItem:'feed',label:moteText('动态'),featureId:'mote.assistant',
  requires:['http:GET:/api/assistant-cards'],
  render:({api,onOpen})=>createElement(FeedPage,{api,onOpen}),
},{
  id:memory.pageId,route:memory.href.slice(2),navItem:'memory',featureId:'mote.assistant',requires:[...memory.requires??[]],
  get label(){return moteText('记忆');},
  render:({api,onOpen})=>createElement(MemoryPage,{api,onOpen}),
},{
  id:'assistantWorkbench',route:'assistant/workbench',label:moteText('工作台'),featureId:'mote.assistant',
  requires:[{id:'http:GET:/api/assistant/workbench',version:'1',host:'server'}],
  render:props=>createElement(AssistantWorkbenchPage,props),
},{
 id:'assistantMatters',route:'assistant/matters',label:moteText('事项与规则'),featureId:'mote.assistant',
 requires:['http:GET:/api/assistant/matters'],render:({api,onOpen})=>React.createElement(AssistantMatters,{api,onOpen}),
}]};
