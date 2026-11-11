import {uiRulesSchema,type UiRule} from '@mote/shared';
import {moteText} from '@mote/shared/i18n';
import type {CollectionMode,PublicConfig,Status} from './contracts';
import {captureAppNeedsAttention,captureAppRows,captureRowsInFilter,captureChannelKeys,type CaptureApplication,type CaptureAppFilter,type CaptureAppRow,type CaptureRuleSummary} from './app-capture-model';
import {skeleton,showLoadingText} from './loading-ui';

interface AppCaptureUiOptions {
  root:HTMLElement;defaultRoot:HTMLElement;rulesEditor:HTMLTextAreaElement;
  applications:()=>Promise<CaptureApplication[]>;changed:()=>void;
  editRules:(appId:string)=>void;permissions:()=>void;
}
const element=<K extends keyof HTMLElementTagNameMap>(tag:K,text?:string,className?:string):HTMLElementTagNameMap[K]=>{
  const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node;
};
const labelFor=(key:typeof captureChannelKeys[number])=>key==='duration'?moteText('记录时长'):key==='screenshots'?moteText('保存截图'):moteText('结构化解析');
export function describeCaptureSelection(mode:CollectionMode):string {
  return captureChannelKeys.filter(key=>mode[key]).map(labelFor).join(' · ')||moteText('不采集');
}
function fieldLabel(field:string):string {
  switch(field){case'title':return moteText('标题');case'author':return moteText('作者');case'body':return moteText('正文');case'url':return moteText('链接');case'itemId':return moteText('商品 ID');case'conversation':return moteText('会话标题');case'conversation_count':return moteText('显示消息数');case'text':return moteText('可见文字');case'description':return moteText('可见描述');case'state':return moteText('控件状态');default:return field;}
}
function ruleState(rule:CaptureRuleSummary,selected:boolean):string {
  if(rule.applicability==='unused')return moteText('当前读取器不使用此规则');
  if(rule.applicability==='version_mismatch')return moteText('规则版本不符');
  if(rule.applicability==='version_unknown')return moteText('安装版本待核对');
  if(!selected)return moteText('未开启结构化');
  return rule.source==='browser'?moteText('需扩展连接与站点授权'):moteText('待页面匹配');
}
/** Local settings draft only. Polling status and application discovery never replace choices. */
export function createAppCaptureUi(options:AppCaptureUiOptions) {
  let overrides:Record<string,CollectionMode>={},installed:CaptureApplication[]=[],selected='',filter:CaptureAppFilter='all';
  let platform='macos',screenPermission='unknown',origins:string[]=[],loadError='',loaded=false;
  let loading:Promise<void>|undefined;
  const toolbar=element('div',undefined,'app-capture-toolbar');
  const search=element('input');search.type='search';search.placeholder=moteText('搜索应用名称或 ID');search.setAttribute('aria-label',moteText('搜索应用名称或 ID'));
  const filters=element('div',undefined,'app-capture-filters');filters.setAttribute('role','group');filters.setAttribute('aria-label',moteText('应用范围'));
  const hint=element('p',undefined,'helper');hint.setAttribute('role','status');hint.setAttribute('aria-live','polite');
  const split=element('div',undefined,'app-capture-split'),list=element('div',undefined,'app-capture-list');let detail=element('section',undefined,'app-capture-detail');
  list.setAttribute('aria-label',moteText('应用列表'));detail.setAttribute('aria-label',moteText('应用采集详情'));split.append(list,detail);toolbar.append(search,filters);options.root.replaceChildren(toolbar,hint,split);
  const defaults=():CollectionMode=>Object.fromEntries(captureChannelKeys.map(key=>[key,Boolean(options.defaultRoot.querySelector<HTMLInputElement>(`[data-channel=${key}]`)?.checked)])) as unknown as CollectionMode;
  function parsedRules():UiRule[]|undefined {
    try {return uiRulesSchema.parse(JSON.parse(options.rulesEditor.value||'[]'));}catch{return undefined;}
  }
  const rows=()=>captureAppRows(installed,overrides,defaults(),parsedRules()??[]);
  const channelInputs=()=>Array.from(detail.querySelectorAll<HTMLInputElement>('[data-channel]'));
  function commitSelected(){if(selected&&Object.hasOwn(overrides,selected))for(const input of channelInputs())overrides[selected][input.dataset.channel as keyof CollectionMode]=input.checked;}
  function badge(text:string,warning=false){return element('span',text,warning?'app-capture-badge warning':'app-capture-badge');}
  function structuredCapability(row:CaptureAppRow):string {
    if(parsedRules()===undefined)return moteText('结构化 · 规则格式有误');
    if(platform!=='macos')return moteText('结构化 · 此平台不可用');
    if(row.appId==='com.google.Chrome')return moteText('结构化 · 浏览器扩展');
    if(row.rules.some(rule=>rule.applicability==='available'))return row.appVersion?moteText('结构化 · 当前版本有规则'):moteText('结构化 · 有字段规则');
    if(row.rules.some(rule=>rule.applicability==='version_unknown'))return moteText('结构化 · 版本待核对');
    if(row.rules.some(rule=>rule.applicability==='version_mismatch'))return moteText('结构化 · 规则版本不符');
    if(row.rules.length)return moteText('结构化 · 规则不适用');
    return moteText('结构化 · 暂无字段规则');
  }
  function button(text:string,action:()=>void,className='text-button') {
    const node=element('button',text,className);node.type='button';node.addEventListener('click',action);return node;
  }
  function renderList(){
    const all=rows(),shown=captureRowsInFilter(all,filter,search.value,screenPermission,platform,origins);
    if(!shown.some(row=>row.appId===selected))selected=shown[0]?.appId??'';
    filters.replaceChildren();
    const labels:Record<CaptureAppFilter,string>={all:moteText('全部应用'),custom:moteText('单独设置'),rules:moteText('字段规则'),attention:moteText('需处理')};
    for(const key of ['all','custom','attention'] as const){
      const count=captureRowsInFilter(all,key,'',screenPermission,platform,origins).length;
      const control=button(moteText('{0} {1}',labels[key],count),()=>{commitSelected();filter=key;render();},'secondary');control.dataset.appFilter=key;control.setAttribute('aria-pressed',String(key===filter));filters.append(control);
    }
    list.replaceChildren();
    for(const row of shown){
      const control=button('',()=>{commitSelected();selected=row.appId;render();},'app-capture-app');control.dataset.captureApp=row.appId;control.setAttribute('aria-pressed',String(row.appId===selected));
      const header=element('span',undefined,'app-capture-app-heading');header.append(element('strong',row.appName));
      control.append(header,element('span',describeCaptureSelection(row.selection),'app-capture-selected'));
      if(!row.installed)control.append(element('small',loaded?moteText('未在已安装列表中找到'):moteText('安装状态待读取')));
      list.append(control);
    }
    if(!shown.length)list.append(loaded?element('p',moteText('没有符合此范围的应用'),'helper'):skeleton(list,moteText('正在读取已安装应用…')));
    hint.textContent=loadError||(parsedRules()===undefined?moteText('页面规则格式有误，请在高级规则中修正。'):moteText('{0} 个应用 · 修改后保存生效',shown.length));
  }
  function renderDetail(){
    const row=rows().find(row=>row.appId===selected);detail.replaceChildren();
    if(!row){detail.append(element('p',moteText('选择应用，查看采集内容与字段规则。'),'helper'));return;}
    const heading=element('div',undefined,'app-capture-detail-heading');heading.append(element('h3',row.appName),badge(row.custom?moteText('单独设置'):moteText('沿用默认')));detail.append(heading);
    const capabilityDetails=element('details',undefined,'disclosure app-capture-capabilities');capabilityDetails.append(element('summary',moteText('查看规则与匹配范围')),element('p',row.appId,'helper app-capture-identity'));
    if(row.appVersion)capabilityDetails.append(element('p',moteText('安装版本：{0}',row.appVersion),'helper'));
    const capabilities=element('div',undefined,'app-capture-badges');
    capabilities.append(badge(platform==='macos'?moteText('时长 · 可记录'):moteText('时长 · 此平台不可用')),
      badge(platform!=='macos'?moteText('截图 · 此平台不可用'):screenPermission==='granted'?moteText('截图 · 已授权'):moteText('截图 · 待授权'),screenPermission!=='granted'),badge(structuredCapability(row)));
    capabilityDetails.append(capabilities);
    const follow=element('label',undefined,'checkbox option-row'),inherit=element('input');inherit.type='checkbox';inherit.checked=!row.custom;inherit.dataset.appInherit='true';follow.append(inherit,element('span',moteText('沿用默认范围')));
    inherit.addEventListener('change',()=>{
      if(inherit.checked)delete overrides[row.appId];else overrides[row.appId]={...defaults()};options.changed();render();detail.querySelector<HTMLInputElement>('[data-app-inherit]')?.focus();
    });detail.append(follow);
    for(const key of captureChannelKeys){
      const label=element('label',undefined,'checkbox app-capture-channel'),input=element('input');input.type='checkbox';input.dataset.channel=key;input.checked=row.selection[key];input.disabled=!row.custom;
      const copy=element('span'),title=element('span',labelFor(key));copy.append(title);
      copy.append(element('small',key==='duration'?moteText('记录实际前台使用时长'):key==='screenshots'?moteText('保存当前屏幕图片'):moteText('按规则提取安全可见字段')));label.append(input,copy);detail.append(label);
      input.addEventListener('change',()=>{commitSelected();options.changed();render();detail.querySelector<HTMLInputElement>(`[data-channel=${key}]`)?.focus();});
    }
    if(!captureChannelKeys.some(key=>row.selection[key]))detail.append(element('p',moteText('此应用不产生时长、截图或结构化记录。'),'helper'));
    if(row.selection.structured&&!row.rules.some(rule=>rule.applicability==='available'))detail.append(element('p',moteText('已选择结构化内容，但当前没有可用的字段规则。截图仍按独立选择执行。'),'app-capture-warning'));
    if(row.selection.screenshots&&screenPermission!=='granted')detail.append(button(moteText('查看系统权限'),options.permissions));
    const visibleDetail=detail;detail=capabilityDetails;detail.append(element('h4',moteText('结构化规则')));
    if(!row.rules.length)detail.append(element('p',moteText('没有为此应用配置字段规则。'),'helper'));
    for(const rule of row.rules){
      const item=element('div',undefined,'app-capture-rule'),title=element('div',undefined,'app-capture-rule-heading');
      const kind=rule.kind==='article'?moteText('文章'):rule.kind==='product'?moteText('商品'):rule.kind==='message'?moteText('消息可见字段'):rule.kind==='visible_window'?moteText('浏览器可见页面'):rule.kind==='visible_text'?moteText('可见文字'):rule.kind;
      title.append(element('strong',kind),badge(ruleState(rule,row.selection.structured),['version_mismatch','unused'].includes(rule.applicability)));item.append(title);
      if(rule.fields.length)item.append(element('p',rule.fields.map(fieldLabel).join('、'),'helper'));
      const details=element('details',undefined,'disclosure');details.append(element('summary',moteText('查看规则与匹配范围')),element('p',rule.id,'helper app-capture-identity'));
      const source=rule.source==='builtin'?moteText('内置读取器'):rule.source==='browser'?moteText('浏览器扩展'):moteText('已配置规则');
      details.append(element('p',moteText('来源：{0} · 规则版本：{1}',source,rule.version),'helper'));
      if(rule.appVersion)details.append(element('p',moteText('限定应用版本：{0}',rule.appVersion),'helper'));
      if(rule.source==='browser')details.append(element('p',origins.length?moteText('已配置 {0} 个站点来源；仍需扩展连接与站点授权。',origins.length):moteText('尚未配置允许采集的站点来源。'),'helper'));
      details.append(element('p',moteText('有规则不代表真机验证或已采到内容，实际页面仍需匹配。'),'helper'));item.append(details);detail.append(item);
    }
    detail=visibleDetail;detail.append(capabilityDetails);
    detail.append(button(row.appId==='com.google.Chrome'?moteText('配置站点与扩展'):moteText('查看或编辑页面规则'),()=>options.editRules(row.appId)));
    if(row.custom)detail.append(button(moteText('此应用全部不记录'),()=>{overrides[row.appId]={duration:false,screenshots:false,structured:false};options.changed();render();}));
  }
  function render(){renderList();renderDetail();}
  search.addEventListener('input',event=>{event.stopPropagation();commitSelected();render();});
  search.addEventListener('change',event=>event.stopPropagation());
  options.defaultRoot.addEventListener('change',()=>{commitSelected();render();});
  options.rulesEditor.addEventListener('input',()=>{commitSelected();render();});
  render();
  return {
    setConfig(config:PublicConfig){overrides=structuredClone(config.appCollectionRules);origins=[...config.chromeOrigins];render();},
    setStatus(status:Status){const changed=platform!==status.platform||screenPermission!==status.screenPermission;platform=status.platform;screenPermission=status.screenPermission;if(changed){commitSelected();render();}},
    refreshRules(){commitSelected();render();},
    setOrigins(value:string[]){commitSelected();origins=value;render();},
    readRules(){commitSelected();return structuredClone(overrides);},
    installedApplications(){return structuredClone(installed);},
    addOverride(appId:string,mode:CollectionMode){commitSelected();overrides[appId]={...mode};selected=appId;filter='all';search.value='';options.changed();render();},
    refreshApplications():Promise<void>{
      if(loading)return loading;
      showLoadingText(hint,moteText('正在读取已安装应用…'));loadError='';
      loading=options.applications().then(value=>{commitSelected();installed=value;loaded=true;render();},()=>{loadError=moteText('应用列表读取失败，可重试；已有配置仍可编辑。');render();}).finally(()=>{loading=undefined;});
      return loading;
    },
  };
}
