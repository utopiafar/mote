import {WebPreferences} from '../WebPreferences';
import { moteText, getLanguagePreference } from '@mote/shared/i18n';
import {pageHash} from '@mote/shared';
import React, {useSyncExternalStore} from "react";
import {BarChart3, Bell, Bot, CalendarCheck, ChevronRight, CircleHelp, HardDrive, Info, Languages, Palette, Play, Plug, Settings2, SlidersHorizontal, Wrench} from 'lucide-react';
import type {ServerConfiguration} from '@mote/shared';
import {bytes} from '../api';
import {webAppearance} from '../appearance';
import {assistantEntrypoints} from '../assistant-entrypoints';
import {webFeatures} from './registry';
import {AppearanceSelector} from '../AppearanceSelector';
import {useResource} from '../useResource';
const Feedback = React.lazy(() => import('../Feedback').then(module => ({ default: module.Feedback })));
const SoftwareUpdate = React.lazy(() => import('../SoftwareUpdate').then(module => ({ default: module.SoftwareUpdate })));
import {version as packageVersion} from '../../package.json';
declare const __MOTE_WEB_VERSION__: string;
import { Notifications, notificationSummary } from './notifications';
import type { PageEntry, PageProps } from './types';

const settingsStyles=[new URL('../settings-ui.css?no-inline',import.meta.url).href,new URL('../material-processing.css?no-inline',import.meta.url).href];
function SettingsStyles(){return <>{settingsStyles.map(href=><link key={href} rel="stylesheet" href={href} precedence="default"/>)}</>;}

type SettingsRow = {icon:typeof Settings2;label:string;value?:string;page?:string;hash?:string};
const appearanceLabels = {auto:'跟随系统',light:'浅色',dark:'深色'} as const;
const detailIcons:Record<string,typeof Settings2>={settings:SlidersHorizontal,actions:CalendarCheck,agentView:Bot,help:CircleHelp};
function languageLabel() {
  const preference=getLanguagePreference();
  return preference==='system'?moteText('跟随系统'):preference==='zh-CN'?moteText('中文'):'English';
}
/** The prototype's four groups replace the old directory. Destinations that the
 * prototype does not list stay reachable under the existing advanced disclosure
 * so this card never decides that an installed plugin page or helper surface is removed. */
