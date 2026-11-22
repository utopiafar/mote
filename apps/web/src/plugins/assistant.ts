import type {BuiltinWebPlugin} from './types';
import React,{createElement,lazy} from 'react';
import {assistantEntrypoints,assistantWorkbenchEntrypoint} from '../assistant-entrypoints';
import {moteText} from '@mote/shared/i18n';
import {AssistantWorkbenchPage} from './assistant-workbench';
import {AssistantMatters} from './assistant/AssistantMatters';
import {FeedPage} from './assistant/FeedPage';
import {IdeasPage} from './assistant/IdeasPage';
import {GoalsPage} from './assistant/GoalsPage';

const MemoryPage=lazy(()=>import('./memory/MemoryPage').then(module=>({default:module.MemoryPage})));
const memory=assistantEntrypoints.find(entry=>entry.pageId==='assistantMemory')!;
const memoryStyles=[
  new URL('../memory-presentation.css?no-inline',import.meta.url).href,
  new URL('../library.css?no-inline',import.meta.url).href,
  new URL('../settings-ui.css?no-inline',import.meta.url).href,
];
const memoryStyleLinks=memoryStyles.map(href=>createElement('link',{key:href,rel:'stylesheet',href,precedence:'default'}));
/** Ready assistant pages register here; reserved pages stay unavailable until their owners register. */
export const assistant:BuiltinWebPlugin={id:'mote.assistant',pages:[{
  id:'assistantFeed',route:'feed',navItem:'feed',label:moteText('动态'),featureId:'mote.assistant',
  requires:['http:GET:/api/assistant-cards'],
  render:({api,onOpen})=>createElement(FeedPage,{api,onOpen}),
},{
  id:'assistantIdeas',route:'ideas',navItem:'ideas',label:moteText('点子'),featureId:'mote.assistant',
  requires:['http:GET:/api/assistant/ideas','http:POST:/api/assistant/ideas/ignore-all'],
  render:({api,refresh})=>createElement(IdeasPage,{api,refresh}),
},{
  id:memory.pageId,route:memory.href.slice(2),navItem:'memory',featureId:'mote.assistant',requires:[...memory.requires??[]],
  get label(){return moteText('记忆');},
  render:({api,onOpen})=>createElement(React.Fragment,null,...memoryStyleLinks,createElement(MemoryPage,{api,onOpen})),
},{
  id:'assistantGoals',route:'goals',navItem:'goals',label:moteText('目标'),featureId:'mote.assistant',
  requires:['http:GET:/api/assistant/goals'],
  render:({api,onOpen})=>createElement(GoalsPage,{api,onOpen}),
},{
  id:assistantWorkbenchEntrypoint.pageId,route:assistantWorkbenchEntrypoint.href.slice(2),label:moteText('工作台'),featureId:'mote.assistant',
  requires:[...assistantWorkbenchEntrypoint.requires],
  render:props=>createElement(AssistantWorkbenchPage,props),
},{
 id:'assistantMatters',route:'assistant/matters',label:moteText('事项与规则'),featureId:'mote.assistant',
 requires:['http:GET:/api/assistant/matters'],render:({api,onOpen})=>React.createElement(AssistantMatters,{api,onOpen}),
}]};
