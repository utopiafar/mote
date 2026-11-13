import React from 'react';
import type {ActionProposal} from '@mote/shared';
import {moteText} from '@mote/shared/i18n';
import {calendarStateLabel} from '../../action-presentation';

/** One immutable recipient and full message per explicit owner confirmation.
 * It uses the existing Actions confirm endpoint; uncertain sends have no retry. */
export function MessageActionDetails({action,targetName,busy,onConfirm,onDismiss,onRefresh,onBack}:{
 action:ActionProposal;targetName:string;busy:boolean;onConfirm:()=>void;onDismiss:()=>void;onRefresh:()=>void;onBack:()=>void;
}){
 return <section className="calendar-final-detail message-action-details">
  <button className="back-link" disabled={busy} onClick={onBack}>← {moteText('返回原文')}</button>
  <header className="action-final-detail-head"><span role="status">{calendarStateLabel(action)}</span><h1>{action.event.title}</h1></header>
  <p>{targetName}</p>
  {action.message&&<><strong>{action.message.conversationName??action.message.conversationId}</strong><p>{action.message.conversationId}</p>
   <p style={{whiteSpace:'pre-wrap'}}>{action.message.text}</p></>}
  {action.status==='uncertain'&&<p className="notice">{moteText('请刷新检查结果，避免重复发送。')}</p>}
  {action.status==='stale'&&<p className="notice">{moteText('这份建议暂不能确认，请查看当前原文。')}</p>}
  {action.status==='succeeded'&&<p>{moteText('已收到执行回执。')}</p>}
  {action.status==='proposed'&&action.message&&<div className="action-final-buttons">
   <button className="button primary" disabled={busy} onClick={onConfirm}>{moteText('确认')} · {moteText('发送')}</button>
   <button className="text-button" disabled={busy} onClick={onDismiss}>{moteText('忽略')}</button>
  </div>}
  <button className="text-button" disabled={busy} onClick={onRefresh}>{moteText('刷新状态')}</button>
  {(action.operationId||action.externalId)&&<details className="action-final-advanced"><summary>{moteText('执行与回执')}</summary>
   {action.operationId&&<p>{moteText('操作')}：{action.operationId}</p>}{action.externalId&&<p>{moteText('回执')}：{action.externalId}</p>}
  </details>}
 </section>;
}
