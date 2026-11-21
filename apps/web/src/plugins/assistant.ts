import type {BuiltinWebPlugin} from './types';
import React,{createElement,lazy} from 'react';
import {assistantEntrypoints} from '../assistant-entrypoints';
import {moteText} from '@mote/shared/i18n';
import {AssistantWorkbenchPage} from './assistant-workbench';
import {AssistantMatters} from './assistant/AssistantMatters';
import {FeedPage} from './assistant/FeedPage';
import {GoalsPage} from './assistant/GoalsPage';

const Memories=lazy(()=>import('./memory/Memories').then(module=>({default:module.Memories})));
const memory=assistantEntrypoints.find(entry=>entry.pageId==='assistantMemory')!;
/** Ready assistant pages register here; reserved pages stay unavailable until their owners register. */
export const assistant:BuiltinWebPlugin={id:'mote.assistant',pages:[{
  id:'assistantFeed',route:'feed',navItem:'feed',label:moteText('动态'),featureId:'mote.assistant',
  requires:['http:GET:/api/assistant-cards'],
  render:({api,onOpen})=>createElement(FeedPage,{api,onOpen}),
},{
  id:memory.pageId,route:memory.href.slice(2),navItem:'memory',featureId:'mote.assistant',requires:[...memory.requires??[]],
  get label(){return moteText('记忆与人物');},
  render:({api,range,onOpen,timelineRevision,refresh})=>createElement(Memories,{api,range,onOpen,refreshVersion:timelineRevision,onChanged:refresh}),
},{
  id:'assistantGoals',route:'goals',navItem:'goals',label:moteText('目标'),featureId:'mote.assistant',
  requires:['http:GET:/api/assistant/goals'],
  render:({api,onOpen})=>createElement(GoalsPage,{api,onOpen}),
},{
  id:'assistantWorkbench',route:'assistant/workbench',label:moteText('工作台'),featureId:'mote.assistant',
  requires:[{id:'http:GET:/api/assistant/workbench',version:'1',host:'server'}],
  render:props=>createElement(AssistantWorkbenchPage,props),
},{
 id:'assistantMatters',route:'assistant/matters',label:moteText('事项与规则'),featureId:'mote.assistant',
 requires:['http:GET:/api/assistant/matters'],render:({api,onOpen})=>React.createElement(AssistantMatters,{api,onOpen}),
}]};
