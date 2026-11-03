import {WebPreferences} from '../WebPreferences';
import { moteText } from '@mote/shared/i18n';
import { Unplug } from "lucide-react";
import React from "react";
import { type SessionLifetime } from "../session";
const Feedback = React.lazy(() => import('../Feedback').then(module => ({ default: module.Feedback })));
import { SettingsLanding } from "../WorkspaceNavigation";
const SoftwareUpdate = React.lazy(() => import('../SoftwareUpdate').then(module => ({ default: module.SoftwareUpdate })));
import { FeatureGuide } from '../FeatureGuide';
import type { PageEntry, PageProps } from './types';
export const pages: PageEntry[] = [
    { id: 'featureGuide', route: 'guide', label: moteText("全部功能"), featureId: 'mote.system', render: ({ api,onPage }: PageProps) => <FeatureGuide api={api} onPage={onPage}/> },
    { id: 'help', route: 'help', label: moteText('版本与反馈'), featureId: 'mote.system', render: ({ api,status, onPage }: PageProps) => <section className="version-feedback"><div className="page-heading"><h1>{moteText('版本与反馈')}</h1></div><SoftwareUpdate api={api}/><section className="version-help"><h2>{moteText('遇到问题')}</h2><button className="settings-version-row" onClick={()=>onPage('developer')}><strong>{moteText('运行与诊断')}</strong><small>{moteText('查看日志、导出支持包')}</small></button><button className="settings-version-row" onClick={()=>onPage('featureGuide')}>{moteText('全部功能')}</button><Feedback profile={status?.profile}/></section></section> },
    { id: 'localPreferences',route:'preferences/session',label:moteText('外观、语言与会话'),featureId:'mote.system',render:props=><WebPreferences {...props}/>},
    { id: 'about', route: 'preferences', label: moteText('设置'), featureId: 'mote.system', render: ({onPage}:PageProps)=><><div className="page-heading"><h1>{moteText('设置')}</h1></div><SettingsLanding onPage={onPage}/></> },
];
