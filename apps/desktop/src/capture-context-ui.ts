import {moteText} from '@mote/shared/i18n';
import {appendDiagnostic} from './ui-diagnostic';
import type {DesktopApi,Status} from './contracts';
import type {CaptureContextChannel} from './source-manager';
import type {SourceContextState} from './source-context-outbox';
import {showLoadingText} from './loading-ui';

/** Four independent device/channel declarations; no cross-channel transaction or capture-byte edits. */
export function createCaptureContextUi(api:DesktopApi,root:Document=document,onDraftChange:()=>void=()=>{}){
  const button=root.createElement('button');button.id='capture-context-open';button.type='button';button.className='text-button';button.textContent=moteText('资料说明');root.querySelector('[data-page="screen"] .page-header')!.append(button);
  const dialog=root.createElement('dialog');dialog.id='capture-context-dialog';dialog.className='source-add-dialog capture-context-dialog';
  const header=root.createElement('header');header.className='capture-context-header';const title=root.createElement('h2');title.textContent=moteText('采集资料说明');const dismiss=root.createElement('button');dismiss.type='button';dismiss.className='text-button';dismiss.textContent='×';dismiss.setAttribute('aria-label',moteText('关闭'));header.append(title,dismiss);const body=root.createElement('div');body.className='capture-context-body';dialog.append(header,body);
  const more=root.createElement('details');more.id='capture-context-more';more.className='capture-context-more';const moreTitle=root.createElement('summary');moreTitle.textContent=moteText('更多');more.append(moreTitle);
  const entries=([['activity',moteText('记录时长')],['screen',moteText('保存截图')],['structured',moteText('结构化解析')],['notifications',moteText('通知')]] as const).map(([channel,label])=>{
    const field=root.createElement('label');field.className='capture-context-field';field.append(root.createTextNode(label));
    const input=root.createElement('textarea');input.id=channel==='activity'?'capture-context-description':`capture-context-description-${channel}`;input.dataset.captureContext=channel;input.rows=2;input.maxLength=12000;input.placeholder=moteText('补充这类记录的背景（选填）');input.setAttribute('aria-label',label);
    const scope=root.createElement('small');scope.className='helper';scope.textContent=moteText('适用于这台 Mac 的{0}来源。',label);const message=root.createElement('small');message.id=channel==='activity'?'capture-context-state':`capture-context-state-${channel}`;message.className='helper';message.setAttribute('role','status');field.append(input,scope,message);(channel==='notifications'?more:body).append(field);
    return {channel:channel as CaptureContextChannel,input,message,state:undefined as SourceContextState|undefined,reading:false};
  });
  body.append(more);
  const actions=root.createElement('div');actions.className='actions';const cancel=root.createElement('button');cancel.type='button';cancel.className='secondary';cancel.textContent=moteText('取消');const save=root.createElement('button');save.type='button';save.className='primary';save.textContent=moteText('应用到草稿');save.id='capture-context-save';actions.append(cancel,save);dialog.append(actions);root.body.append(dialog);
  let generation=0,key='',saving=false;
  const drafts=new Map<CaptureContextChannel,{expectedVersion:number;description:string}>();
  const changed=(entry:typeof entries[number])=>Boolean(entry.state&&(entry.input.value!==(drafts.get(entry.channel)?.description??entry.state.pending?.description??entry.state.snapshot.description)||entry.state.conflict||Boolean(drafts.get(entry.channel)&&drafts.get(entry.channel)!.expectedVersion!==entry.state.snapshot.version)));
  const controls=()=>{button.disabled=saving;cancel.disabled=saving;dismiss.disabled=saving;for(const entry of entries)entry.input.disabled=entry.reading||saving||!entry.state||entry.state.error==='denied';save.disabled=saving||entries.some(e=>e.reading)||!entries.some(e=>e.state?.error!=='denied'&&changed(e));};
  const stateMessage=(entry:typeof entries[number])=>{const next=entry.state!;entry.message.replaceChildren(root.createTextNode(next.conflict||drafts.get(entry.channel)&&drafts.get(entry.channel)!.expectedVersion!==next.snapshot.version?moteText('说明已在其他地方更新，请核对后再保存。'):drafts.has(entry.channel)?moteText('有未保存的修改，离开前会提醒。保存后立即生效。'):next.pending?moteText('已保存在本机，等待同步。'):next.error==='denied'?moteText('没有访问权限'):next.error?moteText('暂时无法读取中央说明，可在本机保存后同步。'):''));};
  const clear=()=>{for(const entry of entries){entry.input.value='';entry.message.replaceChildren();entry.state=undefined;entry.reading=false;}};
  async function read(){const revision=++generation;more.open=false;clear();for(const entry of entries){entry.reading=true;showLoadingText(entry.message);}controls();
    await Promise.all(entries.map(async entry=>{try{const next=await api.captureContext(entry.channel);if(revision!==generation||!dialog.open)return;entry.state=next;entry.input.value=drafts.get(entry.channel)?.description??next.pending?.description??next.snapshot.description;stateMessage(entry);}catch(error){if(revision===generation&&dialog.open){entry.message.textContent=moteText('操作未完成，请检查权限与配置后重试');appendDiagnostic(entry.message,error instanceof Error?error.message:String(error));}}finally{if(revision===generation){entry.reading=false;controls();}}}));
  }
  button.addEventListener('click',()=>{if(saving||dialog.open)return;dialog.showModal();void read();});for(const entry of entries)entry.input.addEventListener('input',controls);
  const close=()=>{if(saving)return;generation++;dialog.close();clear();button.focus();};cancel.addEventListener('click',close);dismiss.addEventListener('click',close);dialog.addEventListener('cancel',event=>{event.preventDefault();close();});
  save.addEventListener('click',()=>{
    if(save.disabled)return;
    for(const entry of entries){if(!entry.state||entry.state.error==='denied')continue;const baseline=entry.state.pending?.description??entry.state.snapshot.description;
      if(entry.input.value===baseline&&!entry.state.conflict)drafts.delete(entry.channel);
      else drafts.set(entry.channel,{expectedVersion:entry.state.snapshot.version,description:entry.input.value});
    }
    close();onDraftChange();
  });
  function prepareSave(){
    if(saving)throw Error(moteText('这项后台操作正在进行，请等待完成'));
    const revision=generation,pending=[...drafts.entries()];saving=true;controls();
    return {async persist(){for(const [channel,input] of pending){
      if(revision!==generation)throw Error(moteText('登录会话已变更，请重新打开中央页面。'));
      const next=await api.saveCaptureContext(channel,input);
      if(revision!==generation)throw Error(moteText('登录会话已变更，请重新打开中央页面。'));
      if(next.conflict)throw Error(moteText('说明已在其他地方更新，请核对后再保存。'));
      if(drafts.get(channel)===input)drafts.delete(channel);
      const entry=entries.find(value=>value.channel===channel)!;entry.state=next;stateMessage(entry);
    }},release(){if(revision===generation){saving=false;controls();}}};
  }
  async function persistDrafts(){const task=prepareSave();try{await task.persist();}finally{task.release();}}
  return {dirty:()=>drafts.size>0,prepareSave,save:persistDrafts,reset(){generation++;drafts.clear();dialog.close();clear();saving=false;controls();},update(status:Status){const next=JSON.stringify([status.authorizationGeneration,status.config.deviceId,status.config.serverUrl,status.config.tokenConfigured,status.config.authSignedOut,status.config.authSourceBinding]);if(key&&next!==key){generation++;drafts.clear();dialog.close();clear();saving=false;controls();}key=next;}};
}
