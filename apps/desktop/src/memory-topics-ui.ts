import {moteText} from '@mote/shared/i18n';
import type {DesktopApi,Status} from './contracts';
import type {TopicDirectory,TopicMemory} from './memory-topics';
/** Host labels are untrusted text. Navigation is local; every reopen reads current authority. */
export function createMemoryTopicsUi(api:DesktopApi,root:HTMLDialogElement){
 let generation=0,timer:ReturnType<typeof setTimeout>|undefined,signature='',catalog:TopicDirectory|undefined;
 let treeId='',nodeId:string|undefined,cursors:(string|undefined)[]=[undefined],selected:string|undefined,originButton:HTMLElement|undefined;
 const text=(tag:string,value:string)=>{const node=document.createElement(tag);node.textContent=value;if(tag==='pre')node.className='content-reading-body';return node;};
 const button=(label:string,run:()=>void)=>{const b=document.createElement('button');b.type='button';b.className='secondary';b.style.margin='4px 8px 4px 0';b.textContent=label;b.onclick=run;root.append(b);return b;};
 const valid=(directory:TopicDirectory)=>!nodeId||directory.items.some(tree=>tree.id===treeId&&tree.nodes.some(node=>node.id===nodeId));
 function schedule(){if(timer)clearTimeout(timer);if(root.open)timer=setTimeout(()=>void poll(),5000);}
 function clear(){generation++;if(timer)clearTimeout(timer);root.replaceChildren();}
 function heading(){root.append(text('h2',moteText('记忆主题')));button(moteText('关闭详情'),close);}
 function close(){clear();root.close();originButton?.focus();}
 function unavailable(){clear();heading();root.append(text('p',moteText('此主题已不可用，请返回全部记忆。')));button(moteText('全部记忆'),()=>{nodeId=undefined;selected=undefined;cursors=[undefined];void show();});schedule();}
 function failed(error:unknown){clear();heading();const message=text('p',error instanceof Error?error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''):moteText('操作失败'));message.setAttribute('role','alert');root.append(message);button(moteText('重试'),()=>void show());button(moteText('全部记忆'),()=>{nodeId=undefined;selected=undefined;cursors=[undefined];void show();});schedule();}
 async function poll(){const stamp=generation;try{const next=await api.memoryTopics();if(stamp!==generation||!root.open)return;if(!valid(next)){unavailable();return;}if(JSON.stringify(catalog)!==JSON.stringify(next)&&!selected){catalog=next;await list();}else catalog=next;}catch(error){if(stamp===generation&&root.open)failed(error);}finally{schedule();}}
 async function show(){clear();heading();root.append(text('p',moteText('正在读取…')));const stamp=generation;try{const next=await api.memoryTopics();if(stamp!==generation||!root.open)return;catalog=next;if(!valid(next)){unavailable();return;}if(selected)await detail(selected);else await list();}catch(error){if(stamp===generation&&root.open)failed(error);}finally{schedule();}}
 async function list(){
  if(!catalog)return;clear();heading();const stamp=generation;
  const directory=catalog;const state=directory.classification?.state;
  root.append(text('p',moteText(state==='running'?'正在整理自动主题…':state==='failed'?'自动主题整理未完成；已有记忆仍可浏览。':state==='unavailable'?'自动主题服务尚未就绪；已有记忆仍可浏览。':directory.items.some(t=>t.id.startsWith('auto.'))?'主题是模型整理的浏览视图，不代表新的用户事实。':'尚无自动主题；仍可浏览全部记忆和已有维度。')));
  const tree=directory.items.find(t=>t.id===treeId)??directory.items[0];treeId=tree?.id??'';
  const select=document.createElement('select');select.id='memory-topic-tree';select.setAttribute('aria-label',moteText('浏览维度'));
  for(const entry of directory.items){const option=document.createElement('option');option.value=entry.id;option.textContent=entry.label;select.append(option);}select.value=treeId;select.onchange=()=>{treeId=select.value;nodeId=undefined;cursors=[undefined];void show();};root.append(select);
  button(moteText('全部记忆'),()=>{nodeId=undefined;cursors=[undefined];void show();});
  for(const node of tree?.nodes??[]){const b=button(node.label,()=>{nodeId=node.id;cursors=[undefined];void show();});b.dataset.topic=node.id;b.setAttribute('aria-pressed',String(node.id===nodeId));}
  button(moteText('刷新'),()=>void show());
  const members=document.createElement('div');members.className='content-feed';members.id='memory-topic-members';root.append(members);
  try{const page=await api.memoryTopicPage({...nodeId?{treeId,nodeId}:{},cursor:cursors.at(-1)});if(stamp!==generation||!root.open)return;
   if(!page.items.length)members.append(text('p',moteText('当前筛选下没有匹配的记忆。可切换内容分类或调整筛选条件。')));
   for(const memory of page.items){const b=document.createElement('button');b.className='content-row';b.dataset.memory=memory.id;b.style.gridTemplateColumns='minmax(0,1fr)';const copy=text('span',memory.title);copy.className='content-row-copy';b.append(copy);b.onclick=()=>{selected=memory.id;void show();};members.append(b);}
   if(cursors.length>1)button(moteText('上一页'),()=>{cursors.pop();void show();});
   if(page.nextCursor)button(moteText('下一页'),()=>{cursors.push(page.nextCursor!);void show();});
  }catch(error){if(stamp===generation&&root.open)failed(error);}finally{schedule();}
 }
 async function detail(id:string){clear();heading();const stamp=generation;button(moteText('返回'),()=>{selected=undefined;void show();});try{const memory=await api.memoryTopicDetail(id);if(stamp!==generation||!root.open)return;renderMemory(memory);}catch(error){if(stamp===generation&&root.open)failed(error);}finally{schedule();}}
 function renderMemory(memory:TopicMemory){root.append(text('h3',memory.title),text('p',memory.status),text('pre',memory.statement??''),text('p',memory.uncertainty??''));for(const [index,id] of (memory.evidenceIds??[]).entries())button(moteText('查看原文依据')+' '+(index+1),()=>void original(id));}
 async function original(id:string){clear();heading();const stamp=generation;button(moteText('返回'),()=>void show());try{const result=await api.memoryTopicEvidence(selected!,id);if(stamp!==generation||!root.open)return;const body=text('pre',result.text);body.className='content-reading-body';root.append(body,text('pre',result.metadata??''));}catch(error){if(stamp===generation&&root.open)failed(error);}finally{schedule();}}
 root.addEventListener('cancel',event=>{event.preventDefault();close();});
 return {open(){originButton=document.activeElement as HTMLElement;selected=undefined;if(!root.open)root.showModal();void show();},close,update(status:Status){const next=JSON.stringify([status.authorizationGeneration,status.config.serverUrl,status.config.tokenConfigured,status.config.authSignedOut,status.config.authExpiresAt,status.config.authSourceBinding]);if(signature&&signature!==next){catalog=undefined;nodeId=undefined;selected=undefined;cursors=[undefined];treeId='';if(root.open)close();}signature=next;}};
}
