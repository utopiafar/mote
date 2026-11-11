import type {WorkActivity,WorkActivityPage,WorkState} from '@mote/shared';
import {getLocale,moteText} from '@mote/shared/i18n';
import type {DesktopApi,Status} from './contracts';
import type {DesktopPage} from './navigation';
import {showSkeleton,showLoadingLine} from './loading-ui';

const stateNames:Record<WorkState,string>={waiting:'等待开始',running:'正在进行',needs_input:'需要处理',completed:'已完成',failed:'未能完成',cancelled:'已停止',stale:'资料变化，需要重新检查',excluded:'按设置跳过'};
const stageNames={preparing:'准备资料',planning:'组织工作',searching:'查找资料',checking:'交叉核对',organizing:'整理结果',saving:'保存成果',finished:'工作完成'};
export function workProgressText(work:WorkActivity):string{
  const progress=work.progress;
  if(progress.mode==='determinate')return moteText('已处理 {0} / {1} 条资料',progress.completed,progress.total)+(progress.failed?` · ${moteText('{0} 条资料未完成',progress.failed)}`:'')+(progress.needsInput?` · ${moteText('{0} 条资料等待补充',progress.needsInput)}`:'')+(progress.excluded?` · ${moteText('{0} 条资料按设置跳过',progress.excluded)}`:'');
  return (progress.summary??moteText(stageNames[progress.stage]??'准备资料'))+(progress.returnedItems!==undefined?` · ${moteText('检索已返回 {0} 项资料',progress.returnedItems)}`:'')+(progress.totalBranches!==undefined?` · ${moteText('{0} / {1} 个工作分支已完成',progress.completedBranches??0,progress.totalBranches)}`:'');
}

