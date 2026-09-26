import { moteText } from '@mote/shared/i18n';
import {
Sparkles
} from "lucide-react";
import React from "react";
import {
type Api,
type Device,
type Status
} from "./api";
const Conversations = React.lazy(()=>import('./Conversations').then(module=>({default:module.Conversations})));



import { AnswerView } from './shell-components';
export function Ask({api,status,devices,onOpen,onInsights,onSettings}: {api:Api;status:Status;devices:Device[];onOpen:(id:string)=>void;onInsights:()=>void;onSettings:()=>void}) {
  return <><div className="page-heading split-heading"><div><div className="eyebrow">{moteText("带着问题，回到上下文")}</div><h1>{moteText("你只管问。")}</h1><p>{moteText("让 Mote 沿着你的上下文，找回答案和它的来处。")}</p></div><button className="button subtle" onClick={onInsights}><Sparkles size={15}/>{moteText("查看洞察")}</button></div>
  {!status.agent.configured&&<div className="notice model-notice"><Sparkles size={19}/><div><strong>{moteText("再连接一个模型，让资料变成答案。")}</strong><p>{moteText("在设置中配置模型后，就可以开始提问。")}</p><button className="button" onClick={onSettings}>{moteText("打开模型设置")}</button></div></div>}
  <Conversations api={api} configured={status.agent.configured} devices={devices} renderAnswer={answer=><AnswerView answer={answer} onOpen={onOpen}/>}/></>;
}
