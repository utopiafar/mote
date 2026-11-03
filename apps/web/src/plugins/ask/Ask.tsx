import { moteText } from '@mote/shared/i18n';
import {
Sparkles
} from "lucide-react";
import React from "react";
import {
type Api,
type Device,
type Status
} from "../../api";
const Conversations = React.lazy(()=>import('./Conversations').then(module=>({default:module.Conversations})));



import { AnswerView } from '../../shell-components';
import {FeaturePanels} from '../../features/runtime';
import {readOwnerQuestion} from '../../owner-question-route';
import {useHashChoice} from '../../useHashChoice';
import type {AskController} from './controller';
export function Ask({api,status,devices,onOpen,onInsights,onSettings,controller}: {api:Api;status:Status;devices:Device[];onOpen:(id:string)=>void;onInsights:()=>void;onSettings:()=>void;controller?:AskController}) {
  const [ownerQuestion]=useHashChoice('question',readOwnerQuestion);
  if(ownerQuestion!==null)return <FeaturePanels api={api} onOpen={onOpen} unavailable={<p role="status">{moteText('专用视图暂不可用，请查看资料库或重试。')}</p>} value={{kind:ownerQuestion?'mote.ask.question':'mote.ask.history',schemaVersion:1,representation:'standalone',ref:ownerQuestion,revision:'1',title:'',text:''}}/>;
  return <>
  {!status.agent.configured&&<div className="notice model-notice"><Sparkles size={19}/><div><strong>{moteText("再连接一个模型，让资料变成答案。")}</strong><p>{moteText("在设置中配置模型后，就可以开始提问。")}</p><button className="button" onClick={onSettings}>{moteText("打开模型设置")}</button></div></div>}
  <Conversations api={api} configured={status.agent.configured} devices={devices} onOpen={onOpen} controller={controller} renderAnswer={(answer,openReference)=><AnswerView answer={answer} onOpen={openReference} compact/>}/></>;
}