/** Host-owned reads/polling; layout providers only arrange this stable page slot. */
export function createWorkActivityUi(api:DesktopApi,navigate:(page:DesktopPage)=>void){
  const el=<T extends HTMLElement=HTMLElement>(id:string)=>document.getElementById(id) as T;
  const events=new AbortController();let active=false,disposed=false,generation=0,reading=false,timer:ReturnType<typeof setInterval>|undefined;
  let status:Status|undefined,state:'active'|'attention'|'completed'='active',cursor:number|undefined,nextCursor:number|null=null;
  const cursors:(number|undefined)[]=[undefined];
  const list=el('work-list'),message=el('work-status');
  const append=(tag:string,text:string,root:HTMLElement,className?:string)=>{const node=document.createElement(tag);node.textContent=text;if(className)node.className=className;root.append(node);return node;};
  function clear(){generation++;list.replaceChildren();message.textContent='';list.setAttribute('aria-busy','false');el<HTMLButtonElement>('work-refresh').disabled=false;nextCursor=null;el<HTMLButtonElement>('work-next').disabled=true;el<HTMLButtonElement>('work-previous').disabled=true;}
  function connected(){return Boolean(status?.config.serverUrl&&status.config.tokenConfigured&&!status.config.authSignedOut);}
  function renderLocal(){
    if(!status)return;
    el('work-local-state').textContent=status.config.syncPaused?moteText('全部发送已暂停；本机记录与来源检查继续'):status.sync.message;
    el('work-local-pending').textContent=moteText('待同步 {0} 条',status.sync.pendingRecords.toLocaleString(getLocale()));
    const jobs=el('work-local-jobs');jobs.replaceChildren();
    for(const job of status.operations??[]){const row=document.createElement('li');row.textContent=job.message+(job.total!==undefined?` · ${job.completed??0}/${job.total}`:'');jobs.append(row);}
    el('work-connect').hidden=connected();el('work-tabs').hidden=!connected();
  }
  async function refresh(){
    if(disposed||!active||reading)return;
    if(!connected()){clear();message.textContent=moteText('连接中央后查看资料整理、问答与记忆工作的进展。');return;}
    const version=++generation;reading=true;if(list.childElementCount)showLoadingLine(message);else showSkeleton(message);list.setAttribute('aria-busy','true');el<HTMLButtonElement>('work-refresh').disabled=true;
    try{
      const page:WorkActivityPage=await api.workActivity({state,...(cursor!==undefined?{cursor}:{})});
      if(disposed||version!==generation||!active)return;
      list.replaceChildren();
      for(const work of page.items){const row=document.createElement('article');row.className='work-row';const heading=document.createElement('div');heading.className='work-row-heading';append('h3',work.goal,heading);const badge=append('span',moteText(stateNames[work.state]),heading,'work-state');badge.dataset.state=work.state;row.append(heading);append('p',workProgressText(work),row,'helper');if(work.artifacts.length)append('p',work.artifacts.map(item=>item.title).join(' · '),row,'work-artifacts');const time=append('time',new Date(work.updatedAt).toLocaleString(getLocale()),row) as HTMLTimeElement;time.dateTime=work.updatedAt;const open=document.createElement('button');open.type='button';open.className='text-button';open.textContent=moteText('在中央工作台查看');open.addEventListener('click',()=>void api.openWorkActivity(work.id).catch(error=>{message.textContent=error instanceof Error?error.message:String(error);}));row.append(open);list.append(row);}
      message.textContent=page.items.length?'':moteText(state==='active'?'目前没有正在进行的工作':state==='attention'?'目前没有需要处理的工作':'这里会显示已完成的工作');
      nextCursor=page.nextCursor;el<HTMLButtonElement>('work-next').disabled=nextCursor===null;el<HTMLButtonElement>('work-previous').disabled=cursors.length===1;
    }catch(error){if(!disposed&&version===generation&&active){list.replaceChildren();message.textContent=error instanceof Error?error.message:String(error);}}
    finally{if(version===generation){reading=false;list.setAttribute('aria-busy','false');el<HTMLButtonElement>('work-refresh').disabled=false;}}
  }
  el('work-refresh').addEventListener('click',()=>void refresh(),{signal:events.signal});
  el('work-connect').addEventListener('click',()=>navigate('connection'),{signal:events.signal});
  el('work-uploads').addEventListener('click',()=>navigate('uploads'),{signal:events.signal});
  for(const button of Array.from(el('work-tabs').querySelectorAll<HTMLButtonElement>('[data-work-state]')))button.addEventListener('click',()=>{state=button.dataset.workState as typeof state;cursor=undefined;cursors.splice(0,cursors.length,undefined);clear();reading=false;for(const item of Array.from(el('work-tabs').querySelectorAll('button')))item.setAttribute('aria-pressed',String(item===button));void refresh();},{signal:events.signal});
  el('work-next').addEventListener('click',()=>{if(nextCursor===null)return;cursor=nextCursor;cursors.push(cursor);void refresh();},{signal:events.signal});
  el('work-previous').addEventListener('click',()=>{if(cursors.length===1)return;cursors.pop();cursor=cursors.at(-1);void refresh();},{signal:events.signal});
  return {
    show(){active=true;renderLocal();void refresh();if(!timer)timer=setInterval(()=>void refresh(),5000);},
    hide(){active=false;generation++;reading=false;list.setAttribute('aria-busy','false');el<HTMLButtonElement>('work-refresh').disabled=false;if(timer)clearInterval(timer);timer=undefined;},
    update(next:Status){const changed=status&&(status.authorizationGeneration!==next.authorizationGeneration||status.config.serverUrl!==next.config.serverUrl||status.config.tokenConfigured!==next.config.tokenConfigured||status.config.authSignedOut!==next.config.authSignedOut);status=next;renderLocal();if(changed){clear();reading=false;cursor=undefined;cursors.splice(0,cursors.length,undefined);if(active)void refresh();}},
    dispose(){disposed=true;active=false;generation++;events.abort();if(timer)clearInterval(timer);list.replaceChildren();},
  };
}
