import React from 'react';
import type {SourceConnection} from '@mote/shared';
import {moteText} from '@mote/shared/i18n';
import type {Api} from '../../api';
import {LoadingText} from '../../Loading';
import {useResource} from '../../useResource';
import type {ConversationMessageScope} from './conversation-messages';
import {conversationFailure} from './ConversationTurnDetails';

export type SourceScopeChoice=Pick<ConversationMessageScope,'kind'|'sourceIds'>;

/** Source identities are enough to choose a reader grant. Do not enumerate
 * originals here: the query's read-only tools retrieve them within that grant. */
export function ConversationSourceScope({api,scope,onChange,disabled=false}:{api:Api;scope:ConversationMessageScope;onChange:(scope:SourceScopeChoice)=>void;disabled?:boolean}){
 const sources=useResource<{items:SourceConnection[]}>(api,'/api/sources'),items=sources.data?.items??[];
 const sourceIds=scope.kind==='selection'&&scope.evidenceIds===undefined?scope.sourceIds:undefined;
 const singleId=sourceIds?.length===1?sourceIds[0]:undefined;
 const value=scope.kind==='all'?'all':sourceIds?.length===0?'empty':singleId!==undefined?'source:'+singleId:'current';
 const currentNames=scope.sourceIds?.map(id=>items.find(source=>source.id===id)?.name??id)??[];
 const currentLabel=[moteText('当前范围'),...currentNames,...(scope.evidenceIds!==undefined?[moteText('{0} 条证据',scope.evidenceIds.length)]:[])].join(' · ');
 const change=(value:string)=>{
  if(value==='all')onChange({kind:'all'});
  else if(value==='empty')onChange({kind:'selection',sourceIds:[]});
  else if(value.startsWith('source:'))onChange({kind:'selection',sourceIds:[value.slice('source:'.length)]});
 };
 return <div className="filter-bar conversation-source-scope">
  <label>{moteText('来源范围')}<select aria-label={moteText('来源范围')} aria-describedby={value==='empty'?'conversation-empty-scope':undefined} value={value} disabled={disabled} onChange={event=>change(event.target.value)}>
   <option value="all">{moteText('全部资料')}</option>
   <option value="empty">{moteText('未选择资料')}</option>
   {value==='current'&&<option value="current">{currentLabel}</option>}
   {singleId!==undefined&&!items.some(source=>source.id===singleId)&&<option value={'source:'+singleId}>{moteText('来源：{0}',singleId)}</option>}
   <optgroup label={moteText('已连接来源')}>{items.map(source=><option key={source.id} value={'source:'+source.id}>{moteText('仅使用')} · {source.name} ({source.id})</option>)}</optgroup>
  </select></label>
  {value==='empty'&&<span id="conversation-empty-scope" role="note">{moteText('当前范围内没有可读取的内容。')}</span>}
  {sources.loading&&<span role="status"><LoadingText/></span>}
  {Boolean(sources.error)&&<><span role="alert">{conversationFailure(sources.error)}</span><button type="button" className="text-button" onClick={sources.refresh}>{moteText('重试')}</button></>}
 </div>;
}
