import {getLocale,moteText} from '@mote/shared/i18n';
import type {DesktopApi,Status} from './contracts';
import type {SourceStatus} from './contracts/sources';
import type {PermissionKind} from './permission-types';

type CaptureSyncActions={
  start():void;
  stop():void;
  addSource():void;
  openChrome():void;
  openCalendar():void;
  openSources():void;
  sendNow():void;
  setPaused(paused:boolean):void;
  failure(message:string):void;
};

const syncModeLabel=(mode:Status['sync']['mode'])=>mode==='realtime'?moteText('立即发送'):mode==='interval'?moteText('定时发送'):mode==='batch'?moteText('凑够一批后发送'):moteText('仅手动发送');

function formatBytes(bytes:number):string{
  if(bytes>=1024*1024*1024)return (bytes/1024/1024/1024).toFixed(1)+' GB';
  if(bytes>=1024*1024)return (bytes/1024/1024).toFixed(1)+' MiB';
  return Math.round(bytes/1024)+' KiB';
}

function hostname(value:string):string{
  try{return new URL(value).host||value;}catch{return value.replace(/^[a-z]+:\/\//i,'').split('/')[0]||value;}
}

/** The Mac capture-and-sync window: local sources, sending, privacy and storage in one place. */
export function createCaptureSyncUi(api:Pick<DesktopApi,'permissionSettings'|'storageStatistics'>,actions:CaptureSyncActions){
  const el=<T extends HTMLElement=HTMLElement>(id:string)=>document.getElementById(id) as T;
  let status:Status|undefined,rows:SourceStatus[]=[],storageRead=0,disposed=false;
  const setSwitch=(button:HTMLButtonElement,on:boolean)=>{button.classList.toggle('on',on);button.setAttribute('aria-checked',String(on));};
  const switches=(id:string)=>el<HTMLButtonElement>(id);

  const render=()=>{
    if(!status||disposed)return;
    const running=status.running;
    const screenState=el('capture-sync-screen-state'),screenSettings=el<HTMLButtonElement>('capture-sync-screen-settings'),screenToggle=switches('capture-sync-screen-toggle');
    if(status.platform!=='macos'){
      screenState.textContent=moteText('当前平台不支持');screenState.dataset.tone='warning';screenSettings.hidden=true;screenToggle.hidden=true;
    }else if(status.screenPermission!=='granted'){
      screenState.textContent=moteText('等待采集权限 · 屏幕录制');screenState.dataset.tone='warning';screenSettings.hidden=false;screenToggle.hidden=true;
    }else{
      screenState.textContent=running?moteText('采集中'):moteText('已停止');
      delete screenState.dataset.tone;screenSettings.hidden=true;screenToggle.hidden=false;setSwitch(screenToggle,running);
    }

    const chromeConfigured=(status.config.chromeOrigins??[]).length>0;
    el('capture-sync-chrome-state').textContent=chromeConfigured?(running?moteText('采集中'):moteText('已停止')):moteText('未选择');
    setSwitch(switches('capture-sync-chrome-toggle'),chromeConfigured&&running);

    const calendars=rows.filter(row=>row.source.kind==='local-calendar');
    const calendarEnabled=calendars.some(row=>row.source.enabled);
    el('capture-sync-calendar-state').textContent=!calendars.length?moteText('尚未连接'):calendarEnabled?(running?moteText('采集中'):moteText('已停止')):moteText('已暂停');
    setSwitch(switches('capture-sync-calendar-toggle'),calendarEnabled&&running);

    const folders=rows.filter(row=>row.source.kind==='local-files'&&row.source.syncContinuously!==false).length;
    el('capture-sync-folder-count').textContent=moteText('{0} 个',folders);

    const connected=Boolean(status.config.serverUrl&&status.config.tokenConfigured);
    el('capture-sync-host').textContent=connected?hostname(status.config.serverUrl):moteText('尚未连接');
    const pending=status.sync.pendingRecords;
    el('capture-sync-send-state').textContent=!connected?moteText('尚未连接'):status.config.syncPaused?moteText('发送已暂停'):status.sync.state==='error'?moteText('需要重新连接'):pending>0?moteText('待发送 {0} 条',pending):status.sync.lastUploadAt?moteText('已同步')+' · '+new Date(status.sync.lastUploadAt).toLocaleTimeString(getLocale(),{hour:'2-digit',minute:'2-digit',hour12:false}):moteText('已同步');
    const sendNow=el<HTMLButtonElement>('capture-sync-send-now');sendNow.disabled=!connected;
    el('capture-sync-mode').textContent=syncModeLabel(status.sync.mode);
    setSwitch(switches('capture-sync-pause'),Boolean(status.config.syncPaused));
  };

  async function refreshStorage(){
    if(disposed)return;
    const request=++storageRead;const target=el('capture-sync-storage');target.textContent=moteText('正在读取…');
    try{const report=await api.storageStatistics();if(!disposed&&request===storageRead)target.textContent=formatBytes(report.bytes);}
    catch{if(!disposed&&request===storageRead)target.textContent=moteText('读取失败');}
  }

  async function openSettings(kind:PermissionKind){
    const button=el<HTMLButtonElement>('capture-sync-screen-settings');if(button.disabled)return;
    button.disabled=true;
    try{await api.permissionSettings(kind);}
    catch{actions.failure(moteText('无法打开权限授权，请重试。'));}
    finally{if(!disposed)button.disabled=false;}
  }

  el('capture-sync-screen-settings').addEventListener('click',()=>void openSettings('screen'));
  el('capture-sync-screen-toggle').addEventListener('click',()=>{if(!status)return;if(status.running)actions.stop();else actions.start();});
  el('capture-sync-chrome-toggle').addEventListener('click',()=>{if(!status)return;const configured=(status.config.chromeOrigins??[]).length>0;if(!configured)actions.openChrome();else if(status.running)actions.stop();else actions.start();});
  el('capture-sync-calendar-toggle').addEventListener('click',()=>{if(!status)return;const calendars=rows.filter(row=>row.source.kind==='local-calendar');if(status.running&&calendars.some(row=>row.source.enabled))actions.stop();else if(!calendars.length)actions.openCalendar();else if(calendars.some(row=>row.source.enabled))actions.start();else actions.openSources();});
  el('capture-sync-add-source').addEventListener('click',()=>actions.addSource());
  el('capture-sync-send-now').addEventListener('click',()=>{if(!el<HTMLButtonElement>('capture-sync-send-now').disabled)actions.sendNow();});
  el('capture-sync-pause').addEventListener('click',()=>{if(!status)return;actions.setPaused(!status.config.syncPaused);});

  return {
    update(next:Status,nextRows:SourceStatus[]){status=next;rows=nextRows;render();},
    show(){void refreshStorage();},
    dispose(){disposed=true;},
  };
}
