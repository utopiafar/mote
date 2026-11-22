import {moteText} from '@mote/shared/i18n';
import type {UpdateStatus} from './contracts/settings';

const readyKey=(value:UpdateStatus|undefined)=>value?.state==='ready'&&value.canInstall&&!value.manualDownload?JSON.stringify([value.channel,value.currentVersion,value.availableVersion,value.checkedAt,value.total,value.notesUrl]):undefined;
export function createUpdateInstallUi(root:Document,options:{status():Promise<UpdateStatus>;allowed():boolean;install():Promise<unknown>;failed(error:unknown):void}){
 const dialog=root.createElement('dialog');dialog.id='update-install-dialog';dialog.setAttribute('aria-labelledby','update-install-title');
 const title=root.createElement('h2');title.id='update-install-title';title.textContent=moteText('安装并重启');
 const text=root.createElement('p');text.className='spaced';text.textContent=moteText('先结束输入。安装时暂停采集和上传，资料保留。');
 const actions=root.createElement('div');actions.className='actions spaced';
 const cancel=root.createElement('button');cancel.type='button';cancel.className='secondary';cancel.id='update-install-cancel';cancel.textContent=moteText('取消');
 const confirm=root.createElement('button');confirm.type='button';confirm.className='primary';confirm.id='update-install-confirm';confirm.textContent=moteText('继续安装');
 actions.append(cancel,confirm);dialog.append(title,text,actions);root.body.append(dialog);
 let current:UpdateStatus|undefined,ticket=0,selection:string|undefined,opener:HTMLElement|undefined;
 function close(){ticket++;selection=undefined;if(dialog.open)dialog.close();opener?.focus({preventScroll:true});}
 cancel.addEventListener('click',close);dialog.addEventListener('cancel',event=>{event.preventDefault();close();});
 confirm.addEventListener('click',()=>{if(!dialog.open||!selection||confirm.disabled)return;const own=++ticket,key=selection;confirm.disabled=true;void(async()=>{
   const latest=await options.status();
   if(own!==ticket||!dialog.open)return;
   if(readyKey(current)!==key||readyKey(latest)!==key||!options.allowed()){close();return;}
   close();await options.install();
 })().catch(error=>{if(own===ticket)options.failed(error);}).finally(()=>{if(own===ticket)confirm.disabled=false;});});
 return {
  update(value:UpdateStatus){current=value;if(dialog.open&&readyKey(value)!==selection)close();},
  open(){if(!options.allowed())return;const key=readyKey(current);if(!key)return;selection=key;ticket++;confirm.disabled=false;opener=root.activeElement as HTMLElement;dialog.showModal();cancel.focus();},
 };
}
