// Translate interface copy only. Data values and user-authored content keep their language.
const userContentSelector='[data-user-content],textarea,pre,.reading-body,.message.user,.material-title,.material-preview,.reading>h1';
const userTextNodeSelector='.chat-history [data-action="open-chat"],[data-action="open-chat"] .material-main>strong,[data-action="open-insight"] .material-main>h3,.todo-item .checkrow>span,[data-import-id] h2,[data-device-id] h2,[data-calendar-entry] h2,.attachment';
function translateUI(text,depth=0){
 const raw=String(text??''),key=raw.trim();
 if(!key||depth>3)return raw;
 if(Object.hasOwn(englishLabels,key))return raw.replace(key,englishLabels[key]);
 let m;
 if((m=key.match(/^删除“(.+)”这次导入及其生成的 (\d+) 份资料。外部原件与其他导入保留。$/)))return 'Delete the import “'+m[1]+'” and the '+m[2]+' material'+(m[2]==='1'?'':'s')+' it created. External originals and other imports are retained.';
 if((m=key.match(/^已保存：(.+) · ([A-Z]{3}) · 输入 (.+) \/ 输出 (.+) \/ 缓存 (.+)$/)))return 'Saved: '+m[1]+' · '+m[2]+' · Input '+m[3]+' / Output '+m[4]+' / Cache '+m[5];
 if((m=key.match(/^先预览和验证，再单独应用。当前仍运行 (.+)。$/)))return 'Preview and validate first, then apply separately. The active scheme is still '+translateUI(m[1],depth+1)+'.';
 if((m=key.match(/^仅允许读取 (.+)$/)))return 'Read-only access to '+translateUI(m[1],depth+1);
 if((m=key.match(/^待发送 (\d+) 项$/)))return m[1]+' items waiting to send';
 if((m=key.match(/^版本：示例 (.+) · 当前绑定：(.+)$/)))return 'Version: Example '+m[1]+' · Active binding: '+translateUI(m[2],depth+1);
 const enumPrefixes={'目标：':'Target: ','历史范围：':'Historical scope: ','状态：':'Status: ','实例：':'Instance: '};
 for(const [prefix,label] of Object.entries(enumPrefixes))if(key.startsWith(prefix))return label+translateUI(key.slice(prefix.length),depth+1);
 const dataPrefixes={'请求 ':'Request ','示例凭据：':'Example credential: ','日期：':'Date: '};
 for(const [prefix,label] of Object.entries(dataPrefixes))if(key.startsWith(prefix))return label+key.slice(prefix.length);

 if((m=key.match(/^(\d+) 条$/)))return m[1]+' item'+(m[1]==='1'?'':'s');
 if((m=key.match(/^文件 \/ (.+)$/)))return 'File / '+m[1];
 if((m=key.match(/^会话 (.+)$/)))return 'Session '+m[1];
 if((m=key.match(/^打开(.+)$/))&&Object.hasOwn(englishLabels,m[1]))return 'Open '+englishLabels[m[1]];
 if((m=key.match(/^(\d+) 项功能 · 按任务分组$/)))return m[1]+' features · Organized by task';
 if((m=key.match(/^找到 (\d+) 项功能$/)))return m[1]+' matching features';
 if((m=key.match(/^(\d+) 份已保存资料$/)))return m[1]+' saved material'+(m[1]==='1'?'':'s');
 if((m=key.match(/^(\d+) 个应用$/)))return m[1]+' app'+(m[1]==='1'?'':'s');
 if((m=key.match(/^已保存 (\d+) 个应用：(.+)$/)))return m[1]+' saved apps: '+translateUI(m[2],depth+1);
 if((m=key.match(/^(浏览器|编辑器|即时通讯)(、(?:浏览器|编辑器|即时通讯))+$/)))return key.split('、').map(x=>translateUI(x,depth+1)).join(', ');
 if((m=key.match(/^(屏幕|文件夹)：(.+)$/)))return ({屏幕:'Screen',文件夹:'Folders'})[m[1]]+': '+translateUI(m[2],depth+1);
 if((m=key.match(/^人工纠正 (\d+)$/)))return 'Manual correction '+m[1];
 if((m=key.match(/^移除(.+)$/)))return 'Remove '+m[1];
 if((m=key.match(/^(.+)的回顾$/)))return 'Review · '+translateUI(m[1],depth+1);
 if((m=key.match(/^按保存日期纳入 (\d+) 份资料$/)))return m[1]+' materials included by save date';
 if((m=key.match(/^本次使用的资料 · (\d+) 份$/)))return 'Materials used · '+m[1];
 if((m=key.match(/^(\d+) 份依据$/)))return m[1]+' source'+(m[1]==='1'?'':'s');
 if((m=key.match(/^核对 (\d+) 份原文依据$/)))return 'Check '+m[1]+' original sources';
 if((m=key.match(/^待同步笔记：(\d+) 条$/)))return 'Notes waiting to sync: '+m[1];
 if((m=key.match(/^附图 (\d+) 张$/)))return m[1]+' attached image'+(m[1]==='1'?'':'s');
 if((m=key.match(/^附图：(.+)$/)))return 'Attached images: '+m[1];
 if((m=key.match(/^到期：(.+)$/)))return 'Due: '+m[1];
 if((m=key.match(/^(\d+) 份资料$/)))return m[1]+' material'+(m[1]==='1'?'':'s');
 if((m=key.match(/^(\d+) 条记录$/)))return m[1]+' record'+(m[1]==='1'?'':'s');
 if((m=key.match(/^(\d+) 项$/)))return m[1]+' item'+(m[1]==='1'?'':'s');
 if((m=key.match(/^第 (\d+) \/ (\d+) 页$/)))return 'Page '+m[1]+' / '+m[2];
 if((m=key.match(/^(\d+(?:\.\d+)?) 秒$/)))return m[1]+' sec';
 if((m=key.match(/^(\d+)小时\s*(\d+)分$/)))return m[1]+' hr '+m[2]+' min';
 if((m=key.match(/^(\d+)分$/)))return m[1]+' min';
 if((m=key.match(/^(\d+)月(\d+)日[–—-](?:(\d+)月)?(\d+)日$/)))return ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][Number(m[1])-1]+' '+m[2]+'–'+(m[3]?['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][Number(m[3])-1]+' ':'')+m[4];
 if((m=key.match(/^(\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2})?) 至 (\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2})?)$/)))return m[1]+' to '+m[2];
 if((m=key.match(/^(\d+)月(\d+)日(.*)$/)))return ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][Number(m[1])-1]+' '+m[2]+m[3];
 if((m=key.match(/^(今天|昨天)(\s+\d{1,2}:\d{2})$/)))return ({今天:'Today',昨天:'Yesterday'})[m[1]]+m[2];
 if((m=key.match(/^(资料|记忆|洞察) \/ (\d+) 项$/)))return ({资料:'Materials',记忆:'Memories',洞察:'Insights'})[m[1]]+' / '+m[2]+' items';
 if((m=key.match(/^来源连接：(\d+) 项 · 可阅读资料：(\d+) 份$/)))return 'Connected sources: '+m[1]+' · Readable materials: '+m[2];
 if((m=key.match(/^已选择 (\d+) 个应用$/)))return m[1]+' selected app'+(m[1]==='1'?'':'s');
 if((m=key.match(/^屏幕录制权限：(.+)$/)))return 'Screen recording permission: '+translateUI(m[1],depth+1);
 if((m=key.match(/^当前版本 · (.+)$/)))return 'Current version · '+translateUI(m[1],depth+1);
 if((m=key.match(/^进度 (\d+)%$/)))return 'Progress '+m[1]+'%';
 if((m=key.match(/^播放进度 (\d+)%$/)))return 'Playback progress '+m[1]+'%';
 if((m=key.match(/^待你澄清 · (\d+)$/)))return 'Needs clarification · '+m[1];
 if((m=key.match(/^按资料保存日期：(.+)$/)))return 'By material save date: '+translateUI(m[1],depth+1);
 if(key.includes(' → '))return key.split(' → ').map(x=>translateUI(x,depth+1)).join(' → ');
 if(key.includes(' · '))return key.split(' · ').map(x=>translateUI(x,depth+1)).join(' · ');
 return raw;
}
function localizeUI(){
 document.documentElement.lang=state.language==='en'?'en':'zh-CN';
 document.title=state.language==='en'?'Mote · Personal library':'Mote · 个人资料库';
 if(state.language!=='en')return;
 const root=document.getElementById('prototype');
 // Display text must never become an option's business value when language changes.
 root.querySelectorAll('option:not([value])').forEach(option=>option.setAttribute('value',option.textContent));
 const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);let node;
 while(node=walker.nextNode()){
  if(node.parentElement.closest(userContentSelector)||node.parentElement.matches(userTextNodeSelector))continue;
  node.textContent=translateUI(node.textContent);
 }
 root.querySelectorAll('[aria-label],[placeholder],[title]').forEach(element=>{
  if(element.closest('[data-user-content]'))return;
  for(const attr of ['aria-label','placeholder','title']){
   const text=element.getAttribute(attr);if(text)element.setAttribute(attr,translateUI(text));
  }
 });
}
