/* Shared Central task controls. All execution and credentials here are synthetic UI fixtures. */
(function(){
  'use strict';
  const t=(zh,en)=>state.language==='en'?en:zh;
  const clone=v=>JSON.parse(JSON.stringify(v));
  const act=(label,action,kind='',extra='')=>button(label,'cs-'+
action,extra,kind);
  const route=(label,page,kind='text')=>goButton(label,page,kind);
  const user=v=>'<span data-user-content>'+
esc(v??'')+
'</span>';
  const notice=(text,kind='')=>'<div class="notice '+
kind+
'" role="status"><div>'+
text+
'</div></div>';
  const section=(id,title,body,open=false)=>'<details id="cs-'+
id+
'" class="cs-disclosure" '+
(open?'open':'')+
'><summary>'+
title+
'</summary><div class="cs-disclosure-body">'+
body+
'</div></details>';
  const labels={session:['关闭浏览器后结束','Browser session'],day:['1 天','1 day'],week:['7 天','7 days'],month:['30 天','30 days']};
  function init(){
    const c=state.cs||(state.cs={});
    c.drafts||={};c.messages||={};c.saved||={};c.files||={};c.chats||=[];c.invites||=[];c.assignments||={};c.accounts||=[{name:state.accountName,admin:true,disabled:false},{name:'reviewer',admin:false,disabled:false}];
    c.admin??=state.accountName==='林同学';c.sessionExpires??='2026-11-21T12:00:00Z';c.loginDestination||='library';c.currentChat||='';
    c.providers||=[{id:'personal-demo',name:t('个人示例连接','Personal demo connection'),type:'compatible',protocol:'openai',url:'https://example.invalid/v1',model:'demo-text',catalog:['demo-text','demo-vision'],version:1,keyPresent:false,headersPresent:false,paramsPresent:false,reasoning:'default',speed:'standard',requestTimeout:120,totalTimeout:600,output:8192,local:false,readonly:false}];
    c.providerId||=c.providers[0]?.id||'';
    return c;
  }
  function draft(name,defaults){const c=init();return c.drafts[name]||(c.drafts[name]=clone(defaults));}
  function bind(name,key){return ' data-cs-draft="'+
esc(name)+
'" data-cs-key="'+
esc(key)+
'"';}
  function input(name,key,label,value='',type='text',help='',extra=''){
    return '<label class="field"><span>'+
label+
'</span><input class="field-input" id="cs-'+
name+
'-'+
key+
'"'+
bind(name,key)+
' type="'+
type+
'" value="'+
esc(value)+
'" '+
extra+
'>'+
(help?'<small>'+
help+
'</small>':'')+
'</label>';
  }
  function area(name,key,label,value='',help='',extra=''){
    return '<label class="field"><span>'+
label+
'</span><textarea id="cs-'+
name+
'-'+
key+
'"'+
bind(name,key)+
' '+
extra+
'>'+
esc(value)+
'</textarea>'+
(help?'<small>'+
help+
'</small>':'')+
'</label>';
  }
  function select(name,key,label,value,options){return '<label class="field"><span>'+
label+
'</span><select class="field-input" id="cs-'+
name+
'-'+
key+
'"'+
bind(name,key)+
'>'+
options.map(v=>'<option value="'+
esc(v[0])+
'" '+
(String(value)===String(v[0])?'selected':'')+
'>'+
esc(t(v[1],v[2]||v[1]))+
'</option>').join('')+
'</select></label>';}
  function check(name,key,label,value,help=''){return '<label class="checkrow"><input type="checkbox" id="cs-'+
name+
'-'+
key+
'"'+
bind(name,key)+
' '+
(value?'checked':'')+
'><span>'+
label+
(help?'<small>'+
help+
'</small>':'')+
'</span></label>';}
  function message(key){const m=init().messages[key];return m?notice(esc(m.text),m.error?'warn':'good'):'';}
  function setMessage(key,text,error=false){init().messages[key]={text,error};persist();render();}
  function fields(body){return '<div class="fields cs-fields">'+
body+
'</div>';}
  function download(name,text,type='text/plain'){const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([text],{type}));a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);}
  function currentProvider(){const c=init();return c.providers.find(p=>p.id===c.providerId)||c.providers[0];}
  function providerDraft(){const p=currentProvider();return draft('provider',p?{...p,keyMode:'keep',key:'',headerMode:'keep',headers:'',paramMode:'keep',params:'',reuse:false}:{});}
  function readableDate(value){return value?new Date(value).toLocaleString(state.language==='en'?'en-GB':'zh-CN',{timeZone:'UTC'})+
' UTC':t('浏览器会话','Browser session');}
  function origin(){return state.accountServiceUrl||'https://mote.example.invalid';}

  loginPage=function(){
    const c=init(),d=draft('login',{name:state.loginName||state.accountName||'',password:'',duration:state.accountRetention||'session'});
    return '<section class="auth-card card cs-task"><div class="brand"><span class="brand-icon">m</span>Mote</div><h1>'+
t('登录 Central','Sign in to Central')+
'</h1><p>'+
t('登录后继续当前任务。','Continue the intended task after signing in.')+
'</p>'+
notice(t('交互原型：请使用示例密码 mote-demo；不连接真实账号。','Interactive prototype: use the demo password mote-demo; no real account is contacted.'))+
'<p class="small">Central · '+
user(origin())+
'</p><p class="small">'+
t('返回任务：','Return to: ')+
user(c.loginDestination)+
'</p>'+
message('login')+
(c.loginClosed?'<div class="actions">'+
act(t('继续登录','Continue sign-in'),'login-open','primary')+
'</div>':fields(input('login','name',t('用户名','Username'),d.name,'text')+
input('login','password',t('密码','Password'),'','password')+
select('login','duration',t('保持登录','Keep me signed in'),d.duration,Object.entries(labels).map(([k,v])=>[k,...v]))+
'<div class="form-actions">'+
act(c.loginBusy?t('正在登录…','Signing in…'):t('登录并继续','Sign in and continue'),'login','primary',c.loginBusy?'disabled':'')+
act(t('关闭登录','Close sign-in'),'login-close','subtle')+
'</div>'))+
'</section>';
  };
  accountPage=function(){
    const c=init(),p=draft('password',{current:'',next:''}),a=draft('admin',{name:'',password:'',admin:false});
    let html='<section class="cs-task"><div class="cs-summary"><div><h3 data-user-content>'+
esc(state.accountName)+
'</h3><p>'+
t(c.admin?'管理员':'普通账号',c.admin?'Administrator':'Regular account')+
'</p></div>'+
act(t('切换账号','Switch account'),'switch-account','subtle')+
'</div><dl class="cs-dl"><div><dt>Central</dt><dd>'+
user(origin())+
'</dd></div><div><dt>'+
t('会话到期','Session expiry')+
'</dt><dd>'+
readableDate(c.sessionExpires)+
'</dd></div></dl>'+
message('account')+
'<div class="actions">'+
act(t('退出登录','Sign out'),'sign-out','text')+
'</div>'+
section('password',t('更改密码','Change password'),fields(input('password','current',t('当前密码','Current password'),'','password')+
input('password','next',t('新密码','New password'),'','password')+
message('password')+
act(t('保存新密码','Save new password'),'password-save','primary')))+
section('session',t('会话与客户端批准','Session and client approval'),'<p>'+
t('会话绑定当前 Central 和账号。切换账号后，原账号的资料与草稿不会显示在新账号里。','The session is bound to this Central and account. Switching accounts separates private materials and drafts.')+
'</p>'+
act(t('预览会话过期','Preview session expiry'),'expire-session','subtle')+
route(t('查看客户端批准请求','Review client approval'),'settings/client-approval'))+
'</section>';
    if(c.admin)html+=section('accounts',t('账号管理','Account administration'),message('admin')+
c.accounts.map((a,i)=>'<div class="cs-row"><div><strong data-user-content>'+
esc(a.name)+
'</strong><small>'+
t(a.admin?'管理员':'普通账号',a.admin?'Administrator':'Regular account')+
' · '+
t(a.disabled?'已禁用':'已启用',a.disabled?'Disabled':'Enabled')+
'</small></div><div class="actions">'+
act(t(a.disabled?'启用':'禁用',a.disabled?'Enable':'Disable'),'account-toggle','text','data-index="'+
i+
'" '+
(a.name===state.accountName?'disabled':''))+
act(t('重置密码','Reset password'),'account-reset','text','data-index="'+
i+
'"')+
'</div></div>').join('')+
section('account-create',t('创建账号','Create account'),fields(input('admin','name',t('新用户名','New username'),a.name)+
input('admin','password',t('初始密码','Initial password'),'','password')+
check('admin','admin',t('管理员','Administrator'),a.admin)+
act(t('创建账号','Create account'),'account-create','primary'))));
    return html+
'<section class="section"><h3>'+
t('设备连接','Device connections')+
'</h3><p>'+
t('设备邀请只授权采集与同步。浏览私人资料仍需单独登录。','A device invitation permits collection and sync only. Browsing private material requires a separate sign-in.')+
'</p>'+
route(t('连接或重新授权设备','Connect or re-pair a device'),'setup/device','primary')+
route(t('查看设备报告','View device reports'),'devices')+
'</section>';
  };
  function clientApproval(){const d=draft('approval',{name:'Mac Mote',scope:'collector',account:state.accountName});return fields(input('approval','name',t('客户端名称','Client name'),d.name)+
select('approval','scope',t('请求权限','Requested access'),d.scope,[['collector','采集与同步','Collection and sync'],['login','完整 Central 登录','Full Central sign-in']])+
input('approval','account',t('回执账号','Receipt account'),d.account)+
notice(t('当前批准账号：','Approving as: ')+
user(state.accountName))+
notice(d.scope==='collector'?t('只能向当前账号提交与同步设备资料，不授权私人资料库阅读或管理员操作。','Permits submitting and syncing device material to this account. Private library reads and administration are excluded.'):t('登录凭据允许客户端使用当前账号的 Central 页面与授权能力。','The sign-in credential gives this client the current account’s Central UI and authorized capabilities.'))+
message('approval')+
act(t('批准请求','Approve request'),'approve-client','primary'));}
  function invitationPage(){
    const c=init(),d=draft('invite',{url:origin(),name:'',device:'new'}),i=c.invites.find(x=>x.id===c.selectedInvite),live=i&&!i.cancelled&&Date.now()<i.expires;
    let html=heading(t('连接设备','Connect a device'),t('发出一次性邀请，在目标采集端确认。','Issue a one-use invitation and confirm on the target collector.'),route(t('返回设备','Back to devices'),'devices'))+
'<article class="reading cs-task">';
    if(i){
      const payload=JSON.stringify({demo:true,central:i.url,account:i.account,deviceId:i.device==='new'?null:i.device,name:i.name,invitation:i.token,expiresAt:new Date(i.expires).toISOString()},null,2);
      html+='<section class="cs-zone"><div class="cs-summary"><h2>'+
t('设备邀请','Device invitation')+
'</h2>'+
tag(t(i.cancelled?'已取消':live?'等待采集端确认':'已过期',i.cancelled?'Cancelled':live?'Awaiting collector confirmation':'Expired'),live?'purple':'')+
'</div><p data-user-content>'+
esc(i.name)+
'</p><dl class="cs-dl"><div><dt>Central</dt><dd>'+
user(i.url)+
'</dd></div><div><dt>'+
t('设备身份','Device identity')+
'</dt><dd>'+
user(i.device==='new'?t('新设备','New device'):i.device)+
'</dd></div><div><dt>'+
t('到期时间','Expiry')+
'</dt><dd>'+
readableDate(i.expires)+
'</dd></div><div><dt>'+
t('剩余时间','Time remaining')+
'</dt><dd data-cs-countdown="'+
i.expires+
'">'+
(live?Math.ceil((i.expires-Date.now())/60000):0)+
t(' 分钟',' minutes')+
'</dd></div></dl>'+
notice(t('邀请只授权此账号的设备采集与同步；私人资料库及管理功能需另行登录。关闭页面不会取消邀请。','The invitation authorizes this account’s device collection and sync only; library and administration require separate sign-in. Closing this page does not cancel the invitation.'))+
message('invite')+
'<div class="actions">'+
act(t('复制 JSON','Copy JSON'),'invite-copy','primary',live?'':'disabled')+
act(t('下载 JSON','Download JSON'),'invite-download','subtle',live?'':'disabled')+
'</div>'+
section('invite-manual',t('手动复制内容 / 二维码不可用时','Manual copy / QR fallback'),'<p>'+
t('此离线原型不生成可扫描凭据。请用 JSON 演示交付；不会真实配对设备。','This offline prototype does not generate a scannable credential. Use JSON to demonstrate delivery; it does not pair a real device.')+
'</p><textarea class="cs-code" readonly aria-label="Invitation JSON" data-user-content>'+
esc(payload)+
'</textarea>')+
'<div class="actions section">'+
act(t('重新生成邀请','Regenerate invitation'),'invite-generate','subtle')+
act(t('取消这份邀请','Cancel this invitation'),'invite-cancel','text',live?'':'disabled')+
act(t('关闭详情','Close detail'),'invite-close','text')+
'</div></section>';
    }
    return html+
section('invite-form',t('邀请地址与设备身份','Invitation address and device identity'),fields(input('invite','url',t('设备可访问的 Central 地址','Device-reachable Central address'),d.url,'url',t('目标设备不能通过 localhost 访问另一台机器；请使用它可访问的 HTTPS 地址。','A device cannot reach another machine through localhost. Use an HTTPS address it can reach.'))+
input('invite','name',t('连接名称','Connection name'),d.name)+
select('invite','device',t('新建或重新授权设备','New or existing device'),d.device,[['new','新设备','New device'],...state.devices.map(x=>[x.id,x.name,x.name])])+
message('invite-form')+
act(t('生成一次性邀请','Generate one-use invitation'),'invite-generate','primary')),!i)+
'</article>';
  }
  const originalSetup=setupPage;
  setupPage=function(){if(state.page==='setup/device')return invitationPage();return originalSetup();};

  function providerPage(){
    const c=init(),p=currentProvider(),d=providerDraft();if(!p)return '<p>'+
t('没有连接。','No connections.')+
'</p>'+
act(t('创建连接','Create connection'),'provider-new','primary');
    const disabled=p.readonly?'disabled':'';
    return '<div class="cs-task"><div class="cs-summary">'+
select('provider-choice','id',t('当前连接','Connection'),p.id,c.providers.map(x=>[x.id,x.name,x.name]))+
act(t('新建连接','Create connection'),'provider-new','subtle')+
'</div>'+
notice(p.readonly?t('部署提供的只读预设；可以复制为个人连接。','Read-only deployment preset; copy it to a personal connection.'):t('个人连接。测试使用当前草稿，保存后才会用于新任务。','Personal connection. Testing uses the draft; new tasks use it after saving.'))+
message('provider')+
fields(input('provider','name',t('预设名称','Preset name'),d.name,'text','',disabled)+
select('provider','type',t('提供商类型','Provider type'),d.type,[['compatible','兼容服务','Compatible service'],['openai','OpenAI','OpenAI'],['anthropic','Anthropic','Anthropic'],['local','本机服务','Local service'],['codex','Codex 管理','Codex-managed']])+
select('provider','protocol',t('协议','Protocol'),d.protocol,[['openai','OpenAI 兼容','OpenAI-compatible'],['anthropic','Anthropic Messages','Anthropic Messages']])+
input('provider','url',t('Base URL','Base URL'),d.url,'url')+
input('provider','model',t('默认模型 / 手动模型 ID','Default model / manual ID'),d.model)+
act(t('刷新可用模型目录','Refresh model catalogue'),'provider-catalog','subtle')+
(d.catalog?.length?'<p class="small">'+
t('目录：','Catalogue: ')+
d.catalog.map(user).join(' · ')+
'</p>':'')+
'<p class="small muted">'+
t('目录可见不代表模型支持工具调用。实际兼容性需要真实环境验证。','Catalogue visibility does not prove tool support. Compatibility needs a real environment check.')+
'</p>')+
section('provider-secrets',t('凭据与高级参数','Credentials and advanced parameters'),fields(select('provider','keyMode',t('API Key 操作','API key operation'),d.keyMode,[['keep','保留已有','Keep existing'],['replace','替换','Replace'],['clear','清除','Clear']])+
input('provider','key',t('新 API Key（仅示例）','New API key (demo only)'),'','password',t('保存后清空输入；已保存值不回显。','The raw entry is cleared after saving; stored values are never displayed.'))+
select('provider','headerMode',t('请求头操作','Header operation'),d.headerMode,[['keep','保留已有','Keep existing'],['replace','替换 JSON','Replace JSON'],['clear','清除','Clear']])+
area('provider','headers',t('新请求头 JSON','New headers JSON'),d.headers)+
select('provider','paramMode',t('高级参数操作','Advanced parameter operation'),d.paramMode,[['keep','保留已有','Keep existing'],['replace','替换 JSON','Replace JSON'],['clear','清除','Clear']])+
area('provider','params',t('新高级参数 JSON','New advanced parameters JSON'),d.params)+
check('provider','reuse',t('地址变更后仍允许复用已有凭据','Allow existing credentials at the changed destination'),d.reuse)))+
section('provider-performance',t('能力、速度与超时','Capabilities, speed and timeouts'),fields(select('provider','reasoning',t('推理强度','Reasoning strength'),d.reasoning,[['default','默认','Default'],['low','低','Low'],['medium','中','Medium'],['high','高','High']])+
select('provider','speed',t('服务速度','Service tier'),d.speed,[['standard','Standard','Standard'],['fast','Fast（需模型支持）','Fast (requires model support)']])+
input('provider','requestTimeout',t('单次请求超时（秒）','Request timeout (seconds)'),d.requestTimeout,'number','',d.type==='codex'?'disabled':'min="1"')+
input('provider','totalTimeout',t('Agent 总执行超时（秒）','Agent total execution timeout (seconds)'),d.totalTimeout,'number',t('排队等待时间不计入执行超时。','Queue wait is excluded from execution timeout.'),'min="1"')+
input('provider','output',t('输出 Token 预算','Output token budget'),d.output,'number',t('预算不是固定回答长度。Codex 管理的请求与输出选项不可在这里更改。','The budget is not a fixed response length. Codex-managed request/output options cannot be changed here.'),d.type==='codex'?'disabled':'min="1"')+
check('provider','local',t('允许无认证的 loopback 本机服务','Allow unauthenticated loopback service'),d.local)))+
'<div class="form-actions">'+
act(t('保存并应用','Save and apply'),'provider-save','primary',disabled)+
act(t('测试当前草稿','Test current draft'),'provider-test','subtle')+
act(t('恢复已保存值','Restore saved values'),'provider-restore','text')+
'</div>'+
(c.providerTest?notice(esc(c.providerTest.text),c.providerTest.error?'warn':'good'):'')+
section('provider-effective',t('当前生效值与预设管理','Effective values and preset management'),'<dl class="cs-dl"><div><dt>'+
t('已保存版本','Saved version')+
'</dt><dd>'+
p.version+
'</dd></div><div><dt>'+
t('默认模型','Default model')+
'</dt><dd>'+
user(p.model)+
'</dd></div><div><dt>Base URL</dt><dd>'+
user(p.url)+
'</dd></div><div><dt>'+
t('凭据 / 请求头 / 高级参数','Credential / headers / parameters')+
'</dt><dd>'+
[p.keyPresent,p.headersPresent,p.paramsPresent].map(x=>t(x?'已保留':'未配置',x?'Present':'Absent')).join(' / ')+
'</dd></div></dl>'+
act(t('复制为独立预设','Copy as independent preset'),'provider-copy','subtle')+
act(t('删除此预设','Delete preset'),'provider-delete','text')+
act(t('预览版本冲突','Preview version conflict'),'provider-conflict','text'))+
'</div>';
  }
  function assignmentPage(){const c=init(),d=draft('assignments',c.assignments);return notice(t('每次提问的显式模型选择优先于模块默认；文件处理器与本机限制仍优先。','An explicit per-question model overrides the module default; file processor and local constraints still take precedence.'))+
fields(['ask','memory','insight','working','vision','transcription','import'].map((k,i)=>select('assignments',k,t(['问一问','记忆提取与整合','洞察','工作记忆','图片理解','音频转写','导入格式理解'][i],['Ask','Memory extraction and integration','Insights','Working memory','Vision','Transcription','Import format understanding'][i]),d[k]||'', [['','未分配','Unassigned'],...c.providers.map(p=>[p.id,p.name+
' / '+
p.model,p.name+
' / '+
p.model])])+
input('assignments',k+
'Model',t('具体模型 ID（留空跟随连接默认）','Specific model ID (blank follows preset default)'),d[k+
'Model']||'')).join('')+
message('assignments')+
act(t('保存模块分配','Save assignments'),'assignments-save','primary')+
route(t('管理模型连接','Manage model connections'),'settings/providers'));}
  function fileRecord(m){const c=init();return c.files[m.id]||(c.files[m.id]={version:1,raw:m.body,segments:m.body.split('\n').filter(Boolean).map((text,i)=>({id:'seg-'+
i,text,raw:text,speaker:'S'+
(i%2+
1),from:i*6,to:i*6+
6})),names:{},stages:{extraction:'succeeded',diarization:m.type==='audio'?'succeeded':'skipped',alignment:m.type==='audio'?'succeeded':'skipped',grouping:'waiting',summary:'waiting'},attempts:[],corrections:[],suggestions:[],config:{model:'demo-speaker',count:'unknown',exact:2,min:1,max:4},receipt:null});}
  const stageNames={extraction:['正文 / 原始转写','Body / raw transcript'],diarization:['说话人分组','Speaker grouping'],alignment:['时间对齐','Time alignment'],grouping:['语义分组','Semantic grouping'],summary:['摘要','Summary']};
  const statuses={waiting:['等待','Waiting'],running:['进行中','Running'],succeeded:['已完成','Succeeded'],skipped:['已跳过','Skipped'],blocked:['受阻','Blocked'],failed:['失败','Failed'],cancelled:['已取消','Cancelled'],unknown:['结果未知','Unknown outcome']};
  function statusLabel(v){return t(...(statuses[v]||[v,v]));}
  function filePage(m){
    const f=fileRecord(m),d=draft('file-'+
m.id,{...f.config,segment:'seg-0',text:f.segments[0]?.text||'',speaker:'S1',name:'',exportType:'transcript',history:'current',bytes:'metadata'}),running=Object.values(f.stages).includes('running');
    return heading(t('文件处理详情','File processing detail'),m.title,route(t('返回文件与录音','Back to files and recordings'),'library/files'))+
'<article class="reading cs-task" data-cs-file="'+
m.id+
'"><section class="cs-zone"><div class="cs-summary"><h2>'+
t('已归档原件','Archived original')+
'</h2>'+
tag(t('已保留','Retained'),'green')+
'</div><p data-user-content>'+
esc(m.origin)+
'</p><p class="small">'+
t('来源位置消失不会自动删除已归档副本。原件、正文、摘要分别保留。','An unavailable source location does not remove the archived copy. Original, body and summary are separate products.')+
'</p>'+
(m.type==='audio'?'<audio controls class="cs-audio" data-cs-audio aria-label="'+
t('合成音频试听','Synthetic audio sample')+
'"></audio><p class="small muted">'+
t('演示试听为合成短音频；不包含真实录音。浏览器不支持时可下载示例原件。','Playback uses a short synthetic fixture. Download is available if the browser cannot play the codec.')+
'</p>':'')+
'<div class="actions">'+
act(t('下载示例原件','Download fixture original'),'file-original','subtle','data-id="'+
m.id+
'"')+
route(t('阅读当前正文','Read current body'),'material/'+
m.id)+
'</div></section><section class="cs-zone"><h2>'+
t('处理状态','Processing status')+
'</h2>'+
message('file-'+
m.id)+
'<dl class="cs-dl">'+
Object.entries(f.stages).map(([k,v])=>'<div><dt>'+
t(...stageNames[k])+
'</dt><dd>'+
statusLabel(v)+
'</dd></div>').join('')+
'</dl><p class="small">'+
t('本文件方案：使用已保存的文件处理规则。原始转写可阅读，后续分人或摘要失败不移除它。','Strategy: the saved file processing rule. A later grouping or summary failure keeps the readable raw transcript.')+
'</p><div class="actions">'+
act(t('刷新','Refresh'),'file-refresh','text','data-id="'+
m.id+
'"')+
(running?act(t('取消本次处理','Cancel processing'),'file-cancel','text','data-id="'+
m.id+
'"'):act(t('重试正文提取','Retry extraction'),'file-process','subtle','data-id="'+
m.id+
'" data-stage="extraction"')+
act(t('重新生成摘要','Regenerate summary'),'file-process','subtle','data-id="'+
m.id+
'" data-stage="summary"'))+
'</div>'+
(f.receipt?'<p class="small" data-user-content>'+
esc(f.receipt.id)+
' · '+
statusLabel(f.receipt.status)+
'</p>':'')+
'</section>'+
section('file-stages',t('采用的规则、尝试与恢复','Rule, attempts and recovery'),'<p>'+
t('匹配依据：文件类型与显式来源规则；不会按内容关键词选择策略。','Matched by file type and explicit source rule; content keywords do not select the strategy.')+
'</p>'+
route(t('查看文件处理规则','View file processing rules'),'settings/file-processing')+
(f.attempts.length?f.attempts.map(a=>'<p class="small">'+
user(a.id)+
' · '+
t(...stageNames[a.stage])+
' · '+
statusLabel(a.status)+
'</p>').join(''):'<p>'+
t('尚未重试。','No retry yet.')+
'</p>'))+
(m.type==='audio'?section('file-speakers',t('单文件分人设置','Speaker settings for this file'),fields(select('file-'+
m.id,'model',t('分人模型','Speaker model'),d.model,[['demo-speaker','本机示例分人模型','Local demo speaker model'],['unavailable','未配置的服务','Unconfigured service']])+
select('file-'+
m.id,'count',t('人数范围','Speaker count'),d.count,[['unknown','未知','Unknown'],['exact','准确人数','Exact count'],['range','已知范围','Known range']])+
input('file-'+
m.id,'exact',t('准确人数','Exact count'),d.exact,'number','','min="1"')+
input('file-'+
m.id,'min',t('最少人数','Minimum'),d.min,'number','','min="1"')+
input('file-'+
m.id,'max',t('最多人数','Maximum'),d.max,'number','','min="1"')+
'<p class="small">'+
t('仅对这份文件重做匿名声学分组，沿用原始转写；不会推断真实身份。','Redo anonymous acoustic grouping for this file using its raw transcript; identities are not inferred.')+
'</p>'+
act(t('应用并重新分人','Apply and redo separation'),'file-speakers-save','primary','data-id="'+
m.id+
'"'))):'')+
section('file-segments',t('校对文段','Correct segments'),'<div class="cs-segments">'+
f.segments.map(s=>'<article><div class="small muted">'+
s.from+
'–'+
s.to+
's · '+
user(s.speaker)+
(f.names[s.speaker]?' · '+
user(f.names[s.speaker]):'')+
'</div><p data-user-content>'+
esc(s.text)+
'</p>'+
act(t('编辑这一段','Edit segment'),'file-segment-select','text','data-id="'+
m.id+
'" data-segment="'+
s.id+
'"')+
'</article>').join('')+
'</div>'+
fields(area('file-'+
m.id,'text',t('所选文段的修正','Correction for selected segment'),d.text)+
act(t('保存人工修正','Save manual correction'),'file-segment-save','primary','data-id="'+
m.id+
'"')+
act(t('取消修改','Cancel edit'),'file-segment-cancel','text','data-id="'+
m.id+
'"'))+
'<p class="small">'+
t('人工校对不会调用模型；原文件与原始转写保留。','Manual correction makes no model call; the original file and raw transcript remain.')+
'</p>'+
section('file-lineage',t('原始转写与修正历史','Raw transcript and correction history'),'<p data-user-content>'+
esc(f.raw)+
'</p>'+
f.corrections.map(v=>'<p>'+
user(v.segment)+
' · v'+
v.version+
' · '+
user(v.text)+
'</p>').join('')))+
(m.type==='audio'?section('file-names',t('试听与确认说话人姓名','Listen and confirm speaker names'),fields(select('file-'+
m.id,'speaker',t('匿名分组','Anonymous group'),d.speaker,[['S1','S1','S1'],['S2','S2','S2']])+
act(t('试听合成片段','Play synthetic sample'),'file-speaker-play','subtle','data-id="'+
m.id+
'"')+
input('file-'+
m.id,'name',t('你确认的姓名','Human-confirmed name'),d.name)+
act(t('确认姓名','Confirm name'),'file-name-save','primary','data-id="'+
m.id+
'"'))+
'<p class="small">'+
t('重叠与不确定音频保留不确定标记；声学得分不是身份概率。','Overlapping or uncertain audio keeps its uncertainty; acoustic scores are not identity probabilities.')+
'</p>'):'')+
section('file-review',t('场次与术语复核','Session and terminology review'),'<div class="actions">'+
act(t('请求场次匹配（模拟）','Request session match (simulate)'),'file-session-review','subtle','data-id="'+
m.id+
'"')+
act(t('检查识别错误（模拟）','Review recognition (simulate)'),'file-review','subtle','data-id="'+
m.id+
'"')+
'</div>'+
(f.session?'<p>'+
user(f.session)+
'</p>':'')+
f.suggestions.map((s,i)=>'<article class="cs-suggestion"><p data-user-content>'+
esc(s.text)+
'</p><p>'+
t('状态：','Status: ')+
user(s.status)+
'</p>'+
act(t('采用此建议','Accept suggestion'),'file-suggestion','subtle','data-id="'+
m.id+
'" data-index="'+
i+
'" data-outcome="confirmed"')+
act(t('忽略','Reject'),'file-suggestion','text','data-id="'+
m.id+
'" data-index="'+
i+
'" data-outcome="ignored"')+
'</article>').join('')+
'<p class="small">'+
t('建议需要你逐条确认，原始转写不会自动被覆盖；原文版本变化后旧建议失效。','Confirm suggestions individually. Raw transcription is not overwritten; a changed original invalidates old suggestions.')+
'</p>')+
section('file-export',t('导出与删除','Export and delete'),fields(select('file-'+
m.id,'exportType',t('导出内容','Export content'),d.exportType,[['transcript','转写正文','Transcript'],['speakers','说话人','Speakers'],['archive','文件归档','File archive']])+
select('file-'+
m.id,'history',t('版本','Versions'),d.history,[['current','当前版本','Current versions'],['retained','获授权保留的历史','Authorized retained history']])+
select('file-'+
m.id,'bytes',t('文件内容','File contents'),d.bytes,[['metadata','仅元数据','Metadata only'],['files','文件与附件','Files and attachments']])+
act(t('生成导出文件','Create export'),'file-export','subtle','data-id="'+
m.id+
'"'))+
act(t('删除中央归档…','Delete Central archive…'),'file-delete','text','data-id="'+
m.id+
'"'))+
'</article>';
  }
  const originalMaterial=materialPage;
  materialPage=function(){const parts=state.page.split('/'),m=state.materials.find(x=>x.id===parts[1]);if(m&&parts[2]==='processing')return filePage(m);const html=originalMaterial();return m&&['file','audio'].includes(m.type)?html+
'<div class="reading section">'+
route(t('文件、转写与处理详情','File, transcript and processing details'),'material/'+
m.id+
'/processing','subtle')+
'</div>':html;};
  const originalLibraryView=libraryView;
  libraryView=function(rows,filtering){if(state.filter!=='files')return originalLibraryView(rows,filtering);return '<div class="cs-row"><p class="small muted">'+
rows.length+
t(' 份文件与录音',' files and recordings')+
'</p>'+
route(t('文件处理规则','File processing rules'),'settings/file-processing')+
'</div>'+
(rows.length?rows.map(m=>'<div class="source-row"><div class="source-main"><h3 data-user-content>'+
esc(m.title)+
'</h3><p>'+
user(m.source)+
' · '+
t('原件、正文与处理状态','Original, body and processing status')+
'</p></div><div class="actions">'+
route(t('打开文件详情','Open file detail'),'material/'+
m.id+
'/processing','subtle')+
route(t('阅读正文','Read body'),'material/'+
m.id)+
'</div></div>').join(''):emptyLibrary(filtering));};

  function chat(){const c=init();return c.chats.find(x=>x.id===c.currentChat);}
  function askPageNew(){
    const c=init(),q=chat(),d=draft('ask',{question:state.draftQuery||'',provider:'',model:'',images:[]}),p=c.providers.find(x=>x.id===d.provider),turns=q?.turns||[];
    if(state.page==='ask/history')return heading(t('对话历史','Conversation history'),t('返回同一对话，核对当时的回答与证据。','Return to the same conversation and inspect its recorded answer and evidence.'),act(t('新建对话','New conversation'),'ask-new','primary'))+
(c.chats.length?c.chats.map(h=>'<div class="cs-row"><div><strong data-user-content>'+
esc(h.title)+
'</strong><small>'+
h.turns.length+
t(' 轮 · ',' turns · ')+
statusLabel(h.turns.at(-1)?.status||'waiting')+
'</small></div>'+
act(t('继续对话','Continue'),'ask-open','subtle','data-id="'+
h.id+
'"')+
'</div>').join(''):'<div class="empty"><h2>'+
t('还没有新对话','No conversations yet')+
'</h2><p>'+
t('发送问题后，对话与每轮附件会保留在这里。','After sending, each conversation and its per-turn attachments are retained here.')+
'</p></div>');
    return heading(t('问一问','Ask'),t('围绕已归档资料提问，并沿引用核对。','Ask about archived material and inspect its citations.'),route(t('历史对话','Conversation history'),'ask/history')+
route(t('待你澄清','Clarifications'),'ask/clarifications'))+
'<article class="reading cs-task"><div class="cs-summary"><p class="small muted">'+
t('只读问答 · 此原型使用明确的合成输出，不运行模型。','Read-only questions · this prototype uses explicit synthetic output without a model call.')+
'</p>'+
act(t('新建对话','New conversation'),'ask-new','text')+
'</div>'+
turns.map((r,i)=>'<section class="cs-turn" data-cs-turn="'+
r.id+
'"><div class="message user"><p data-user-content>'+
esc(r.question)+
'</p>'+
(r.images.length?'<p class="small">'+
r.images.map(x=>user(x.name)).join(' · ')+
'</p>':'')+
'</div><div class="message answer"><p class="small muted">'+
statusLabel(r.status)+
' · '+
user(r.model)+
'</p>'+
(r.status==='succeeded'?'<h3>'+
t('合成证据回执','Synthetic evidence receipt')+
'</h3><p>'+
t('以下是本轮选择的示例证据原文；原型不会据此自动推断你的意图或结论。','These are exact excerpts of the sample evidence selected for this turn. The prototype does not infer your intent or conclusions from them.')+
'</p>'+
r.evidence.map(e=>'<blockquote data-user-content>'+
esc(e.excerpt)+
'</blockquote>'+
(state.materials.some(m=>m.id===e.id)?route(e.title+
' · '+
t('查看引用','Open citation'),'material/'+
e.id):'<p>'+
t('引用原件已移除；不从当前记忆重建。','The cited original was removed; it is not reconstructed from current memory.')+
'</p>')).join(''):r.status==='running'?'<p>'+
t('正在生成；离开页面后可回到同一对话。','Generating; you can leave and return to this conversation.')+
'</p>':r.status==='unknown'?'<p>'+
t('进度连接中断，服务端可能仍在继续。刷新使用同一受理编号。','Progress connection interrupted; work may continue on the server. Refresh uses the same admission ID.')+
'</p>':'<p>'+
t('本轮未完成，已提交的问题和附件仍保留。','This turn is incomplete; its submitted question and attachments are retained.')+
'</p>')+
'<div class="actions">'+
(r.status==='running'?act(t('停止生成','Stop generation'),'ask-stop','text','data-index="'+
i+
'"'):['failed','cancelled','unknown'].includes(r.status)?act(t(r.status==='unknown'?'重连进度':'重试这轮',r.status==='unknown'?'Reconnect progress':'Retry turn'),'ask-retry','subtle','data-index="'+
i+
'"'):'')+
'</div>'+
section('turn-'+
r.id,t('本轮用量与读取记录','Turn usage and read records'),'<p>'+
t('原型真实模型调用：0；示例回执不代表已执行模型检索。','Actual model calls in this prototype: 0. A synthetic receipt does not establish model retrieval.')+
'</p><p>'+
t('受理编号：','Admission ID: ')+
user(r.admission)+
'</p>'+
route(t('查看实际记录说明','Inspect actual-record availability'),'settings/agent-events'))+
'</div></section>').join('')+
message('ask')+
'<section class="cs-zone">'+
fields(area('ask','question',t('输入问题','Question'),d.question,t('Enter 发送；Shift+Enter 换行。','Enter sends; Shift+Enter adds a line.'))+
select('ask','provider',t('本轮模型连接','Provider for this question'),d.provider,[['','跟随提问模块默认','Follow Ask module default'],...c.providers.map(x=>[x.id,x.name,x.name])])+
input('ask','model',t('本轮模型 ID（留空跟随默认）','Model ID for this question (blank follows default)'),d.model)+
'<div class="cs-attachment-list">'+
(d.images||[]).map((x,i)=>'<span>'+
user(x.name)+
act(t('移除','Remove'),'ask-image-remove','text','data-index="'+
i+
'"')+
'</span>').join('')+
'</div><label class="field"><span>'+
t('附加图片（最多 4 张，每张 8 MiB）','Attach images (up to 4, 8 MiB each)')+
'</span><input id="cs-ask-images" type="file" accept="image/png,image/jpeg,image/webp" multiple></label>')+
'<div class="form-actions">'+
act(t('发送问题','Send question'),'ask-send','primary',turns.at(-1)?.status==='running'?'disabled':'')+
route(t('配置模型','Configure model'),'settings/providers')+
'</div></section>'+
(q?section('chat-more',t('对话管理与恢复演示','Conversation management and recovery preview'),act(t('删除整段对话…','Delete conversation…'),'ask-delete','text')+
act(t('预览进度中断','Preview interrupted progress'),'ask-demo-unknown','text')+
act(t('预览失败重试','Preview failed turn'),'ask-demo-failed','text')):'')+
'</article>';
  }
  const originalCentralAction=doAction;
  doAction=function(action,el){if(action==='ask-material'){const c=init();c.currentChat='';c.drafts.ask={question:'',provider:'',model:'',images:[]};}return originalCentralAction(action,el);};
  const originalAsk=askPage;
  askPage=function(){init();if(state.page==='ask/clarifications')return originalAsk();return askPageNew();};

  function modelsHome(){
    const c=init(),job=state.imports.find(x=>x.id===state.focus?.returnImport),d=draft('model-module',{module:job?'import':'ask',provider:c.assignments[job?'import':'ask']||c.providers[0]?.id||'',model:c.assignments[(job?'import':'ask')+'Model']||''});
    if(job&&d.importJob!==job.id){d.module='import';d.importJob=job.id;d.provider=c.assignments.import||d.provider||c.providers[0]?.id||'';d.model=c.assignments.importModel||'';}
    const context=job?notice(t('正在恢复导入：','Recovering import: ')+user(job.name)+'<p>'+t('该任务需要导入格式理解模型。文件、解析方案和说明仍属于原导入。','This task needs an import format-understanding model. Its files, parser and context remain attached to the original import.')+'</p>'):'';
    return '<div class="cs-task">'+context+message('model-module')+fields(select('model-module','module',t('要配置的模块','Module to configure'),d.module,[['ask','问一问','Ask'],['import','导入格式理解','Import format understanding'],['memory','记忆','Memory'],['insight','洞察','Insights'],['vision','图片理解','Vision'],['transcription','音频转写','Transcription']])+select('model-module','provider',t('模型连接','Provider preset'),d.provider,[['','未分配','Unassigned'],...c.providers.map(p=>[p.id,p.name,p.name])])+input('model-module','model',t('模型 ID（留空跟随连接默认）','Model ID (blank follows provider default)'),d.model)+'<div class="form-actions">'+act(t('保存模块设置','Save module settings'),'model-module-save','primary')+route(t('管理连接与凭据','Manage providers and credentials'),'settings/providers')+'</div>')+section('model-more',t('所有模块与处理方式','All modules and processing settings'),Object.entries(configurationDefs).filter(([id,v])=>v.parent==='models').map(([id,v])=>'<div class="cs-row"><div><strong>'+t(v.title,({providers:'Model providers',assignments:'Module assignments',images:'Images and original access','image-history':'Process existing images','file-processing':'Files and speech',concurrency:'Execution capacity',advanced:'Retrieval and source connections'})[id]||v.title)+'</strong></div>'+route(t('打开','Open'),'settings/'+id)+'</div>').join(''))+'</div>';
  }
  function deploymentSettings(){
    const c=init();c.deployment||={saved:{vectorModel:'demo-embedding',vectorURL:'http://127.0.0.1:8080',sourceInterval:15,mcpRead:true,mcpWrite:false,mcpSources:'',callback:'https://example.invalid/callback'},effective:null,version:1};c.deployment.effective||=clone(c.deployment.saved);const d=draft('deployment',c.deployment.saved),v=c.deployment;
    return '<div class="cs-task">'+notice(t('个人连接与来源间隔保存后立即生效。实例检索模型和监听配置由管理员管理，保存后会明确显示是否仍需部署重启。','Personal connections and source intervals apply when saved. Instance retrieval/listener configuration is administrator-managed and explicitly shows any pending deployment restart.'))+message('deployment')+fields(input('deployment','vectorModel',t('向量检索模型','Embedding model'),d.vectorModel)+input('deployment','vectorURL',t('向量服务地址','Embedding service URL'),d.vectorURL,'url')+input('deployment','sourceInterval',t('来源同步间隔（分钟）','Source interval (minutes)'),d.sourceInterval,'number','','min="1"')+check('deployment','mcpRead',t('允许 MCP 只读检索','Allow MCP read-only retrieval'),d.mcpRead)+check('deployment','mcpWrite',t('允许指定来源写入','Allow source-scoped writes'),d.mcpWrite)+input('deployment','mcpSources',t('允许写入的来源 ID','Allowed write source IDs'),d.mcpSources)+input('deployment','callback',t('OAuth 回调地址','OAuth callback URL'),d.callback,'url')+'<div class="form-actions">'+act(t('保存设置','Save settings'),'deployment-save','primary')+act(t('恢复已保存值','Restore saved values'),'deployment-restore','text')+act(t('刷新实际生效值','Refresh effective values'),'deployment-refresh','subtle')+'</div>')+section('deployment-effective',t('已保存与当前生效','Saved and currently effective'),'<dl class="cs-dl">'+Object.keys(v.saved).map(k=>'<div><dt>'+esc(k)+'</dt><dd>'+t('保存：','Saved: ')+user(String(v.saved[k]))+'<br>'+t('生效：','Effective: ')+user(String(v.effective[k]))+(v.saved[k]!==v.effective[k]?' · '+t('需部署重启','Deployment restart required'):'')+'</dd></div>').join('')+'</dl><p class="small">'+t('刷新只读取当前生效值；这里没有执行重启的按钮。','Refresh reads effective values; this screen does not execute a restart.')+'</p>',true)+'</div>';
  }

  configurationDefs['client-approval']={title:'客户端批准',desc:'核对账号、客户端和凭据范围',parent:'account'};
  const originalSettingsDetail=settingsDetail;
  settingsDetail=function(id){init();if(id==='models')return modelsHome();if(id==='advanced')return deploymentSettings();if(id==='providers')return providerPage();if(id==='assignments')return assignmentPage();if(id==='client-approval')return clientApproval();return originalSettingsDetail(id);};
  function closeAndSave(){state.modal='';persist();render();}
  async function digest(value){const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value));return [...new Uint8Array(bytes)].map(x=>x.toString(16).padStart(2,'0')).join('');}
  async function login(){
    const c=init(),d=draft('login',{}),name=(d.name||'').trim(),password=d.password||'',duration=d.duration||'session',target=c.loginDestination||'library';
    const known=c.accounts.find(x=>x.name===name),stored=demoAccounts[name],expected=stored?.cs?.passwordHash||c.accountPasswords?.[name];
    if(!name||!password)return setMessage('login',t('请填写用户名和密码。','Enter a username and password.'),true);
    if(known?.disabled)return setMessage('login',t('此账号已禁用。','This account is disabled.'),true);
    const valid=expected?(await digest(password))===expected:password==='mote-demo';
    d.password='';if(!valid)return setMessage('login',t('用户名或密码不正确，请重试。','The username or password is incorrect. Try again.'),true);
    c.loginBusy=true;persist();render();
    const ui={surface:state.surface,theme:state.theme,language:state.language},accounts=clone(c.accounts),passwords=c.accountPasswords||{};
    state=stored?clone(stored):{...clone(initialDefaults),dataState:'empty',materials:[],sources:[],devices:[],imports:[],todos:[],askHistory:[],memoryDeleted:true,accessGrants:[],permission:'未授权',cs:{admin:known?.admin||false,accounts,accountPasswords:passwords}};
    Object.assign(state,ui,{authenticated:true,accountName:name,loginName:'',accountError:'',modal:'',toast:'',toastAction:'',page:target,accountRetention:duration});
    const next=init();next.loginBusy=false;next.loginDestination=target;next.messages.login=null;next.sessionExpires=duration==='session'?null:new Date(Date.now()+
({day:1,week:7,month:30}[duration]||1)*86400000).toISOString();
    delete next.drafts.login;location.hash='/'+
target;persist();render();
  }
  function logout(expired=false){const c=init();c.loginDestination=state.page==='login'?c.loginDestination:state.page;c.loginClosed=false;c.drafts.login={name:state.accountName,password:'',duration:state.accountRetention||'session'};delete c.drafts.password;rememberDemoAccount();state.authenticated=false;state.modal='';state.page='login';if(expired)c.messages.login={text:t('会话已过期。登录后继续原任务；草稿仍保留。','Your session expired. Sign in to continue the same task; drafts are retained.'),error:true};location.hash='/login';persist();render();}
  function validateProvider(d,p){
    if(!d.name?.trim()||!d.model?.trim())return t('填写预设名称和模型 ID。','Enter a preset name and model ID.');
    let url;try{url=new URL(d.url);}catch{return t('填写有效的 Base URL。','Enter a valid Base URL.');}
    if(!['https:','http:'].includes(url.protocol))return t('地址需使用 HTTP 或 HTTPS。','Use HTTP or HTTPS.');
    if(d.local&&!['localhost','127.0.0.1','[::1]'].includes(url.hostname))return t('无认证例外仅适用于 loopback 本机服务。','Unauthenticated access is only for loopback services.');
    if(d.url!==p.url&&(p.keyPresent||p.headersPresent)&&d.keyMode==='keep'&&!d.reuse)return t('目的地址已改变。确认复用凭据，或替换/清除已有凭据后再保存。','The destination changed. Confirm credential reuse or replace/clear credentials before saving.');
    for(const [mode,key] of [['headerMode','headers'],['paramMode','params']])if(d[mode]==='replace'){try{const v=JSON.parse(d[key]);if(!v||typeof v!=='object'||Array.isArray(v))throw Error();}catch{return t('请求头和高级参数必须是 JSON 对象；草稿已保留。','Headers and advanced parameters must be JSON objects; your draft is retained.');}}
    if(d.keyMode==='replace'&&!d.key)return t('替换凭据时请填写新的示例 Key。','Enter a new demo key when replacing credentials.');
    if([d.requestTimeout,d.totalTimeout,d.output].some(v=>!Number.isFinite(Number(v))||Number(v)<=0))return t('超时与输出预算必须大于零。','Timeouts and output budget must be positive.');
    return '';
  }
  function finishTurn(q,r){if(r.status!=='running')return;r.status='succeeded';r.finishedAt=new Date().toISOString();r.evidence=r.pendingEvidence||r.evidence||[];delete r.pendingEvidence;persist();render();}
  function syntheticAudio(){
    const rate=8000,length=rate,buffer=new ArrayBuffer(44+
length*2),v=new DataView(buffer);const write=(at,s)=>[...s].forEach((x,i)=>v.setUint8(at+
i,x.charCodeAt(0)));
    write(0,'RIFF');v.setUint32(4,36+
length*2,true);write(8,'WAVE');write(12,'fmt ');v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);v.setUint32(24,rate,true);v.setUint32(28,rate*2,true);v.setUint16(32,2,true);v.setUint16(34,16,true);write(36,'data');v.setUint32(40,length*2,true);for(let i=0;i<length;i++)v.setInt16(44+
i*2,Math.sin(i*2*Math.PI*440/rate)*1400,true);return buffer;
  }
  async function perform(action,el){
    const c=init(),id=el.dataset.id,m=state.materials.find(x=>x.id===id),f=m?fileRecord(m):null;
    if(action==='login')return login();
    if(action==='login-open'){c.loginClosed=false;persist();return render();}
    if(action==='login-close'){c.loginClosed=true;persist();return render();}
    if(['switch-account','sign-out'].includes(action))return logout();
    if(action==='expire-session')return logout(true);
    if(action==='password-save'){
      const d=draft('password',{}),expected=c.passwordHash||await digest('mote-demo');
      if(await digest(d.current||'')!==expected)return setMessage('password',t('当前密码不正确。','The current password is incorrect.'),true);
      if(!d.next?.trim())return setMessage('password',t('新密码不能为空。','The new password cannot be empty.'),true);
      c.passwordHash=await digest(d.next);c.drafts.password={current:'',next:''};rememberDemoAccount();return setMessage('password',t('新密码已保存。本账号下次登录使用新密码。','New password saved. Use it next time you sign in to this account.'));
    }
    if(action==='account-create'){
      if(!c.admin)return;const d=draft('admin',{});if(!d.name?.trim()||!d.password)return setMessage('admin',t('请填写新用户名和初始密码。','Enter the new username and initial password.'),true);
      if(c.accounts.some(a=>a.name===d.name.trim()))return setMessage('admin',t('用户名已存在。','That username already exists.'),true);
      const name=d.name.trim();c.accounts.push({name,admin:!!d.admin,disabled:false});(c.accountPasswords||={})[name]=await digest(d.password);c.drafts.admin={name:'',password:'',admin:false};return setMessage('admin',t('账号已创建；没有向管理员开放其私人资料。','Account created; its private archive is not exposed to the administrator.'));
    }
    if(action==='account-toggle'){if(!c.admin)return;const a=c.accounts[Number(el.dataset.index)];if(a&&a.name!==state.accountName){a.disabled=!a.disabled;return setMessage('admin',t('账号启用状态已更新。','Account enabled state updated.'));}return;}
    if(action==='account-reset'){if(!c.admin)return;c.resetAccount=Number(el.dataset.index);return showInfo(t('重置密码','Reset password'),c.accounts[c.resetAccount].name,fields(input('reset-password','next',t('替换密码','Replacement password'),'','password')+
message('reset-password')+
act(t('保存替换密码','Save replacement password'),'account-reset-save','primary')));}
    if(action==='account-reset-save'){if(!c.admin)return;const next=draft('reset-password',{}).next;if(!next)return setMessage('reset-password',t('替换密码不能为空。','Enter a replacement password.'),true);const name=c.accounts[c.resetAccount].name;(c.accountPasswords||={})[name]=await digest(next);if(demoAccounts[name]){demoAccounts[name].cs||={};demoAccounts[name].cs.passwordHash=c.accountPasswords[name];}delete c.drafts['reset-password'];state.modal='';return setMessage('admin',t('密码已重置。','Password reset.'));}
    if(action==='approve-client'){const d=draft('approval',{});if(d.account!==state.accountName)return setMessage('approval',t('回执账号与当前账号不一致，未批准。','The receipt account differs from the current account. Approval is blocked.'),true);c.approvalReceipt={...d,time:new Date().toISOString()};return setMessage('approval',t(d.scope==='collector'?'已记录采集端批准；不授予资料库阅读。':'已记录 Central 登录批准。',d.scope==='collector'?'Collector approval recorded; library reading is excluded.':'Central sign-in approval recorded.'));}
    if(action==='invite-generate'){
      const d=draft('invite',{});let url;try{url=new URL(d.url);}catch{return setMessage('invite-form',t('请填写设备可访问的 Central 地址。','Enter a device-reachable Central address.'),true);}
      if(!['http:','https:'].includes(url.protocol)||!d.name?.trim())return setMessage('invite-form',t('填写连接名称和有效的 HTTP(S) 地址。','Enter a connection name and valid HTTP(S) address.'),true);
      if(c.selectedInvite){const old=c.invites.find(x=>x.id===c.selectedInvite);if(old)old.cancelled=true;}
      const i={id:'inv-'+
Date.now(),token:'DEMO-NOT-A-CREDENTIAL-'+
Date.now(),url:d.url,name:d.name.trim(),device:d.device,account:state.accountName,expires:Date.now()+
600000,cancelled:false,returnTask:state.nuSetupReturn||''};c.invites.push(i);c.selectedInvite=i.id;c.messages.invite=null;persist();return render();
    }
    if(action.startsWith('invite-')){
      const i=c.invites.find(x=>x.id===c.selectedInvite);if(!i)return;
      if(action==='invite-close'){c.selectedInvite='';persist();return go('devices');}
      if(action==='invite-cancel'){i.cancelled=true;return setMessage('invite',t('邀请已取消；这份凭据不能再使用。关闭详情不会产生此效果。','Invitation cancelled; this credential can no longer be used. Closing the detail alone does not cancel it.'));}
      if(i.cancelled||Date.now()>=i.expires)return setMessage('invite',t('邀请已失效，请重新生成。','Invitation is no longer valid. Regenerate it.'),true);
      const payload=JSON.stringify({demo:true,central:i.url,account:i.account,deviceId:i.device==='new'?null:i.device,name:i.name,invitation:i.token,expiresAt:new Date(i.expires).toISOString()},null,2);
      if(action==='invite-copy'){try{await navigator.clipboard.writeText(payload);return setMessage('invite',t('示例 JSON 已复制。邀请仍等待确认。','Demo JSON copied. The invitation is still awaiting confirmation.'));}catch{return setMessage('invite',t('浏览器未允许复制，请展开手动复制内容。','Clipboard access was unavailable. Expand the manual-copy content.'),true);}}
      if(action==='invite-download'){download('mote-device-invitation-demo.json',payload,'application/json');return setMessage('invite',t('已生成示例 JSON 文件。','Demo JSON file generated.'));}
      if(action==='invite-ack'){
        const deviceId=i.device==='new'?'demo-device-'+
Date.now():i.device;let dev=state.devices.find(x=>x.id===deviceId);if(!dev){dev={id:deviceId,name:i.name,platform:state.surface==='android'?'Android':'Mac',status:'示例已确认',last:'合成回执',pending:0};state.devices.push(dev);}else{dev.status='示例已确认';dev.last='合成回执';}i.acknowledged=true;i.device=deviceId;c.deviceReceipt={id:deviceId,invite:i.id,returnTask:i.returnTask};state.nuFolderDevice=deviceId;return setMessage('invite',t('已记录模拟设备确认。这里只演示连接回执，没有连接真实设备。','Simulated device acknowledgment recorded. No real device was connected.'));
      }
    }
    if(action==='model-module-save'){
      const d=draft('model-module',{}),p=c.providers.find(x=>x.id===d.provider);if(!p)return setMessage('model-module',t('请选择一个已配置的模型连接。','Select a configured provider.'),true);c.assignments[d.module]=p.id;c.assignments[d.module+'Model']=d.model;delete c.drafts.assignments;state.modelReady=!!c.assignments.ask;
      return setMessage('model-module',t('模块设置已保存：','Module settings saved: ')+d.module+' / '+(d.model||p.model));
    }
    if(action==='deployment-save'){
      const d=draft('deployment',{});if(Number(d.sourceInterval)<1)return setMessage('deployment',t('同步间隔必须大于零。','The source interval must be positive.'),true);try{new URL(d.vectorURL);new URL(d.callback);}catch{return setMessage('deployment',t('请填写有效的服务与回调地址。','Enter valid service and callback URLs.'),true);}const v=c.deployment;v.saved=clone(d);v.version++;for(const k of ['sourceInterval','mcpRead','mcpWrite','mcpSources','callback'])v.effective[k]=d[k];return setMessage('deployment',t('设置已保存。来源与个人授权立即生效；检索部署差异在下方单独显示。','Settings saved. Source and personal access settings apply immediately; retrieval deployment differences are shown below.'));
    }
    if(action==='deployment-restore'){c.drafts.deployment=clone(c.deployment.saved);return setMessage('deployment',t('已恢复保存值。','Restored saved values.'));}
    if(action==='deployment-refresh')return setMessage('deployment',t('已刷新实际生效值；未执行部署重启。','Effective values refreshed; no deployment restart was executed.'));
    if(action==='provider-new'){const p={...clone(c.providers[0]),id:'provider-'+
Date.now(),name:t('新个人连接','New personal connection'),model:'',url:'https://example.invalid/v1',version:1,keyPresent:false,headersPresent:false,paramsPresent:false,readonly:false};c.providers.push(p);c.providerId=p.id;delete c.drafts.provider;c.messages.provider=null;persist();return render();}
    if(action==='provider-catalog'){const d=providerDraft();d.catalog=['demo-text','demo-vision'];return setMessage('provider',t('示例目录已刷新；没有访问真实服务，工具能力尚未验证。','Sample catalogue refreshed. No real service was called; tool compatibility remains unverified.'));}
    if(action==='provider-test'){
      const p=currentProvider(),d=providerDraft(),error=validateProvider(d,p);c.providerTest={error:!!error,text:error||t('草稿测试演示成功 · 合成输入 · 32 ms · 未保存；生效连接仍为 ','Draft test simulation succeeded · synthetic input · 32 ms · not saved; effective preset remains ')+
p.name};persist();return render();
    }
    if(action==='provider-save'){
      const p=currentProvider(),d=providerDraft();if(p.readonly)return;const error=validateProvider(d,p);if(error)return setMessage('provider',error,true);
      if(d.version!==p.version)return setMessage('provider',t('保存冲突：已保存版本已变化。你的草稿保留；明确恢复已保存值后再编辑。','Version conflict: saved values changed. Your draft is retained; explicitly restore saved values before editing again.'),true);
      const present=(mode,value)=>mode==='clear'?false:mode==='replace'?true:value;
      const saved={...d,version:p.version+
1,keyPresent:present(d.keyMode,p.keyPresent),headersPresent:present(d.headerMode,p.headersPresent),paramsPresent:present(d.paramMode,p.paramsPresent)};
      for(const k of ['key','headers','params','keyMode','headerMode','paramMode','reuse'])delete saved[k];Object.assign(p,saved);delete c.drafts.provider;c.providerTest=null;state.modelReady=true;return setMessage('provider',t('已保存并立即用于后续任务。密钥输入已清空；之前的请求记录保持原版本。','Saved and effective for new tasks. Raw credentials cleared; earlier request records retain their original version.'));
    }
    if(action==='provider-restore'){delete c.drafts.provider;c.providerTest=null;return setMessage('provider',t('已载入当前保存的版本。','Reloaded the current saved version.'));}
    if(action==='provider-conflict'){currentProvider().version++;persist();return setMessage('provider',t('已模拟另一个窗口保存新版本。当前草稿仍保留；保存时将核对版本。','Simulated a newer save in another window. This draft remains intact; saving will check its version.'));}
    if(action==='provider-copy')return showInfo(t('复制模型预设','Copy model preset'),currentProvider().name,fields(input('copy-provider','name',t('副本名称','Copy name'),draft('copy-provider',{name:currentProvider().name+
' copy',secrets:false}).name)+
check('copy-provider','secrets',t('一并复制隐藏凭据与高级参数','Also copy hidden credentials and parameters'),draft('copy-provider',{}).secrets)+
act(t('创建副本','Create copy'),'provider-copy-save','primary')));
    if(action==='provider-copy-save'){const d=draft('copy-provider',{}),p=currentProvider(),copy={...clone(p),id:'provider-'+
Date.now(),name:d.name||p.name+
' copy',readonly:false,version:1};if(!d.secrets)copy.keyPresent=copy.headersPresent=copy.paramsPresent=false;c.providers.push(copy);c.providerId=copy.id;delete c.drafts.provider;delete c.drafts['copy-provider'];return closeAndSave();}
    if(action==='provider-delete'){const p=currentProvider(),owners=Object.entries(c.assignments).filter(([k,v])=>v===p.id).map(([k])=>k);if(owners.length)return setMessage('provider',t('此预设仍由以下模块使用：','This preset is still used by: ')+
owners.join(', '),true);return showInfo(t('删除未使用的预设？','Delete unused preset?'),p.name,'<p>'+
t('历史对话和旧请求记录保留。','Historical conversations and request records remain.')+
'</p>'+
act(t('确认删除','Confirm deletion'),'provider-delete-confirm','danger'));}
    if(action==='provider-delete-confirm'){c.providers=c.providers.filter(x=>x.id!==c.providerId);c.providerId=c.providers[0]?.id||'';delete c.drafts.provider;return closeAndSave();}
    if(action==='assignments-save'){c.assignments=clone(draft('assignments',{}));state.modelReady=!!c.assignments.ask;return setMessage('assignments',t('模块默认已保存。新任务将使用这些分配。','Module defaults saved. New tasks will use these assignments.'));}
    if(action==='ask-new'){c.currentChat='';c.drafts.ask={question:'',provider:'',model:'',images:[]};state.askMaterialId=null;c.messages.ask=null;return go('ask');}
    if(action==='ask-open'){c.currentChat=id;return go('ask');}
    if(action==='ask-image-remove'){draft('ask',{}).images.splice(Number(el.dataset.index),1);persist();return render();}
    if(action==='ask-send'){
      const d=draft('ask',{});if(!d.question?.trim())return setMessage('ask',t('先输入问题。','Enter a question first.'),true);
      const provider=c.providers.find(p=>p.id===(d.provider||c.assignments.ask))||(state.modelReady?c.providers[0]:null);if(!provider){c.returnTask='ask';return setMessage('ask',t('提问模型未就绪。问题和附件已保留，请配置连接并分配给提问。','The Ask model is not ready. Your question and attachments are retained; configure and assign a provider.'),true);}
      let q=chat();if(!q){q={id:'chat-'+
Date.now(),title:d.question,turns:[]};c.chats.unshift(q);c.currentChat=q.id;}
      const r={id:'turn-'+
Date.now(),admission:'ask-admission-'+
Date.now(),question:d.question,images:clone(d.images||[]),provider:provider.id,model:d.model||c.assignments.askModel||provider.model,status:'running',evidence:[],pendingEvidence:(state.askMaterialId?state.materials.filter(x=>x.id===state.askMaterialId):state.materials.slice(0,2)).map(m=>({id:m.id,title:m.title,excerpt:m.body.split('\n')[0],revision:m.updatedAt||m.saved||'demo-v1'}))};q.turns.push(r);d.question='';d.images=[];c.messages.ask=null;persist();render();setTimeout(()=>finishTurn(q,r),500);return;
    }
    if(['ask-stop','ask-retry'].includes(action)){const q=chat(),r=q?.turns[Number(el.dataset.index)];if(!r)return;r.status=action==='ask-stop'?'cancelled':'running';persist();render();if(r.status==='running')setTimeout(()=>finishTurn(q,r),350);return;}
    if(action==='ask-demo-unknown'||action==='ask-demo-failed'){const r=chat()?.turns.at(-1);if(r){r.status=action==='ask-demo-unknown'?'unknown':'failed';persist();render();}return;}
    if(action==='ask-delete')return showInfo(t('删除整段对话？','Delete this conversation?'),chat()?.title||'', '<p>'+
t('删除此对话的全部轮次与本轮附件引用；来源归档仍保留。','All turns and per-turn attachment references are deleted; source archives remain.')+
'</p>'+
act(t('删除整段对话','Delete conversation'),'ask-delete-confirm','danger')+
button(t('取消','Cancel'),'close-modal','','subtle'));
    if(action==='ask-delete-confirm'){c.chats=c.chats.filter(x=>x.id!==c.currentChat);c.currentChat='';return closeAndSave();}
    if(f){
      const d=draft('file-'+
m.id,{});
      if(action==='file-original'){if(m.type==='audio'){const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([syntheticAudio()],{type:'audio/wav'}));a.download='synthetic-original.wav';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);}else download('synthetic-original-'+
m.id+
'.txt',f.raw);return setMessage('file-'+
m.id,t('示例原件已生成；与当前正文修正分开。','Fixture original generated separately from current body corrections.'));}
      if(action==='file-refresh')return setMessage('file-'+
m.id,t('已刷新这份文件的保存状态。','Refreshed this file’s saved state.'));
      if(action==='file-cancel'){Object.keys(f.stages).forEach(k=>{if(f.stages[k]==='running')f.stages[k]='cancelled';});if(f.receipt)f.receipt.status='cancelled';return setMessage('file-'+
m.id,t('本次处理已取消，原件和已经保存的产品保留。','Processing cancelled; the original and saved products remain.'));}
      if(action==='file-process'||action==='file-speakers-save'){
        if(Object.values(f.stages).includes('running'))return setMessage('file-'+
m.id,t('当前步骤仍在运行，不能重复重试。','The current step is still running; it cannot be retried yet.'),true);
        const stage=action==='file-speakers-save'?'diarization':el.dataset.stage;
        if(stage==='diarization'){
          if(d.model==='unavailable'){f.stages.diarization='blocked';return setMessage('file-'+
m.id,t('分人服务未配置；原始转写保留。请先配置文件与语音服务。','Speaker service is unconfigured; the raw transcript remains. Configure file and speech services first.'),true);}
          if((d.count==='exact'&&Number(d.exact)<1)||(d.count==='range'&&(Number(d.min)<1||Number(d.max)<Number(d.min))))return setMessage('file-'+
m.id,t('请填写有效的人数或范围。','Enter a valid count or range.'),true);
          f.config={model:d.model,count:d.count,exact:d.exact,min:d.min,max:d.max};
        }
        const attempt={id:'file-attempt-'+
Date.now(),stage,status:'running'};f.attempts.push(attempt);f.stages[stage]='running';f.receipt={id:'file-operation-'+
Date.now(),status:'running'};persist();render();setTimeout(()=>{if(f.stages[stage]!=='running')return;f.stages[stage]='succeeded';attempt.status='succeeded';f.receipt.status='succeeded';setMessage('file-'+
m.id,t('模拟处理已完成。原始转写保留，结果仍属于这份文件。','Simulated processing completed. The raw transcript is retained and results belong to this same file.'));},450);return;
      }
      if(action==='file-segment-select'){const s=f.segments.find(x=>x.id===el.dataset.segment);d.segment=s.id;d.text=s.text;persist();return render();}
      if(action==='file-segment-save'){const s=f.segments.find(x=>x.id===d.segment);if(!s)return;s.text=d.text;f.version++;f.corrections.push({segment:s.id,text:s.text,version:f.version,kind:'manual'});m.body=f.segments.map(x=>x.text).join('\n');return setMessage('file-'+
m.id,t('人工修正已保存为独立修订；没有模型调用。','Manual correction saved as a distinct revision; no model call.'));}
      if(action==='file-segment-cancel'){d.text=f.segments.find(x=>x.id===d.segment)?.text||'';persist();return render();}
      if(action==='file-speaker-play'){const audio=document.querySelector('[data-cs-audio]');if(audio){audio.currentTime=0;audio.play().catch(()=>setMessage('file-'+
m.id,t('浏览器不能播放此示例，可下载原件。','The browser could not play this fixture; download it instead.'),true));}return;}
      if(action==='file-name-save'){if(!d.name?.trim())return setMessage('file-'+
m.id,t('请填写你确认的姓名。','Enter a name you have confirmed.'),true);f.names[d.speaker]=d.name;return setMessage('file-'+
m.id,t('姓名确认已保存；匿名声学标记仍保留。','Confirmed name saved; the anonymous acoustic label remains.'));}
      if(action==='file-session-review'){f.session=t('示例候选场次：设计评审（待你确认；不自动关联日历）','Sample session candidate: Design review (awaiting confirmation; no automatic calendar association)');persist();return render();}
      if(action==='file-review'){f.suggestions.push({text:(f.segments[0]?.text||'')+
t('［人工核对示例］',' [review fixture]'),segment:f.segments[0]?.id,version:f.version,status:'pending'});persist();return render();}
      if(action==='file-suggestion'){const s=f.suggestions[Number(el.dataset.index)];if(s.version!==f.version){s.status='stale';return setMessage('file-'+
m.id,t('正文版本已变化，这条旧建议已失效。','The body version changed; this old suggestion is stale.'),true);}s.status=el.dataset.outcome;if(s.status==='confirmed'){const seg=f.segments.find(x=>x.id===s.segment);seg.text=s.text;f.version++;f.corrections.push({segment:seg.id,text:seg.text,version:f.version,kind:'accepted-suggestion'});m.body=f.segments.map(x=>x.text).join('\n');}persist();return render();}
      if(action==='file-export'){const result={demo:true,fileId:m.id,title:m.title,type:d.exportType,versions:d.history,scope:d.bytes,current:f.segments,names:f.names,history:d.history==='retained'?f.corrections:undefined,original:d.bytes==='files'?f.raw:undefined};download('mote-file-'+
m.id+
'-export.json',JSON.stringify(result,null,2),'application/json');return setMessage('file-'+
m.id,t(d.bytes==='metadata'?'导出回执已保存：仅元数据，不含原件字节。':'导出回执已保存：包含本原型保留的合成文件内容。',d.bytes==='metadata'?'Export receipt saved: metadata only, without original file bytes.':'Export receipt saved: includes retained synthetic fixture content.'));}
      if(action==='file-delete')return showInfo(t('删除中央归档？','Delete Central archive?'),m.title,'<p>'+
t('删除 Central 中此原件、正文和派生产物；设备上的原文件仍保留。默认阻止重复采集，之后可明确允许。','Removes this Central original, body and derived products; the device original remains. Recollection is blocked until explicitly allowed.')+
'</p>'+
act(t('确认删除中央归档','Confirm deletion'),'file-delete-confirm','danger','data-id="'+
m.id+
'"'));
      if(action==='file-delete-confirm'){c.deletedFiles||=[];c.deletedFiles.push({id:m.id,title:m.title,status:'cleanup_pending',blocked:true});state.materials=state.materials.filter(x=>x.id!==m.id);state.modal='';persist();return go('library/files');}
    }
  }
  document.addEventListener('click',event=>{
    const el=event.target.closest('[data-action]');if(!el||!el.dataset.action.startsWith('cs-'))return;event.preventDefault();event.stopImmediatePropagation();if(el.disabled)return;Promise.resolve(perform(el.dataset.action.slice(3),el)).catch(error=>{console.error('Central UI action failed',error);setMessage('central',t('操作未完成；输入仍保留。','The action did not finish; inputs are retained.'),true);});
  },true);
  function saveInput(el){
    if(!el.dataset.csDraft)return false;const name=el.dataset.csDraft,key=el.dataset.csKey;draft(name,{})[key]=el.type==='checkbox'?el.checked:el.value;
    if(name==='provider-choice'){init().providerId=el.value;delete init().drafts.provider;init().providerTest=null;persist();render();return true;}
    persist();return true;
  }
  document.addEventListener('input',e=>saveInput(e.target));
  document.addEventListener('change',e=>{
    if(e.target.id==='cs-ask-images'){
      const d=draft('ask',{});d.images||=[];const files=[...e.target.files];
      if(d.images.length+
files.length>4)return setMessage('ask',t('每轮最多 4 张图片。','Up to four images per turn.'),true);
      if(files.some(f=>!['image/png','image/jpeg','image/webp'].includes(f.type)||f.size>8*1024*1024))return setMessage('ask',t('仅支持 PNG/JPEG/WebP，每张最多 8 MiB；未添加不符合的选择。','Only PNG/JPEG/WebP up to 8 MiB each are supported; invalid selections were not added.'),true);
      d.images.push(...files.map(f=>({name:f.name,type:f.type,bytes:f.size,id:'image-'+
Date.now()+
'-'+
f.name})));init().messages.ask=null;persist();return render();
    }
    if(saveInput(e.target)&&['count','type'].includes(e.target.dataset.csKey))render();
  });
  document.addEventListener('keydown',e=>{if(e.target.id==='cs-ask-question'&&e.key==='Enter'&&!e.shiftKey){e.preventDefault();e.stopImmediatePropagation();perform('ask-send',{dataset:{}});}},true);
  let audioURL='';
  function enhance(){
    init();document.body.classList.add('cs-ui');
    document.querySelectorAll('[data-cs-audio]').forEach(a=>{if(!audioURL)audioURL=URL.createObjectURL(new Blob([syntheticAudio()],{type:'audio/wav'}));if(!a.src)a.src=audioURL;});
    if(state.page==='setup/device'){
      const c=init(),i=c.invites.find(x=>x.id===c.selectedInvite),zone=document.querySelector('.cs-zone');
      if(i&&zone&&!document.getElementById('cs-invite-ack'))zone.insertAdjacentHTML('beforeend','<div id="cs-invite-ack" class="section">'+
(i.acknowledged?notice(t('模拟连接回执已保存。下一步在采集端选择本机范围。','Simulated connection receipt saved. Choose the local scope on the collector next.'),'good')+
route(t(i.returnTask==='folder'?'继续文件夹采集任务':'查看设备报告',i.returnTask==='folder'?'Continue folder collection task':'View device reports'),i.returnTask==='folder'?'setup/folder/new':i.returnTask==='screen'?'setup/screen':'devices','primary'):section('invite-demo',t('原型：模拟设备确认','Prototype: simulate device acknowledgment'),act(t('模拟采集端确认此邀请','Simulate collector confirming this invitation'),'invite-ack','subtle',i.cancelled?'disabled':'')))+
'</div>');
    }
    if(state.page==='library/files'&&init().deletedFiles?.length){const main=document.querySelector('main');if(main&&!document.getElementById('cs-deletion-receipts'))main.insertAdjacentHTML('beforeend',section('deletion-receipts',t('已删除文件的清理回执','Deleted-file cleanup receipts'),init().deletedFiles.map(f=>'<p>'+
user(f.title)+
' · '+
t('访问已移除，派生清理待完成；设备原件保留。','Access removed, derived cleanup pending; device original retained.')+
'</p>').join('')));}
  }
  window.enhanceCentralSemantics=enhance;
  const previousReset=resetPreviewData;
  resetPreviewData=function(value){state.cs={};return previousReset(value);};
})();
