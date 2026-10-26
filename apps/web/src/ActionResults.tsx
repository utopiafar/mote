import React from 'react';
import type {ActionProposal} from '@mote/shared';
import {moteText} from '@mote/shared/i18n';
import type {Api} from './api';
import {errorMessage} from './api';
import {useResource} from './useResource';
export function ActionResults({api,evidenceId}:{api:Api;evidenceId:string}){
 const read=useResource<{items:(Pick<ActionProposal,'id'|'status'|'managed'|'resolution'|'kind'>&{title:string})[];hasMore:boolean}>(api,'/api/actions/by-evidence/'+encodeURIComponent(evidenceId),15000);
 if(read.loading&&!read.data)return <p role="status">{moteText('正在读取行动结果…')}</p>;
 if(read.error!==undefined)return <p role="alert">{errorMessage(read.error)} <button className="button subtle" onClick={read.refresh}>{moteText('重新读取')}</button></p>;
 if(read.data&&!Array.isArray(read.data.items))return <p role="alert">{moteText('中央响应格式无效，请刷新后重试。')} <button className="button subtle" onClick={read.refresh}>{moteText('重新读取')}</button></p>;
 if(!read.data?.items.length)return null;
 return <section className="related-action-results"><h3>{moteText('相关行动与结果')}</h3>{read.data.items.map(a=><p key={a.id} data-action-id={a.id}><a href={'#/actions?action='+encodeURIComponent(a.id)}>{a.title}</a> · {a.managed?.state==='cancelled'?moteText('已取消等待执行'):a.managed?.state==='cancel_requested'?moteText('已请求取消，写入结果仍待核实'):a.status==='succeeded'?moteText('已完成'):a.status==='approved'?moteText('等待客户端写入'):a.status==='executing'?moteText('正在写入 / 等待回执'):a.status==='uncertain'?moteText('保存结果待核实'):a.status==='stale'?moteText('原文已更新或删除'):a.status==='dismissed'?moteText('已忽略'):moteText('待确认')}</p>)}{read.data.hasMore&&<a href="#/actions">{moteText('查看全部行动')}</a>}</section>;
}
