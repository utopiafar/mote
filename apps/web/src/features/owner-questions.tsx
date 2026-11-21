import React from 'react';
import {OwnerQuestionConversation,OwnerQuestionLinks,OwnerQuestionWorkspace} from '../plugins/memory/OwnerQuestions';
import type {ViewEntry} from './types';

/** Exact host contexts, not Memory content or topic dispatch. The pending
 * question list now lives on Ideas; Chat keeps the in-conversation detail and
 * the scoped work/material views. */
export const ownerQuestionPanels:ViewEntry[]=[
  {id:'owner-questions.standalone-detail',kind:'mote.ask.question',schemaVersion:1,representation:'standalone',requires:['http:GET:/api/owner-questions/:id','http:POST:/api/owner-questions/:id/reply'],render:({api,value,onOpen})=><OwnerQuestionWorkspace api={api} id={value.ref} onOpen={onOpen}/>},
  {id:'owner-questions.history',kind:'mote.ask.history',schemaVersion:1,representation:'workspace',requires:['http:GET:/api/owner-questions'],render:({api,value})=><OwnerQuestionLinks api={api} selectedId={value.ref} history/>},
  {id:'owner-questions.conversation',kind:'mote.ask.question',schemaVersion:1,representation:'workspace',requires:['http:GET:/api/owner-questions/:id','http:POST:/api/owner-questions/:id/reply'],render:({api,value,onOpen})=><OwnerQuestionConversation key={value.ref} api={api} id={value.ref} onOpen={onOpen}/>},
  {id:'owner-questions.work',kind:'mote.work.activity',schemaVersion:1,representation:'overview',requires:['http:GET:/api/owner-questions'],render:({api,value})=><OwnerQuestionLinks api={api} {...value.operationIds?.length?{operationIds:value.operationIds.slice(0,100)}:{workId:value.ref}}/>},
  {id:'owner-questions.material',kind:'mote.material.context',schemaVersion:1,representation:'source-context',requires:['http:GET:/api/owner-questions'],render:({api,value})=><OwnerQuestionLinks api={api} materialId={value.ref.split('@')[0].replace(/^material:/,'')}/>},
];