export function SettingsDirectory({api,status,onPage}:PageProps) {
  const configuration=useResource<ServerConfiguration>(api,'/api/configuration');
  const authorization=useResource<{authorization:{state:'on'|'off'}}>(api,'/api/model-authorization');
  const {preference}=useSyncExternalStore(webAppearance.subscribe,webAppearance.getSnapshot,webAppearance.getSnapshot);
  useSyncExternalStore(webFeatures.registry.subscribe,webFeatures.registry.getRevision,webFeatures.registry.getRevision);
  const background=authorization.data?(authorization.data.authorization.state==='on'?moteText('已开启'):moteText('已关闭')):'';
  const groups:SettingsRow[][]=[
    [
      {icon:Settings2,label:moteText('模型'),value:status?status.agent.configured?moteText('已配置'):moteText('未配置'):'',page:'settings'},
      {icon:Play,label:moteText('后台处理'),value:background,hash:pageHash('models',{category:'processing'})},
    ],
    [
      {icon:Palette,label:moteText('外观'),value:moteText(appearanceLabels[preference]),page:'localPreferences'},
      {icon:Languages,label:moteText('语言'),value:languageLabel(),page:'localPreferences'},
      {icon:Bell,label:moteText('通知'),value:notificationSummary(configuration.data),page:'notifications'},
    ],
    [
      {icon:HardDrive,label:moteText('存储'),value:status?bytes(status.storage.bytes):'',page:'vault'},
      {icon:BarChart3,label:moteText('使用统计'),page:'usageStatistics'},
    ],
    [
      {icon:Wrench,label:moteText('诊断'),page:'developer'},
      {icon:Info,label:moteText('关于与更新'),value:typeof __MOTE_WEB_VERSION__==='string'?__MOTE_WEB_VERSION__:packageVersion,page:'help'},
    ],
  ];
  const known=new Set(['about','settings','localPreferences','notifications','vault','usage','usageStatistics','developer','help','ask','actions','activity','processing','search','coding','statistics','agentView']);
  const extra=webFeatures.pages().filter(entry=>(entry.section==='system'||!entry.section)&&!known.has(entry.id)&&!assistantEntrypoints.some(value=>value.pageId===entry.id));
  const row=({icon:Icon,label,value,page,hash}:SettingsRow)=><button key={label} type="button" className="processing-entry-row" onClick={()=>{if(hash)window.location.hash=hash;else if(page)onPage(page);}}><span className="model-profile-symbol"><Icon size={18}/></span><span><strong>{label}</strong></span>{value&&<span className="processing-current">{value}</span>}<ChevronRight size={15}/></button>;
  const detailRow=(id:string,label:string,description:string,href?:string)=>{
    const Icon=detailIcons[id]??Plug,available=id==='extensions'||Boolean(webFeatures.page(id));
    return <button key={id+':'+label} type="button" disabled={!available} onClick={()=>href?window.location.hash=href:onPage(id)}><Icon size={18}/><span><strong>{label}</strong>{description&&<small>{description}</small>}{!available&&<small>{moteText('当前服务未提供此入口')}</small>}</span><ChevronRight size={16}/></button>;
  };
  return <section className="settings-destinations final-settings-directory">
    {groups.map((group,index)=><section className="panel" key={index}>{group.map(row)}</section>)}
    <details className="settings-directory-advanced"><summary><ChevronRight className="disclosure-icon" size={14} aria-hidden="true"/>{moteText('其他设置')}</summary><div className="settings-directory-rows">{detailRow('actions',moteText('日程建议与执行'),moteText('发现、设备与日程执行范围'))}{detailRow('settings',moteText('定期生成发现'),moteText('生成周期与新增资料门槛'),pageHash('models',{category:'model',section:'automatic'}))}{detailRow('settings',moteText('活动整理'),moteText('是否整理后续采集内容'),pageHash('models',{category:'model',section:'automatic'}))}{detailRow('agentView',moteText('Agent 能看到什么'),'')}{detailRow('help',moteText('帮助与反馈'),moteText('连接、处理与维护'))}{extra.map(entry=>detailRow(entry.id,entry.label??entry.id,''))}</div><AppearanceSelector/></details>
  </section>;
}

export const pages: PageEntry[] = [
    { id: 'help', route: 'help', label: moteText('版本与反馈'), featureId: 'mote.system', render: ({ api,status, onPage }: PageProps) => <><SettingsStyles/><section className="version-feedback"><div className="page-heading"><h1>{moteText('版本与反馈')}</h1></div><SoftwareUpdate api={api}/><section className="version-help"><h2>{moteText('遇到问题')}</h2><button className="settings-version-row" onClick={()=>onPage('developer')}><strong>{moteText('运行与诊断')}</strong><small>{moteText('查看日志、导出支持包')}</small></button><Feedback profile={status?.profile}/></section></section></> },
    { id: 'localPreferences',route:'preferences/session',label:moteText('外观、语言与会话'),featureId:'mote.system',render:props=><><SettingsStyles/><WebPreferences {...props}/></>},
    { id: 'notifications', route:'preferences/notifications', label:moteText('通知'), featureId:'mote.system', render: ({api,onPage}:PageProps)=><><SettingsStyles/><Notifications api={api} onPage={onPage}/></> },
    { id: 'about', route: 'preferences', navItem: 'settings', label: moteText('设置'), featureId: 'mote.system', render: (props:PageProps)=><><SettingsStyles/><div className="page-heading"><h1>{moteText('设置')}</h1></div><SettingsDirectory {...props}/></> },
];
