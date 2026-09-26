import { moteText } from '@mote/shared/i18n';
import React,{useEffect} from 'react';
import {useResource} from '../useResource';
import {queryString,errorMessage,type Activity} from '../api';
import {ErrorNotice,Spinner} from '../shell-components';
import { ActivitySummary,Timeline } from '../Archive';
import { Files } from '../Files';
import { Materials } from '../Materials';
import { MediaActivitySummary } from '../Media';
import type { CollectionEntry,CollectionProps } from './types';
const Sources=React.lazy(()=>import('../Sources').then(module=>({default:module.Sources})));
const Memories=React.lazy(()=>import('../Memories').then(module=>({default:module.Memories})));
function ActivityCollection({api,range,revision}:CollectionProps){
  const activity=useResource<Activity>(api,'/api/activity'+queryString(range));
  useEffect(()=>{activity.refresh();},[revision,activity.refresh]);
  if(activity.error)return <ErrorNotice text={errorMessage(activity.error)} retry={activity.refresh}/>;
  if(!activity.data)return <Spinner/>;
  return <ActivitySummary activity={activity.data}/>;
}
export const builtinCollections:CollectionEntry[]=[
  {id:'records',featureId:'mote.capture',label:moteText('全部记录'),order:0,render:props=><Timeline {...props} embedded/>},
  {id:'materials',featureId:'mote.materials',label:moteText('正式资料'),order:1,render:props=><Materials {...props}/>},
  {id:'sources',featureId:'mote.sources',label:moteText('来源资料'),order:2,render:props=><Sources {...props} mode="library" onImport={()=>{location.hash='/library/import';}}/>},
  {id:'files',featureId:'mote.files',label:moteText('文件与录音'),order:3,render:props=><Files {...props}/>},
  {id:'activity',featureId:'mote.capture',label:moteText('应用活动'),order:4,render:props=><ActivityCollection {...props}/>},
  {id:'media',featureId:'mote.media',label:moteText('媒体播放'),order:5,render:props=><MediaActivitySummary key={props.revision} {...props}/>},
  {id:'memories',featureId:'mote.memory',label:moteText('记忆'),order:6,render:props=><Memories {...props} embedded refreshVersion={props.revision}/>},
];
