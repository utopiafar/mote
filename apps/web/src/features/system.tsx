import { moteText } from '@mote/shared/i18n';
import {
Unplug
} from "lucide-react";
import React from "react";
import { type SessionLifetime } from "../session";
const Feedback = React.lazy(()=>import('../Feedback').then(module=>({default:module.Feedback})));

import { PageBack } from "../DeviceOverview";
const SoftwareUpdate = React.lazy(()=>import('../SoftwareUpdate').then(module=>({default:module.SoftwareUpdate})));

import { Overview } from '../Overview';
import type { PageEntry,PageProps } from './types';

export const pages:PageEntry[]=[
{id:'overview',route:'today',label:moteText('今天'),featureId:'mote.system',render:({api,status,devices,activity,recent,insights,onPage,onOpen:setEvidenceId,range,setArchiveTab}:PageProps)=>status?(
                        <Overview
                          api={api}
                          status={status}
                          devices={devices}
                          activity={activity}
                          recent={recent}
                          insights={insights}
                          onPage={onPage}
                          onOpen={setEvidenceId}
                          range={range}
                          onMedia={()=>{setArchiveTab('media');onPage('archive');}}
                        />
                      ):null},
{id:'help',route:'help',label:moteText('帮助与反馈'),featureId:'mote.system',render:({status,onPage}:PageProps)=><><div className="page-heading"><h1>{moteText('帮助与反馈')}</h1><p>{moteText('检查连接、权限与处理状态，或提交问题反馈。')}</p></div><Feedback profile={status?.profile}/><button className="button" onClick={()=>onPage('developer')}>{moteText('诊断与更新')}</button></>},
{id:'about',route:'preferences',label:moteText('设置'),featureId:'mote.system',render:({api,onPage,disconnect,sessionLifetime,changeSessionLifetime}:PageProps)=><><PageBack title={moteText("设置")} onBack={()=>onPage("settings")}/><div className="page-heading"><div className="eyebrow">{moteText("你的资料，由你保管")}</div><h1>{moteText("设置")}</h1><p>{moteText("AI 原生个人上下文采集与中央归档。")}</p></div><SoftwareUpdate api={api}/><section className="panel session-settings"><h2>{moteText("当前服务（中央节点）")}</h2><p>{window.location.origin}</p><label className="session-lifetime-control"><span><strong>{moteText("登录会话有效期")}</strong><small>{sessionLifetime==='session'?moteText("仅保留在当前浏览器标签页；关闭后需要重新登录。"):moteText("管理令牌仍由中央节点控制；浏览器中的登录会话会在期限后自动清除。")}</small></span><select aria-label={moteText("登录会话有效期")} value={sessionLifetime} onChange={e=>changeSessionLifetime(e.target.value as SessionLifetime)}><option value="session">{moteText("当前窗口（Session）")}</option><option value="1d">{moteText("1 天")}</option><option value="7d">{moteText("7 天")}</option><option value="30d">{moteText("30 天")}</option></select></label><p className="fine-print">{moteText("这是网页端登录会话的本地保存期限，不会修改中央节点的管理令牌或采集端凭据。")}</p><button className="button subtle" onClick={disconnect}><Unplug size={15}/>{moteText("退出登录")}</button></section></>},
];
