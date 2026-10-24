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
    const c=init(),d=draft('invite',{url:origin(),name:'',device:'new'}),i=c.invites.find(x=>x.id===c.selectedInvite),live=i&&!i.cancelled&&!i.acknowledged&&Date.now()<i.expires;
    let html=heading(t('连接设备','Connect a device'),t('发出一次性邀请，在目标采集端确认。','Issue a one-use invitation and confirm on the target collector.'),route(t('返回设备','Back to devices'),'devices'))+
'<article class="reading cs-task">';
    if(i){
      const payload=JSON.stringify({demo:true,central:i.url,account:i.account,deviceId:i.device==='new'?null:i.device,name:i.name,invitation:i.token,expiresAt:new Date(i.expires).toISOString()},null,2);
      html+='<section class="cs-zone"><div class="cs-summary"><h2>'+
t('设备邀请','Device invitation')+
'</h2>'+
tag(t(i.cancelled?'已取消':i.acknowledged?'已确认并使用':live?'等待采集端确认':'已过期',i.cancelled?'Cancelled':i.acknowledged?'Acknowledged and consumed':live?'Awaiting collector confirmation':'Expired'),live?'purple':'')+
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
m.id,{...f.config,segment:'seg-0',text:f.segments[0]?.text||'',speaker:'S1',name:'',exportType:m.type==='audio'?'transcript':'body',history:'current',bytes:'metadata'}),running=Object.values(f.stages).includes('running');
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
Object.entries(f.stages).filter(([k])=>m.type==='audio'||!['diarization','alignment','grouping'].includes(k)).map(([k,v])=>'<div><dt>'+
(k==='extraction'&&m.type!=='audio'?t('正文提取','Body extraction'):t(...stageNames[k]))+
'</dt><dd>'+
statusLabel(v)+
'</dd></div>').join('')+
'</dl><p class="small">'+
(m.type==='audio'?t('本文件方案：使用已保存的文件处理规则。原始转写可阅读，后续分人或摘要失败不移除它。','Strategy: the saved file processing rule. A later grouping or summary failure keeps the readable raw transcript.'):t('本文件方案：使用已保存的文件处理规则。原始提取正文可阅读，后续摘要失败不会移除正文。','Strategy: the saved file processing rule. The extracted body remains readable if a later summary fails.'))+
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
f.segments.map((s,index)=>'<article><div class="small muted">'+
(m.type==='audio'?s.from+'–'+s.to+'s · '+user(s.speaker)+(f.names[s.speaker]?' · '+user(f.names[s.speaker]):''):t('文段 ','Segment ')+(index+1))+
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
(m.type==='audio'?t('人工校对不会调用模型；原文件与原始转写保留。','Manual correction makes no model call; the original file and raw transcript remain.'):t('人工校对不会调用模型；原文件与最初提取正文保留。','Manual correction makes no model call; the original file and initially extracted body remain.'))+
'</p>'+
section('file-lineage',m.type==='audio'?t('原始转写与修正历史','Raw transcript and correction history'):t('最初正文与修正历史','Initial body and correction history'),'<p data-user-content>'+
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
section('file-review',m.type==='audio'?t('场次与术语复核','Session and terminology review'):t('内容与术语复核','Content and terminology review'),'<div class="actions">'+
(m.type==='audio'?act(t('请求场次匹配（模拟）','Request session match (simulate)'),'file-session-review','subtle','data-id="'+m.id+'"'):'')+
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
t('建议需要你逐条确认，原始内容不会自动被覆盖；正文版本变化后旧建议失效。','Confirm suggestions individually. Original content is not overwritten; a changed body revision invalidates old suggestions.')+
'</p>')+
section('file-export',t('导出与删除','Export and delete'),fields(select('file-'+
m.id,'exportType',t('导出内容','Export content'),d.exportType,m.type==='audio'?[['transcript','转写正文','Transcript'],['speakers','说话人','Speakers'],['archive','文件归档','File archive']]:[['body','文档正文','Document body'],['archive','文件归档','File archive']])+
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
route(m.type==='audio'?t('文件、转写与处理详情','File, transcript and processing details'):t('文件、正文与处理详情','File, body and processing details'),'material/'+
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
    if(window.performCentralSemantics32&&await window.performCentralSemantics32(action,el))return;
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
      if(i.cancelled||i.acknowledged||Date.now()>=i.expires)return setMessage('invite',t('邀请已失效或已使用，请重新生成。','Invitation is expired, cancelled or already used. Regenerate it.'),true);
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

/* R32: scoped Central policy, connection and lifecycle fixtures. No backend is called. */
(function(){
  'use strict';
  const tr=(zh,en)=>state.language==='en'?en:zh;
  const cp=value=>JSON.parse(JSON.stringify(value));
  const button32=(label,action,kind='subtle',extra='')=>button(label,'cs-'+action,extra,kind);
  const link=(label,page,kind='text')=>goButton(label,page,kind);
  const content=value=>'<span data-user-content>'+esc(value??'')+'</span>';
  const note=(text,kind='')=>'<div class="notice '+kind+'" role="status"><div>'+text+'</div></div>';
  const options=(rows,value)=>rows.map(([id,zh,en])=>'<option value="'+esc(id)+'" '+(String(value)===String(id)?'selected':'')+'>'+esc(tr(zh,en||zh))+'</option>').join('');
  const bind32=(name,key)=>' data-cs-form="'+esc(name)+'" data-cs-path="'+esc(key)+'"';
  const field32=(name,key,label,value='',type='text',extra='')=>'<label class="field"><span>'+label+'</span><input class="field-input" id="cs32-'+esc(name+'-'+key)+'"'+bind32(name,key)+' type="'+type+'" value="'+esc(value??'')+'" '+extra+'></label>';
  const select32=(name,key,label,value,rows)=>'<label class="field"><span>'+label+'</span><select class="field-input" id="cs32-'+esc(name+'-'+key)+'"'+bind32(name,key)+'>'+options(rows,value)+'</select></label>';
  const check32=(name,key,label,value)=>'<label class="checkrow"><input type="checkbox" id="cs32-'+esc(name+'-'+key)+'"'+bind32(name,key)+' '+(value?'checked':'')+'><span>'+label+'</span></label>';
  const area32=(name,key,label,value='',extra='')=>'<label class="field"><span>'+label+'</span><textarea id="cs32-'+esc(name+'-'+key)+'"'+bind32(name,key)+' '+extra+'>'+esc(value)+'</textarea></label>';
  const disclose=(id,title,body,open=false)=>'<details id="cs32-'+esc(id)+'" class="cs-disclosure" '+(open?'open':'')+'><summary>'+title+'</summary><div class="cs-disclosure-body">'+body+'</div></details>';
  const fields32=body=>'<div class="fields cs-fields">'+body+'</div>';
  const facts=rows=>'<dl class="cs-dl">'+rows.map(([k,v])=>'<div><dt>'+k+'</dt><dd>'+v+'</dd></div>').join('')+'</dl>';
  const row32=(title,detail,action='')=>'<div class="cs-row"><div><strong>'+title+'</strong><small>'+detail+'</small></div><div class="actions">'+action+'</div></div>';
  const stamp=()=>new Date().toISOString();
  const uid=prefix=>prefix+'-'+Date.now()+'-'+Math.random().toString(36).slice(2,6);
  function central(){const c=state.cs||(state.cs={});c.drafts||={};c.messages||={};return c;}
  function draft32(name,defaults){return central().drafts[name]||(central().drafts[name]=cp(defaults));}
  function message32(name){const m=central().messages[name];return m?note(esc(m.text),m.error?'warn':'good'):'';}
  function rememberDisclosures32(){state.focus||={};state.focus.details||={};document.querySelectorAll('main details[id^="cs"]').forEach(d=>{state.focus.details[state.page+'|'+d.id]=d.open;});const c=central();for(const id of c.openDisclosures||[])state.focus.details[state.page+'|'+id]=true;delete c.openDisclosures;}
  function finish32(name,text,error=false){central().messages[name]={text,error};rememberDisclosures32();persist();render();return true;}
  function repaint32(){rememberDisclosures32();persist();render();return true;}
  function download32(name,value,type='application/json'){const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([value],{type}));a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);}
  function sourceRows(all=false){return [...(all?[['','全部来源','All sources']]:[]),...state.sources.map(s=>[s.id,s.title||s.name,s.title||s.name])];}
  function sourceName(id){const s=state.sources.find(x=>x.id===id);return s?(s.title||s.name):(id?tr('未连接的来源：','Unconnected source: ')+id:tr('全部来源','All sources'));}
  function providerRows(blank=true){return [...(blank?[['','未配置（任务将等待）','Unconfigured (affected work waits)']]:[]),...(central().providers||[]).map(p=>[p.id,p.name+(p.readonly?tr(' · 共享只读',' · shared read-only'):''),p.name+(p.readonly?' · shared read-only':'')])];}
  const processorRows=[['archive','仅归档原件','Archive original only'],['text.utf8','UTF-8 文字提取','UTF-8 text extraction'],['audio.local-dialogue','本地多人录音','Local multi-speaker recording'],['audio.http','转写接口','Transcription service'],['image.http','图片文字提取接口','Image text service']];
  const processorMeta={'archive':{mime:'*/*'},'text.utf8':{mime:'text/*',local:true},'audio.local-dialogue':{mime:'audio/*',local:true,kind:'asr'},'audio.http':{mime:'audio/*',kind:'asr'},'image.http':{mime:'image/*',kind:'image'}};
  const mimeRows=[['audio/*','录音','Audio'],['image/*','图片','Images'],['text/*','文本','Text'],['application/pdf','PDF','PDF'],['*/*','其他 / 全部类型','Other / all types']];
  function processing(){
    const c=central();
    c.processing||={revision:1,saved:{enabled:true,maxAudioMinutes:120,timeoutSeconds:1200,rules:[{id:'r-audio',source:'',type:'audio/*',profile:'p-audio'},{id:'r-image',source:'',type:'image/*',profile:'p-image'},{id:'r-text',source:'',type:'text/*',profile:'p-text'},{id:'r-other',source:'',type:'*/*',profile:'p-archive'}],profiles:[{id:'p-archive',name:'Archive originals',processor:'archive',parameters:{},service:'',speaker:'audio.diarize',analysis:'',summary:false},{id:'p-text',name:'UTF-8 text',processor:'text.utf8',parameters:{},service:'',speaker:'audio.diarize',analysis:'',summary:false},{id:'p-audio',name:'Local recording',processor:'audio.local-dialogue',parameters:{speakerCount:'',speakerMin:'',speakerMax:'',semanticTurns:false},service:'s-asr',speaker:'audio.diarize',analysis:'',summary:false},{id:'p-image',name:'Image text',processor:'image.http',parameters:{},service:'s-image',speaker:'audio.diarize',analysis:'',summary:false}],services:[{id:'s-asr',name:'Recording service',kind:'asr',reference:''},{id:'s-image',name:'Image text service',kind:'image',reference:''}]},models:{dialogue:false,wespeaker:false},checks:{},receipts:[]};
    return c.processing;
  }
  function policyDraft(){const p=processing();return draft32('policy',{revision:p.revision,...p.saved});}
  function policyDirty(){const p=processing(),d=cp(policyDraft());delete d.revision;return JSON.stringify(d)!==JSON.stringify(p.saved);}
  function mimeMatches(pattern,mime){return pattern==='*/*'||pattern===mime||(pattern.endsWith('/*')&&mime.startsWith(pattern.slice(0,-1)));}
  function matchRule(source,mime){const p=processing(),rules=p.saved.rules;let candidates=rules.filter(r=>(!r.source||r.source===source)&&mimeMatches(r.type,mime));candidates.sort((a,b)=>((b.source?100:0)+(b.type===mime?20:b.type==='*/*'?0:10))-((a.source?100:0)+(a.type===mime?20:a.type==='*/*'?0:10)));const rule=candidates[0];return rule?{rule,profile:p.saved.profiles.find(x=>x.id===rule.profile)}:null;}
  function profileCompatible(profile,mime){const meta=processorMeta[profile.processor];return !!meta&&(profile.processor==='archive'||mime==='*/*'||mimeMatches(meta.mime,mime)||mimeMatches(mime,meta.mime));}
  function profileOptions(d,type,current){return d.profiles.map(p=>[p.id,p.name+(!profileCompatible(p,type)?tr('（类型不兼容 / 插件不可用）',' (incompatible / unavailable)'):''),p.name+(!profileCompatible(p,type)?' (incompatible / unavailable)':'')]);}
  function ruleEditor(d,r,i){const missing=r.source&&!state.sources.some(s=>s.id===r.source);return '<div class="cs-editor-row">'+(r.source?select32('policy','rules.'+i+'.source',tr('来源','Source'),r.source,[...sourceRows(),...(missing?[[r.source,sourceName(r.source),sourceName(r.source)]]:[])]):'')+field32('policy','rules.'+i+'.type',tr('精确 MIME 或通配符','Exact MIME or wildcard'),r.type)+select32('policy','rules.'+i+'.profile',tr('处理方案','Processing plan'),r.profile,profileOptions(d,r.type,r.profile))+button32(tr(r.source?'移除覆盖':'移除规则',r.source?'Remove override':'Remove rule'),'policy-rule-remove','text','data-index="'+i+'" '+(!r.source&&r.type==='*/*'?'disabled':''))+'</div>';}
  function profileEditor(d,p,i){
    const meta=processorMeta[p.processor],serviceRows=(kind)=>[['','未配置（任务将等待）','Unconfigured (work waits)'],...d.services.filter(s=>s.kind===kind).map(s=>[s.id,s.name,s.name])];
    const controls=field32('policy','profiles.'+i+'.name',tr('方案名称','Plan name'),p.name)+select32('policy','profiles.'+i+'.processor',tr('处理插件','Processor'),p.processor,[...processorRows,...(!meta?[[p.processor,'不可用：'+p.processor,'Unavailable: '+p.processor]]:[])])+(meta?.kind?select32('policy','profiles.'+i+'.service',tr('处理服务','Processing service'),p.service,serviceRows(meta.kind)):'')+(p.processor==='audio.local-dialogue'?field32('policy','profiles.'+i+'.parameters.speakerCount',tr('准确说话人数（可留空）','Exact speaker count (optional)'),p.parameters.speakerCount,'number','min="1" max="16"')+field32('policy','profiles.'+i+'.parameters.speakerMin',tr('人数下限（与准确人数互斥）','Minimum speakers (alternative to exact count)'),p.parameters.speakerMin,'number','min="1" max="16"')+field32('policy','profiles.'+i+'.parameters.speakerMax',tr('人数上限','Maximum speakers'),p.parameters.speakerMax,'number','min="1" max="16"')+check32('policy','profiles.'+i+'.parameters.semanticTurns',tr('使用模型合并自然发言轮次','Use the model to group natural speaking turns'),p.parameters.semanticTurns)+select32('policy','profiles.'+i+'.speaker',tr('说话人分离插件','Speaker grouping plugin'),p.speaker,[['audio.diarize','本地说话人分离','Local speaker grouping'],['audio.diarize-wespeaker','WeSpeaker 中文','WeSpeaker Chinese']]):'')+(p.processor!=='archive'?select32('policy','profiles.'+i+'.analysis',tr('分析语言模型服务','Analysis model service'),p.analysis,[['','跟随 Central 模型设置','Follow Central model settings'],...d.services.filter(s=>s.kind==='model').map(s=>[s.id,s.name,s.name])])+check32('policy','profiles.'+i+'.summary',tr('提取后生成摘要（可能调用所选模型）','Generate a summary after extraction (may call the selected model)'),p.summary):'');
    const referenced=d.rules.some(r=>r.profile===p.id);
    return disclose('plan-'+p.id,content(p.name)+' · '+content(processorRows.find(x=>x[0]===p.processor)?.[state.language==='en'?2:1]||tr('插件不可用','Plugin unavailable')),fields32(controls)+(meta?.local?'<p class="small">'+tr('此处理器只能使用 Central 本地执行。转写原文与摘要分别保留。','This processor requires local execution on Central. Raw transcription and summary are retained separately.')+'</p>':'')+'<div class="actions">'+button32(tr('复制方案','Copy plan'),'policy-plan-copy','subtle','data-id="'+p.id+'"')+button32(tr(referenced?'先移除规则引用再删除':'删除方案',referenced?'Remove rule references before deletion':'Delete plan'),'policy-plan-remove','text','data-id="'+p.id+'" '+(referenced?'disabled':''))+'</div>');
  }
  function serviceEditor(d,s,i){const provider=central().providers?.find(p=>p.id===s.reference),used=d.profiles.some(p=>p.service===s.id||p.analysis===s.id),check=processing().checks[s.id];return disclose('service-'+s.id,content(s.name),fields32(field32('policy','services.'+i+'.name',tr('服务名称','Service name'),s.name)+select32('policy','services.'+i+'.kind',tr('服务类型','Service type'),s.kind,[['asr','录音转写 / 分离','Transcription / speaker grouping'],['image','图片提取','Image extraction'],['file','通用文件处理','General file processing'],['model','语言模型','Language model']])+select32('policy','services.'+i+'.reference',tr('模型连接引用','Model connection reference'),s.reference,providerRows()))+'<p class="small">'+(provider?content(provider.name)+' · '+tr(provider.local?'Central 本地连接':'远程连接',provider.local?'Local Central connection':'Remote connection'):tr('未配置：只影响引用此服务的方案。','Unconfigured: only plans referencing this service wait.'))+'</p><p class="small">'+tr('共享连接仅引用，不复制地址或密钥。个人连接的保留 / 替换 / 清除凭据在模型连接页完成。','Shared connections are referenced without copying endpoints or secrets. Keep, replace or clear personal credentials in Model providers.')+'</p><div class="actions">'+link(tr('编辑连接与凭据','Edit connection and credentials'),'settings/providers')+(s.kind==='asr'?button32(tr('检测已保存本地服务','Check saved local service'),'policy-service-test','subtle','data-id="'+s.id+'" '+(policyDirty()?'disabled':'')):'')+button32(tr(used?'服务正在被方案使用':'删除服务',used?'Service is referenced by a plan':'Delete service'),'policy-service-remove','text','data-id="'+s.id+'" '+(used?'disabled':''))+'</div>'+(check?note(esc(check.text),check.error?'warn':'good'):''));}
  function policyPage(){
    const p=processing(),d=policyDraft(),trial=draft32('policy-trial',{source:'',type:'*/*',mime:'audio/wav'}),dirty=policyDirty(),preview=p.preview;
    return '<article class="cs-task">'+note(tr('按来源和文件类型决定处理方式。保存后，新文件与未完成任务使用新设置；已有原件和已完成结果保留。','Choose processing by source and MIME type. Saved settings affect new and unfinished work; originals and completed products remain.'))+message32('policy')+'<section class="cs-zone">'+fields32(check32('policy','enabled',tr('启用 Central 文件处理','Enable Central file processing'),d.enabled)+field32('policy','maxAudioMinutes',tr('单个音频最长（分钟）','Maximum single audio length (minutes)'),d.maxAudioMinutes,'number','min="1" max="1440"')+field32('policy','timeoutSeconds',tr('单次处理超时（秒）','Single processing timeout (seconds)'),d.timeoutSeconds,'number','min="1" max="3600"'))+'<p class="small">'+tr('超出时长 / 超时限制，与缺少模型或运行服务是不同的阻塞原因。','Configured duration/timeout limits are distinct from a missing model or processing service.')+'</p></section>'+disclose('policy-rules',tr('类型规则','Type rules'),'<p>'+tr('精确 MIME 优先于通配符；其他类型使用已保存的回退方案。','Exact MIME takes precedence over wildcards. Other types use the saved fallback plan.')+'</p>'+d.rules.map((r,i)=>!r.source?ruleEditor(d,r,i):'').join('')+button32(tr('添加类型规则','Add type rule'),'policy-rule-add'))+disclose('policy-plans',tr('处理方案','Processing plans'),d.profiles.map((profile,i)=>profileEditor(d,profile,i)).join('')+button32(tr('添加处理方案','Add processing plan'),'policy-plan-add'))+disclose('policy-overrides',tr('来源覆盖','Source overrides'),'<p>'+tr('来源精确类型 → 来源通配类型 → 全局精确类型 → 全局通配类型 → 其他。其他来源不受这项覆盖影响。','Source exact → source wildcard → global exact → global wildcard → other. Other sources keep their own rules.')+'</p>'+d.rules.map((r,i)=>r.source?ruleEditor(d,r,i):'').join('')+button32(tr('添加来源覆盖','Add source override'),'policy-override-add','subtle',state.sources.length?'':'disabled'))+disclose('policy-services',tr('服务连接与本地模型','Service connections and local models'),d.services.map((service,i)=>serviceEditor(d,service,i)).join('')+button32(tr('添加服务','Add service'),'policy-service-add')+disclose('policy-models',tr('本地语音模型包','Local speech model packages'),['dialogue','wespeaker'].map(id=>row32(id==='dialogue'?tr('本地多人录音模型','Local multi-speaker model'):'WeSpeaker',tr(p.models[id]?'已安装（合成状态）':'尚未安装',p.models[id]?'Installed (synthetic status)':'Not installed'),button32(tr(p.models[id]?'检查包状态':'安装示例包',p.models[id]?'Check package state':'Install fixture package'),'policy-model-install','subtle','data-id="'+id+'"'))).join('')+'<p class="small">'+tr('界面仅模拟安装回执，不下载或运行模型。','This prototype simulates installation receipts; no model is downloaded or executed.')+'</p>'))+'<div class="form-actions">'+button32(tr('保存处理设置','Save processing settings'),'policy-save','primary')+button32(tr('重新加载已保存值','Reload saved values'),'policy-reload','text')+'</div><p id="cs32-policy-dirty" class="small" role="status">'+tr(dirty?'有未保存修改':'已保存版本 ',dirty?'Unsaved changes':'Saved revision ')+(dirty?'':p.revision)+'</p>'+disclose('policy-saved',tr('查看当前保存的规则','Inspect saved rules'),facts([[tr('版本','Revision'),String(p.revision)],[tr('处理状态','Processing'),tr(p.saved.enabled?'已启用':'已关闭',p.saved.enabled?'Enabled':'Disabled')],[tr('限制','Limits'),p.saved.maxAudioMinutes+' min / '+p.saved.timeoutSeconds+' sec']])+p.saved.rules.map(r=>row32(content(sourceName(r.source))+' · '+content(r.type),content(p.saved.profiles.find(x=>x.id===r.profile)?.name||r.profile))).join(''))+disclose('policy-trial',tr('规则试算与已有文件','Saved-rule trial and existing files'),'<p>'+tr('只使用已保存设置。每批最多 100 份当前原件，预览有效 10 分钟。仅归档、Shadow 与运行中的文件跳过。','Uses saved settings only. At most 100 current originals per batch; previews expire after 10 minutes. Archive-only, Shadow and running files are skipped.')+'</p>'+(dirty?note(tr('请先保存或重新加载设置，再试算。','Save or reload settings before a trial.'),'warn'):'')+fields32(select32('policy-trial','source',tr('目标来源','Target source'),trial.source,sourceRows(true))+select32('policy-trial','type',tr('目标文件类型','Target file type'),trial.type,mimeRows)+field32('policy-trial','mime',tr('试算 MIME 类型','Trial MIME type'),trial.mime))+'<div class="actions">'+button32(tr('查看匹配规则','Inspect matching rule'),'policy-match','subtle',dirty?'disabled':'')+button32(tr('预览已有文件重处理','Preview existing-file reprocessing'),'policy-preview','subtle',dirty||!p.saved.enabled?'disabled':'')+'</div>'+message32('policy-trial')+(p.match?facts([[tr('已保存版本','Saved revision'),String(p.match.revision)],[tr('命中规则','Matched rule'),content(sourceName(p.match.source))+' · '+content(p.match.type)],[tr('方案','Plan'),content(p.match.name)],[tr('处理器','Processor'),content(p.match.processor)]]):'')+(preview?'<section class="cs-zone"><h3>'+tr('这次将重新处理','This preview will reprocess')+' '+preview.items.length+' '+tr('份原件','originals')+'</h3><p>'+tr('跳过 ','Skipped ')+preview.skipped+' · '+tr('到期：','Expires: ')+content(preview.expiresAt)+'</p>'+preview.items.map(x=>row32(content(x.title),content(x.plan)+' · '+content(x.rule))).join('')+'<p>'+tr('生成新的派生版本；已有人工修正标为过期。原件继续保留。','Creates new derived versions; previous manual corrections become stale. Originals remain.')+'</p>'+button32(tr('确认当前预览','Confirm current preview'),'policy-confirm','primary',preview.items.length?'':'disabled')+'</section>':'')+p.receipts.map(r=>row32(content(r.id),tr('已排入队列：','Queued: ')+r.items.length+' · '+content(r.createdAt),link(tr('查看工作详情','Open work detail'),'activity/work/'+r.id))).join(''))+'</article>';
  }
  let grantSecret=null;
  function grants32(){const c=central();c.grants||=(state.accessGrants||[]).map(g=>({id:g.id,name:g.name,access:'read',sources:[],createdAt:'2026-10-20T09:00:00Z',expiresAt:'2026-11-19T09:00:00Z',revoked:!g.active}));return c.grants;}
  function grantPage(embedded=false){
    const d=draft32('grant',{name:'',access:'read'}),grants=grants32();
    return (embedded?'':heading(tr('对外授权','Outgoing connections'),tr('为 Chatbot 生成独立凭据，并随时撤销指定连接。','Issue a separate chatbot credential and revoke individual connections.')))+'<article class="cs-task">'+message32('grant')+'<section class="cs-zone"><h3>'+tr('新建 MCP 连接','Create an MCP connection')+'</h3>'+fields32(field32('grant','name',tr('连接名称','Connection name'),d.name)+select32('grant','access',tr('访问权限','Access'),d.access,[['read','只读本人资料','Read my archive'],['write','指定来源写入','Write to selected sources']]))+disclose('grant-sources',tr('来源范围','Source scope'),state.sources.map(s=>check32('grant','source-'+s.id,content(s.title||s.name),d['source-'+s.id])).join('')+(!state.sources.length?'<p>'+tr('尚无已连接来源。只读授权仍可覆盖本人后续来源；写入需要先有来源。','No sources are connected. Read-only access can cover this account’s future sources; writing requires an existing source.')+'</p>':''),d.access==='write')+'<p>'+tr(d.access==='read'?'不选择来源时，可读取本人全部来源。':'写入必须明确选择已有来源。',d.access==='read'?'With no sources selected, this credential can read all sources owned by this account.':'Writing requires explicit selection of existing sources.')+'</p><p class="small">'+tr('这是独立的 MCP 凭据，不是设备采集邀请，也不是账号登录凭据。','This MCP credential is separate from device collection invitations and account sign-in.')+'</p>'+button32(tr('生成 MCP 配置','Generate MCP configuration'),'grant-generate','primary')+'</section>'+(grantSecret?'<section class="cs-zone"><h3>'+tr('保存本次生成的配置','Save the newly generated configuration')+'</h3><p>'+tr('只在本次生成后显示。隐藏或离开页面后仍有效；丢失时撤销这条连接，再重新生成。','Displayed only after generation. Hiding or leaving keeps the credential valid; revoke and regenerate if it is lost.')+'</p><label class="field"><span>MCP JSON · '+tr('合成凭据','synthetic credential')+'</span><textarea class="cs-code" id="cs32-grant-json" readonly>'+esc(JSON.stringify(grantSecret.config,null,2))+'</textarea></label><div class="actions">'+button32(tr('复制配置','Copy configuration'),'grant-copy')+button32(tr('下载配置','Download configuration'),'grant-download')+button32(tr('已保存，隐藏凭据','Saved; hide credential'),'grant-hide','text')+'</div></section>':'')+'<section class="cs-zone"><div class="cs-summary"><h3>'+tr('已授权的连接','Issued connections')+'</h3>'+button32(tr('刷新连接','Refresh connections'),'grant-refresh','text')+'</div>'+(grants.length?grants.map(g=>'<div class="cs-connection" data-cs-grant="'+g.id+'">'+row32(content(g.name),tr(g.revoked?'已撤销':'有效',g.revoked?'Revoked':'Active')+' · MCP '+(g.access==='read'?'read':'write'),!g.revoked?button32(tr('撤销此连接','Revoke this connection'),'grant-revoke','text','data-id="'+g.id+'"'):'')+facts([[tr('账号','Account'),content(state.accountName)],[tr('范围','Scope'),g.sources.length?g.sources.map(s=>content(sourceName(s))).join(' · '):tr('本人全部来源','All sources owned by this account')],[tr('创建 / 到期','Created / expires'),content(g.createdAt)+' / '+content(g.expiresAt)]])+(central().revokeGrant===g.id?note(tr('只撤销这项凭据。原始资料、设备采集和账号会话保留。','Only this credential is revoked. Original archives, device collection and account sessions remain.')+'<div class="actions">'+button32(tr('确认撤销','Confirm revocation'),'grant-revoke-confirm','danger','data-id="'+g.id+'"')+button32(tr('取消','Cancel'),'grant-revoke-cancel','subtle')+'</div>','warn'):'')+'</div>').join(''):'<p>'+tr('还没有签发 MCP 连接。','No MCP connections have been issued.')+'</p>')+'</section><div class="actions">'+link(tr('连接采集设备','Connect a collector'),'setup/device')+link(tr('查看 Agent 可读取内容','Inspect Agent-accessible content'),'settings/agent-scope')+link(tr('实际读取记录','Actual read records'),'settings/agent-events')+'</div></article>';
  }
  function plugins32(){
    const c=central();c.plugins||={revision:1,currentPlan:'core-plan',paused:!!state.memoryPaused,stopped:false,packages:[{id:'core',name:'Built-in memory',version:'1.0.0',installed:true,builtin:true,runtime:'Central Worker',hash:'synthetic-core-manifest-v1',capabilities:['memory.extract','memory.query'],restart:false}],instances:[{id:'core-instance',package:'core',name:'Current memory instance',revision:1,model:'',credential:'',capabilities:{'memory.extract':true,'memory.query':true},sources:[],history:true,enabled:true,validated:true}],plans:[{id:'core-plan',instance:'core-instance',name:'Built-in memory plan',verified:true}],installationAvailable:true,historyReaders:[],draining:[],preparations:[]};return c.plugins;
  }
  function instanceDraft(){const p=plugins32(),id=p.selectedInstance,s=p.instances.find(i=>i.id===id);return draft32('plugin-instance',s?cp(s):{id:'',package:p.selectedPackage||p.packages[0]?.id||'',name:'',revision:0,model:'',credential:'',capabilities:{'memory.extract':true,'memory.query':true},sources:[],history:false,enabled:false,validated:false});}
  function packageUsed(pkg){const p=plugins32();return p.instances.some(i=>i.package===pkg.id&&p.plans.some(plan=>plan.instance===i.id&&plan.id===p.currentPlan))||p.historyReaders.includes(pkg.id)||p.draining.includes(pkg.id);}
  function pluginInstanceEditor(){const p=plugins32(),d=instanceDraft(),pkg=p.packages.find(x=>x.id===d.package),saved=p.instances.find(x=>x.id===d.id);return '<section class="cs-zone"><h3>'+tr(saved?'配置实例':'创建实例',saved?'Configure instance':'Create instance')+'</h3>'+message32('plugin-instance')+fields32(select32('plugin-instance','package',tr('已安装的软件包','Installed package'),d.package,p.packages.map(x=>[x.id,x.name,x.name]))+field32('plugin-instance','name',tr('实例名称','Instance name'),d.name)+select32('plugin-instance','model',tr('声明字段：模型连接','Declared field: model connection'),d.model,providerRows())+select32('plugin-instance','credential',tr('声明字段：凭据引用','Declared field: credential reference'),d.credential,providerRows()))+disclose('plugin-instance-scope',tr('能力与资料范围','Capabilities and data scope'),(pkg?.capabilities||[]).map(id=>check32('plugin-instance','capabilities.'+id.replaceAll('.','_'),content(id),Object.hasOwn(d.capabilities,id.replaceAll('.','_'))?d.capabilities[id.replaceAll('.','_')]:d.capabilities[id])).join('')+state.sources.map(s=>check32('plugin-instance','source-'+s.id,content(s.title||s.name),d['source-'+s.id]??d.sources.includes(s.id))).join('')+check32('plugin-instance','history',tr('允许已授权的历史读取','Allow already-authorized historical reads'),d.history)+'<p class="small">'+tr('实例范围仍受账号既有授权约束；填写范围不会增加新的资料权限。','The instance remains bounded by the account’s existing authority; entering a scope does not grant additional access.')+'</p>')+'<div class="actions">'+button32(tr(saved?'保存实例配置':'创建实例',saved?'Save instance configuration':'Create instance'),'plugin-instance-save','primary')+(saved?button32(tr('重新读取并丢弃草稿','Reload and discard draft'),'plugin-instance-reload','text'):'')+button32(tr('关闭编辑','Close editor'),'plugin-instance-close','text')+'</div>'+(saved?disclose('plugin-conflict',tr('原型：配置冲突','Prototype: configuration conflict'),button32(tr('模拟另一个会话更新','Simulate another session updating this instance'),'plugin-instance-conflict','text')):'')+'</section>';}
  function pluginPage(){
    const p=plugins32(),install=draft32('plugin-install',{repository:'https://github.com/example/mote-memory-demo',tag:'v1.2.0'}),current=p.plans.find(x=>x.id===p.currentPlan),planDraft=draft32('memory-preparation',{target:'',scope:'',cost:false}),prep=p.preparations.at(-1);
    const active=prep&&['preparing','verified'].includes(prep.status);
    return '<article class="cs-task">'+message32('plugins')+'<section class="cs-zone"><div class="cs-summary"><div><h3>'+tr('自动记忆','Automatic memory')+'</h3><p>'+tr(p.stopped?'旧任务写入权限已撤销':p.paused?'暂停接收新任务':'接收新资料的整理任务',p.stopped?'Old jobs no longer have write authority':p.paused?'New admissions are paused':'New material can enter memory processing')+'</p></div>'+button32(tr(p.paused?'恢复新任务':'暂停新任务',p.paused?'Resume new admissions':'Pause new admissions'),'memory-pause','subtle')+'</div><p>'+tr('原件继续归档，既有记忆与只读查询保留。暂停后，已接收的任务仍可完成；恢复只处理新资料，不自动补算暂停期间的历史。独立回顾按自己的设置运行。','Originals still archive; existing memories and read-only queries remain. Admitted work may finish after a pause. Resuming processes new material without automatic catch-up of paused history. Independent reviews retain their own settings.')+'</p>'+disclose('memory-running',tr('已有任务与立即停止','Admitted work and immediate stop'),facts([[tr('排队 / 运行 / 检查点','Queued / running / checkpoint'),p.stopped?'0 / 0 / 1':'1 / 1 / 1'],[tr('外部结果未确认','External result unknown'),'1']])+'<div class="actions">'+link(tr('查看工作详情','Open work detail'),'activity/work/memory-study')+button32(tr('立即停止已有自动记忆','Stop admitted automatic memory now'),'memory-stop','text')+'</div>'+(p.stopReview?note(tr('立即停止会撤销旧任务继续写入的权限，并请求取消。外部执行可能无法立即停止；未确认结果单独保留。','Immediate stop revokes old write authority and requests cancellation. External execution may continue; unconfirmed outcomes remain explicit.')+'<div class="actions">'+button32(tr('确认立即停止','Confirm immediate stop'),'memory-stop-confirm','danger')+button32(tr('取消','Cancel'),'memory-stop-cancel')+'</div>','warn'):''))+'</section><section class="cs-zone"><h3>'+tr('当前记忆方案','Current memory plan')+'</h3><p>'+content(current?.name||tr('没有当前方案','No current plan'))+'</p>'+disclose('memory-plan-change',tr('准备替换方案','Prepare a replacement plan'),'<p>'+tr('准备不等于生效。失败或取消不会切换；过渡中保留旧查询快照，不授权新的历史提取。','Preparation is separate from activation. Failure or cancellation does not switch plans; the old query snapshot remains and no new historical extraction is authorized.')+'</p>'+fields32(select32('memory-preparation','target',tr('已注册的目标方案','Registered target plan'),planDraft.target,[['','选择其他方案','Choose another plan'],...p.plans.filter(x=>x.id!==p.currentPlan).map(x=>[x.id,x.name,x.name])])+field32('memory-preparation','scope',tr('已授权的历史范围','Already-authorized history scope'),planDraft.scope)+check32('memory-preparation','cost',tr('已确认范围及可能的模型 / Embedding 费用','I confirm this scope and possible model / embedding cost'),planDraft.cost))+'<div class="actions">'+button32(tr('预览迁移范围','Preview migration scope'),'memory-plan-preview')+'</div>'+message32('memory-preparation')+(p.planPreview?note(tr('准备范围：','Preparation scope: ')+content(p.planPreview.scope)+'<p>'+tr('保留的记忆正文、修正与删除标记迁移，并验证索引；旧实例中的原生审计历史不承诺跨引擎迁移。','Retained memory, corrections and deletion marks migrate with index validation; native audit history in the old instance is not promised across engines.')+'</p>'+button32(tr('开始准备','Begin preparation'),'memory-plan-prepare','primary')):'')+(prep?'<section class="cs-zone">'+facts([[tr('准备回执','Preparation receipt'),content(prep.id)],[tr('状态','Status'),content(prep.status)],[tr('阶段','Stage'),content(prep.phase)],[tr('历史范围','History scope'),content(prep.scope)],[tr('旧查询快照','Old query snapshot'),content(prep.oldPlan)],[tr('索引核验 / 尾部任务','Index validation / remaining tail'),['verified','applied'].includes(prep.status)?'verified / 0':'pending / 1']])+message32('memory-prep-result')+'<div class="actions">'+(prep.status==='preparing'?button32(tr('完成模拟核验','Complete synthetic validation'),'memory-plan-verify')+button32(tr('取消准备','Cancel preparation'),'memory-plan-cancel','text')+button32(tr('模拟准备失败','Simulate preparation failure'),'memory-plan-fail','text'):'')+(['failed','cancelled'].includes(prep.status)?button32(tr('重试同一次准备','Retry this preparation'),'memory-plan-retry'):'')+(prep.status==='verified'?button32(tr('设为当前方案','Set as current plan'),'memory-plan-activate','primary')+button32(tr('取消准备','Cancel preparation'),'memory-plan-cancel','text'):'')+'</div></section>':''))+'</section>'+disclose('plugins-installed',tr('已安装包与实例','Installed packages and instances'),p.packages.map(pkg=>disclose('package-'+pkg.id,content(pkg.name)+' · '+content(pkg.version),facts([[tr('运行位置','Runtime'),content(pkg.runtime)],[tr('完整性摘要','Manifest digest'),content(pkg.hash)],[tr('能力声明','Declared capabilities'),pkg.capabilities.map(content).join(' · ')],[tr('生效条件','Activation'),tr(pkg.restart?'安装后需部署重启':'无需重启',pkg.restart?'Deployment restart required after installation':'No restart required')]])+p.instances.filter(i=>i.package===pkg.id).map(i=>row32(content(i.name),tr(i.enabled?'已启用':'未启用',i.enabled?'Enabled':'Disabled')+' · '+tr(i.validated?'当前配置已验证':'尚未验证',i.validated?'Current configuration validated':'Unvalidated')+' · v'+i.revision,button32(tr('配置','Configure'),'plugin-instance-open','text','data-id="'+i.id+'"')+button32(tr('验证已保存配置','Validate saved configuration'),'plugin-instance-validate','text','data-id="'+i.id+'"')+button32(tr(i.enabled?'禁用':'启用',i.enabled?'Disable':'Enable'),'plugin-instance-toggle','text','data-id="'+i.id+'"')+button32(tr('查看方案','Open plan'),'plugin-plan-open','text','data-id="'+i.id+'"'))).join('')+'<div class="actions">'+button32(tr('创建此包的实例','Create package instance'),'plugin-instance-new','subtle','data-id="'+pkg.id+'"')+(pkg.builtin?'':button32(tr('卸载安装包','Uninstall package'),'plugin-uninstall','text','data-id="'+pkg.id+'"'))+'</div>'+(p.uninstall===pkg.id?note(tr('已绑定、仍有历史读者或正在排空的包不能卸载。确认时再次核验；只移除界面组件不会改变后台授权。','Bound packages, historical readers and draining packages cannot be uninstalled. Eligibility is rechecked on confirmation; removing UI alone does not change backend authorization.')+'<div class="actions">'+button32(tr('确认卸载','Confirm uninstall'),'plugin-uninstall-confirm','danger','data-id="'+pkg.id+'"')+button32(tr('取消','Cancel'),'plugin-uninstall-cancel')+'</div>','warn'):'')+(packageUsed(pkg)?'<p class="small">'+tr('当前存在绑定、历史读取或排空依赖。','This package has a binding, historical-reader or draining dependency.')+'</p>':''))).join('')+(p.editInstance?pluginInstanceEditor():''))+disclose('plugins-discover',tr('发现与安装可信插件','Discover and install trusted plugins'),note(tr('安装需要管理员权限。可信宿主代码可使用 Central 宿主权限；能力声明不是沙箱。安装之后仍需配置、验证、启用与绑定。这里所有发现和安装结果都是合成示例。','Installation requires an administrator. Trusted host code can use Central host privileges; declarations are not a sandbox. Installation is followed by configuration, validation, enabling and binding. Discovery and installation results here are synthetic fixtures.'))+fields32(field32('plugin-install','repository',tr('仓库地址','Repository URL'),install.repository,'url')+field32('plugin-install','tag',tr('发布标签（选填）','Release tag (optional)'),install.tag))+'<div class="actions">'+button32(tr('发现可用版本','Discover releases'),'plugin-discover','subtle')+'</div>'+message32('plugin-install')+(p.release?row32(content(p.release.tag),tr('示例固定发布版本','Synthetic fixed release'),button32(tr('预览此固定版本','Preview this fixed release'),'plugin-preview')):'')+(p.installPreview?'<section class="cs-zone"><h3>'+tr('安装预览','Installation preview')+'</h3>'+facts([[tr('仓库 / 标签','Repository / tag'),content(p.installPreview.repository)+' / '+content(p.installPreview.tag)],[tr('固定提交','Pinned commit'),content(p.installPreview.commit)],[tr('SHA-256','SHA-256'),content(p.installPreview.hash)],[tr('运行 / 重启','Runtime / restart'),'Central Worker / '+tr('无需重启（示例）','no restart (fixture)')],[tr('能力','Capabilities'),'memory.extract · memory.query'],[tr('权限 / 依赖','Access / dependencies'),tr('账号已授权资料；需模型连接','Account-authorized material; model connection required')]])+'<div class="actions">'+button32(tr('安装此版本','Install this version'),'plugin-install','primary',central().admin&&p.installationAvailable?'':'disabled')+button32(tr('取消预览','Cancel preview'),'plugin-preview-cancel','text')+'</div>'+(!central().admin?note(tr('普通账号不能安装宿主插件。','Regular accounts cannot install host plugins.'),'warn'):'')+(!p.installationAvailable?note(tr('当前部署未提供安装器。请由部署管理员准备。','This deployment has no installer. Ask its administrator to prepare one.'),'warn'):'')+'</section>':'')+disclose('plugin-installer-fixture',tr('原型：安装器状态','Prototype: installer availability'),button32(tr(p.installationAvailable?'预览安装器不可用':'恢复示例安装器',p.installationAvailable?'Preview unavailable installer':'Restore fixture installer'),'plugin-installer-toggle','text')))+disclose('plugins-audit',tr('高级：已注册能力与绑定','Advanced: registered capabilities and bindings'),'<p>'+tr('这些是已注册的合成模块；注册不代表运行健康。','These are registered synthetic modules; registration does not demonstrate healthy processing.')+'</p>'+p.packages.map(pkg=>row32(content(pkg.name),tr('Server / Web 版本：','Server / Web version: ')+pkg.version+' / '+pkg.version+' · '+pkg.capabilities.map(content).join(', ')+' · '+tr('实例：','Instances: ')+p.instances.filter(i=>i.package===pkg.id).length)).join('')+facts([[tr('当前绑定','Current binding'),content(p.currentPlan)],[tr('准备状态','Preparation state'),active?content(prep.status):tr('没有正在准备的更换','No active preparation')]]))+'<div class="actions">'+link(tr('记忆策略与回顾节奏','Memory policy and review cadence'),'settings/memory-strategy')+link(tr('查看已保存记忆','View saved memories'),'memories')+'</div></article>';
  }
  const status32=key=>tr(...({open:['待回答','Open'],deferred:['稍后处理','Deferred'],answered:['回答已记录','Answer recorded'],closed:['已结束','Ended'],obsolete:['已失效','Stale'],attention:['需要处理','Needs attention'],running:['进行中','Running'],queued:['等待执行','Queued'],succeeded:['已完成','Completed'],cancelled:['已取消','Cancelled'],failed:['失败','Failed'],unknown:['外部结果未确认','External result unknown'],review:['等待成果审核','Awaiting result review'],waiting:['等待依赖','Waiting for dependency']}[key]||[key,key]));
  function questions32(){const c=central();c.questions||=state.dataState==='empty'?[]:[{id:'q-recording',title:'项目讨论录音 · 第一轮设计',material:'m5',work:'recording-memory',revision:1,state:'open',prompt:'“第一轮设计”指的是哪个阶段？',reason:'这段录音没有明确阶段名称。请补充你知道的背景。',evidence:state.materials.find(m=>m.id==='m5')?.body?.split('\n').slice(0,2).join('\n')||'合成录音片段：第一轮设计完成后，再核对下一步。',choices:[{id:'interaction',label:'交互原型阶段',answer:'这里指的是交互原型阶段。'},{id:'visual',label:'视觉设计阶段',answer:'这里指的是视觉设计阶段。'}],messages:[]}];return c.questions;}
  function questionDraft(q){return draft32('question-'+q.id,{revision:q.revision,text:'',choice:''});}
  function questionPage(){
    const qs=questions32(),id=state.page.split('/')[2]||central().questionId||qs[0]?.id,q=qs.find(x=>x.id===id);
    if(!q)return heading(tr('待你澄清','Clarifications'),tr('只补充相关资料缺少的背景。','Supply missing context for the relevant material.'),link(tr('返回提问','Back to Ask'),'ask'))+'<div class="empty"><h2>'+tr('没有等待补充的问题','No clarification is waiting')+'</h2><p>'+tr('资料仍可阅读；其他工作继续。','Your materials remain readable and other work continues.')+'</p></div>';
    const d=questionDraft(q),editable=['open','deferred'].includes(q.state),m=state.materials.find(x=>x.id===q.material);
    return heading(tr('补充资料背景','Clarify this material'),tr('回答只用于这份资料；原文和其他工作保留。','Your answer applies only to this material; original evidence and other work remain.'),link(tr('返回提问','Back to Ask'),'ask'))+'<article class="reading cs-task" data-cs-question="'+q.id+'"><section class="cs-zone"><div class="cs-summary"><h2>'+content(q.title)+'</h2>'+tag(status32(q.state),editable?'yellow':'')+'</div><p>'+content(q.reason)+'</p><p>'+content(q.prompt)+'</p><p class="small">'+tr('问题版本 ','Question revision ')+q.revision+' · '+content(q.id)+'</p></section>'+disclose('question-evidence',tr('相关原文','Related original evidence'),'<blockquote class="cs-preserve" data-user-content>'+esc(q.evidence)+'</blockquote>'+link(m?m.title:tr('打开相关原文','Open related original'),'material/'+q.material),true)+q.messages.map(x=>'<section class="cs-zone"><h3>'+tr('已记录的补充','Recorded clarification')+'</h3><p class="cs-preserve" data-user-content>'+esc(x.text)+'</p><p class="small">'+content(x.time)+' · v'+x.revision+'</p></section>').join('')+message32('question-'+q.id)+(q.state==='answered'?note(tr('回答已记录，相关工作继续等待成果审核。这不等于记忆已经发布。','The answer is recorded; the related work awaits result review. This does not mean memory has been published.')):'')+(q.state==='deferred'?note(tr('已稍后处理；其他工作不受影响。返回后仍可以回答。','Deferred; unrelated work continues. You can answer when you return.')):'')+(q.state==='closed'?note(tr('原文和不确定性保留，本次不再追问。','Original evidence and its uncertainty remain; this question is ended.'))+button32(tr('我有新信息了','I have new information'),'question-reopen','subtle','data-id="'+q.id+'"'):'')+(q.state==='obsolete'?note(tr('来源或处理版本已变化。此旧问题不接受回答，请打开当前问题。','The source or processing version changed. This stale question cannot accept an answer; open the current question.'),'warn')+(q.replacement?link(tr('打开当前问题','Open the current question'),'ask/clarifications/'+q.replacement,'primary'):''):'')+(editable?'<section class="cs-zone"><div class="actions">'+q.choices.map(choice=>button32(content(choice.label),'question-choice',d.choice===choice.id?'primary':'subtle','data-id="'+q.id+'" data-choice="'+choice.id+'"')).join('')+'</div>'+fields32(area32('question-'+q.id,'text',tr('补充你知道的信息','Add what you know'),d.text,'maxlength="6000"'))+'<div class="form-actions">'+button32(tr('回答并继续','Answer and continue'),'question-answer','primary','data-id="'+q.id+'"')+button32(tr('稍后再说','Defer'),'question-defer','text','data-id="'+q.id+'"')+button32(tr('我也不知道，结束这次追问','I do not know; end this question'),'question-end','text','data-id="'+q.id+'"')+'</div></section>':'')+'<div class="actions">'+link(tr('查看相关工作','Open related work'),'activity/work/'+q.work)+link(tr('打开来源资料','Open source material'),'material/'+q.material)+'</div>'+disclose('question-history',tr('补充问题记录','Question history'),qs.map(item=>row32(content(item.title),status32(item.state),link(tr('打开','Open'),'ask/clarifications/'+item.id))).join(''))+disclose('question-fixtures',tr('原型：问题更新与提交失败','Prototype: stale question and reply failure'),button32(tr('模拟来源更新，使本问题失效','Simulate a source update that makes this question stale'),'question-stale','text','data-id="'+q.id+'"')+button32(tr('下次提交模拟失败','Fail the next reply'),'question-fail-next','text','data-id="'+q.id+'"'))+'</article>';
  }
  function works32(){
    const c=central();if(!c.works){const m=state.materials.find(x=>x.id==='m2')||state.materials[0];c.works=state.dataState==='empty'?[]:[
      {id:'source-recovery',title:'恢复飞书来源授权',status:state.taskRetried?'succeeded':'attention',source:'lark',material:'',stage:'授权检查',progress:0,cause:'source',owner:'setup/lark',branches:[{id:'authorization',title:'来源授权检查',status:'attention',result:false,evidence:[],events:['授权已过期；之前保存的资料保留。'],kind:'connector',attempts:1,next:'等待重新授权'}]},
      {id:'memory-study',title:'整理最近的研究资料',status:'running',source:m?.sourceId||'folder',material:m?.id||'',stage:'提取事实',progress:66,cause:'',owner:'memories',branches:[{id:'body',title:'归档与正文',status:'succeeded',result:true,material:m?.id||'',evidence:m?[{id:m.id,title:m.title,text:m.body.split('\n')[0]}]:[],events:['原件已保留','正文已发布'],kind:'archive',attempts:1,next:'—'},{id:'memory',title:'记忆候选审核',status:'running',result:false,evidence:m?[{id:m.id,title:m.title,text:m.body.split('\n')[0]}]:[],events:['读取指定原文','等待结果核验；尚无已保存记忆'],kind:'memory',attempts:1,next:'当前执行中'},{id:'index',title:'正文检索索引',status:'failed',result:false,evidence:[],events:['合成索引尝试失败；正文仍可阅读'],kind:'index',attempts:1,next:'现在可重试'}]},
      {id:'file-complete',title:'导入长期记忆系统调研笔记',status:'succeeded',source:m?.sourceId||'folder',material:m?.id||'',stage:'正文已保存',progress:100,cause:'',owner:m?'material/'+m.id:'library',branches:[{id:'published',title:'已发布正文',status:'succeeded',result:true,material:m?.id||'',evidence:m?[{id:m.id,title:m.title,text:m.body.split('\n')[0]}]:[],events:['原件已归档','正文确认后保存','记忆状态独立计算'],kind:'archive',attempts:1,next:'—'}]},
      {id:'recording-memory',title:'项目讨论录音 · 记忆整理',status:'attention',source:'folder',material:'m5',stage:'等待背景说明',progress:35,cause:'question',owner:'ask/clarifications/q-recording',branches:[{id:'clarify',title:'背景澄清',status:'waiting',result:false,evidence:[],events:['转写原文已保留','第一轮设计的含义待确认'],kind:'context',attempts:1,next:'等待你的回答'}]},
      {id:'model-recovery',title:'导入资料的记忆整理',status:'attention',source:m?.sourceId||'folder',material:m?.id||'',stage:'等待记忆模型',progress:50,cause:'model',owner:'settings/assignments',branches:[{id:'model',title:'记忆模型检查',status:'waiting',result:false,evidence:[],events:['原件与正文已保存','没有给记忆模块分配连接'],kind:'context',attempts:0,next:'等待模型配置'}]},
      {id:'external-unknown',title:'外部语音处理结果',status:'unknown',source:'folder',material:'m5',stage:'等待核对外部结果',progress:50,cause:'unknown',owner:'material/m5',branches:[{id:'external',title:'外部转写调用',status:'unknown',result:false,evidence:[],events:['请求已提交；随后连接中断','没有确认外部成功或失败'],kind:'external',attempts:1,next:'等待回执核对，不直接重复提交'}]}
    ];}return c.works;
  }
  function relatedWorks(){return [...works32(),...state.imports.map(j=>({id:'import-'+j.id,title:j.name,status:j.phase==='done'?'succeeded':['failed','needs_configuration','review','unsupported'].includes(j.phase)?'attention':'running',source:j.sourceId||'',material:j.materialId||'',stage:j.phase,progress:j.phase==='done'?100:30,cause:'import',owner:'import/details/'+j.id,branches:[]}))];}
  function workFilter(w,filter){return filter==='all'||filter==='active'&&['running','queued','waiting','unknown'].includes(w.status)||filter==='attention'&&['attention','failed','review'].includes(w.status)||filter==='completed'&&['succeeded','cancelled'].includes(w.status);}
  function workPage(){
    const c=central(),d=draft32('work-list',{filter:'all',source:'',material:'',page:0}),all=relatedWorks(),rows=all.filter(w=>workFilter(w,d.filter)&&(!d.source||w.source===d.source)&&(!d.material||w.material===d.material)),offset=Number(d.page||0)*3,visible=rows.slice(offset,offset+3);
    return heading(tr('活动','Activity'),tr('查看目标、进度和下一步，沿工作回到对应资料。','Review each goal, its progress and the next action; return to the related material.'),button32(tr('刷新工作','Refresh work'),'work-refresh','subtle'))+'<article class="cs-task">'+message32('work-list')+(c.workConnectionInterrupted?note(tr('进度连接已中断，正在自动重连。后台工作未因此停止。','Progress connection interrupted; reconnecting automatically. Background work has not stopped.'),'warn'):'')+fields32(select32('work-list','filter',tr('工作状态','Work state'),d.filter,[['all','全部工作','All work'],['active','执行与等待','Active and waiting'],['attention','需要处理','Needs attention'],['completed','最近完成','Recently completed']]))+disclose('work-scope',tr('来源 / 资料范围','Source / material scope'),fields32(select32('work-list','source',tr('相关来源','Related source'),d.source,sourceRows(true))+select32('work-list','material',tr('相关资料','Related material'),d.material,[['','全部资料','All materials'],...state.materials.map(m=>[m.id,m.title,m.title])]))+button32(tr('清除相关范围','Clear related scope'),'work-scope-clear','text'))+(c.workLoadError?note(tr('工作列表读取失败。已显示的已保存产品仍可从资料库打开。','Work list loading failed. Saved products remain accessible in the library.')+'<div class="actions">'+button32(tr('重试读取','Retry loading'),'work-refresh')+'</div>','warn'):!state.authenticated?note(tr('Central 尚未连接。连接后查看账号工作。','Central is not connected. Connect to inspect account work.'),'warn'):visible.map(w=>'<section class="cs-zone" data-cs-work="'+w.id+'"><div class="cs-summary"><h2>'+content(w.title)+'</h2>'+tag(status32(w.status),w.status==='succeeded'?'green':'')+'</div><p>'+content(w.stage)+' · '+w.progress+'%</p><p class="small">'+content(sourceName(w.source))+'</p><div class="actions">'+link(tr('工作详情','Work detail'),'activity/work/'+w.id,'primary')+link(tr('打开原任务','Open task owner'),w.owner)+'</div></section>').join('')||'<div class="empty"><h2>'+tr('这个范围没有工作','No work in this scope')+'</h2><p>'+tr('可清除范围或更改状态筛选。','Clear the scope or choose another state.')+'</p></div>')+'<div class="form-actions">'+button32(tr('上一页','Previous page'),'work-page','text','data-offset="-1" '+(offset?'':'disabled'))+'<span>'+tr('第 ','Page ')+(Number(d.page)+1)+' / '+Math.max(1,Math.ceil(rows.length/3))+'</span>'+button32(tr('下一页','Next page'),'work-page','text','data-offset="1" '+(offset+3<rows.length?'':'disabled'))+'</div>'+disclose('work-tools',tr('技术记录与进度连接','Technical records and progress connection'),link(tr('技术执行记录','Technical execution records'),'activity/technical')+link(tr('Coding 接收与发布状态','Coding receipt and publication'),'activity/coding')+link(tr('查看应用使用记录','Application usage'),'application')+button32(tr('模拟进度连接中断','Simulate interrupted progress connection'),'work-interrupt','text')+button32(tr('模拟列表读取失败','Simulate list loading failure'),'work-load-fail','text'))+'</article>';
  }
  function causeText(w){return ({model:tr('执行记录显示：记忆模块尚未分配模型。原件与正文已保存，索引 / 记忆未完成。','The inspected record shows an unassigned memory model. Original and body are saved; index / memory are incomplete.'),question:tr('相关资料缺少阶段背景，需要你回答限定范围的问题。','This material needs a scope-limited answer about its project stage.'),source:tr('此来源的授权过期。已保存的资料不受影响，后续同步等待重新授权。','This source authorization expired. Saved material remains; later synchronization awaits renewed authorization.'),unknown:tr('只有请求已提交的记录，没有成功或失败回执。先核对结果，不能据此重复提交。','Only submission is recorded; no success or failure receipt exists. Verify the outcome before another submission.'),import:tr('请回到同一次导入查看其原件、预览和恢复选项。','Return to this import for its original, preview and recovery controls.')}[w.cause]||tr('没有未解决的阻塞原因。','No unresolved blocking reason is recorded.'));}
  function workDetailPage(id){
    const c=central(),w=relatedWorks().find(x=>x.id===id);if(!w)return heading(tr('工作不可用','Work unavailable'),tr('未找到这项工作。','This work was not found.'),link(tr('返回活动','Back to Activity'),'activity'));
    const page=Number(c.branchPage?.[w.id]||0),branches=w.branches.slice(page*2,page*2+2),chosen=w.branches.find(b=>b.id===c.selectedBranch?.[w.id]);
    return heading(tr('工作详情','Work detail'),w.title,link(tr('返回工作列表','Back to work list'),'activity'))+'<article class="reading cs-task"><section class="cs-zone"><div class="cs-summary"><h2>'+content(w.title)+'</h2>'+tag(status32(w.status))+'</div>'+facts([[tr('阶段 / 进度','Stage / progress'),content(w.stage)+' / '+w.progress+'%'],[tr('关联来源','Source'),content(sourceName(w.source))],[tr('已保存结果','Saved results'),String(w.branches.filter(b=>b.result).length)],[tr('依据条数','Evidence records'),String(w.branches.reduce((n,b)=>n+b.evidence.length,0))]])+message32('work-'+w.id)+(w.cause?note(causeText(w),'warn')+'<div class="actions">'+button32(tr(w.cause==='model'?'配置所需模型':w.cause==='question'?'回答相关问题':'打开任务处理原因',w.cause==='model'?'Configure required model':w.cause==='question'?'Answer related question':'Open task owner to resolve'),'work-owner','primary','data-id="'+w.id+'"')+button32(tr('重新核对原因','Reload cause'),'work-cause-reload','text','data-id="'+w.id+'"')+'</div>':'')+'<div class="actions">'+link(tr('打开原任务','Open task owner'),w.owner)+(w.material?link(tr('查看相关资料','Open related material'),'material/'+w.material):'')+'</div></section><section class="cs-zone"><h3>'+tr('工作分支与已保存结果','Branches and saved results')+'</h3>'+branches.map(b=>row32(content(b.title),status32(b.status)+' · '+tr('结果 ','results ')+(b.result?1:0)+' · '+tr('依据 ','evidence ')+b.evidence.length,button32(tr('打开分支','Open branch'),'work-branch','subtle','data-id="'+w.id+'" data-branch="'+b.id+'"'))).join('')+(!w.branches.length?'<p>'+tr('此导入的分支记录在原导入详情。','Branch details are retained by the original import.')+'</p>':'')+'<div class="actions">'+button32(tr('上一页分支','Previous branches'),'work-branches-page','text','data-id="'+w.id+'" data-offset="-1" '+(page?'':'disabled'))+button32(tr('下一页分支','Next branches'),'work-branches-page','text','data-id="'+w.id+'" data-offset="1" '+((page+1)*2<w.branches.length?'':'disabled'))+'</div></section>'+(chosen?'<section class="cs-zone" id="cs32-branch-detail"><h3>'+content(chosen.title)+'</h3>'+facts([[tr('实际状态','Recorded status'),status32(chosen.status)],[tr('已保存产物','Saved artifact'),chosen.result?link(tr('打开已保存正文','Open saved body'),'material/'+chosen.material):tr('暂无。未确认前不显示为已保存。','None. Unconfirmed output is not presented as saved.')]])+'<ol class="cs-events">'+chosen.events.map(e=>'<li>'+content(e)+'</li>').join('')+chosen.evidence.map(e=>'<blockquote class="cs-preserve" data-user-content>'+esc(e.text)+'</blockquote>'+link(tr('打开依据：','Open evidence: ')+e.title,'material/'+e.id)).join('')+(chosen.evidence.length?button32(tr('查看保留的 Agent 实际读取示例','Inspect retained actual Agent-read fixture'),'work-trace','subtle','data-id="'+w.id+'" data-branch="'+chosen.id+'"'):'')+'</section>':'')+disclose('work-technical',tr('高级：技术执行与恢复','Advanced: execution and recovery'),w.branches.map(b=>row32(content(b.id),content(b.kind)+' · '+status32(b.status)+' · '+tr('尝试 ','attempts ')+b.attempts+' · '+content(b.next),button32(tr('打开操作','Open operation'),'work-operation','text','data-id="'+w.id+'" data-branch="'+b.id+'"'))).join('')+link(tr('所有技术记录','All technical records'),'activity/technical'))+'</article>';
  }
  function technicalPage(){
    const d=draft32('technical',{status:'all',kind:'all',page:0}),rows=works32().flatMap(w=>w.branches.map(b=>({...b,work:w.id,workTitle:w.title}))).filter(b=>(d.status==='all'||b.status===d.status)&&(d.kind==='all'||b.kind===d.kind)),offset=Number(d.page)*3,selected=central().operation,work=works32().find(w=>w.id===selected?.work),branch=work?.branches.find(b=>b.id===selected.branch);
    return heading(tr('技术执行记录','Technical execution records'),tr('只在支持的索引 / 上下文步骤中重试，保留已经保存的产品。','Retry eligible index / context steps while retaining saved products.'),link(tr('返回活动','Back to Activity'),'activity'))+'<article class="cs-task">'+fields32(select32('technical','status',tr('执行状态','Execution state'),d.status,[['all','全部','All'],['failed','失败','Failed'],['running','执行中','Running'],['waiting','等待','Waiting'],['unknown','结果未知','Unknown outcome'],['succeeded','完成','Completed'],['cancelled','取消','Cancelled']])+select32('technical','kind',tr('任务类型','Task kind'),d.kind,[['all','全部','All'],['index','索引','Index'],['context','上下文','Context'],['memory','记忆','Memory'],['external','外部调用','External call'],['archive','归档','Archive'],['connector','来源','Source']]))+rows.slice(offset,offset+3).map(b=>row32(content(b.workTitle)+' / '+content(b.title),status32(b.status),button32(tr('打开操作','Open operation'),'work-operation','subtle','data-id="'+b.work+'" data-branch="'+b.id+'"'))).join('')+'<div class="actions">'+button32(tr('上一页','Previous page'),'technical-page','text','data-offset="-1" '+(offset?'':'disabled'))+button32(tr('下一页','Next page'),'technical-page','text','data-offset="1" '+(offset+3<rows.length?'':'disabled'))+'</div>'+(branch?'<section class="cs-zone"><h3>'+content(branch.title)+'</h3>'+message32('operation')+facts([[tr('操作 ID','Operation ID'),content(work.id+'/'+branch.id)],[tr('状态','State'),status32(branch.status)],[tr('依赖','Dependencies'),branch.kind==='index'?tr('已发布正文','Published body'):branch.kind==='context'?tr('当前模型或有效澄清','Current model or valid clarification'):tr('所属工作所需权限与输入','Owner task authority and inputs')],[tr('尝试次数','Attempts'),String(branch.attempts)],[tr('下次可执行时间','Next runnable time'),content(branch.next)]])+'<ol class="cs-events">'+branch.events.map(e=>'<li>'+content(e)+'</li>').join('')+(branch.status==='unknown'?note(tr('外部结果未知，不等于失败；此步骤不提供盲目重试。','The external result is unknown, not failed; this step has no blind retry control.'),'warn'):'')+'<div class="actions">'+(['index','context'].includes(branch.kind)&&['failed','cancelled'].includes(branch.status)?button32(tr('重试这一步','Retry this step'),'work-step-retry','primary','data-id="'+work.id+'" data-branch="'+branch.id+'"'):'')+(['running','queued','waiting'].includes(branch.status)?button32(tr('取消这一步','Cancel this step'),'work-step-cancel','text','data-id="'+work.id+'" data-branch="'+branch.id+'"'):'')+link(tr('返回所属工作','Return to owning work'),'activity/work/'+work.id)+'</div></section>':'')+'</article>';
  }
  function tracePage32(){const c=central(),d=draft32('trace',{run:c.traceRun||'',page:0}),trace=(c.traces||[]).find(x=>x.id===d.run);return '<article class="cs-task">'+note(tr('实际输入只来自保留的运行记录；当前目录、记忆或预览不能重建过去的输入。以下记录明确标为合成示例。','Actual input is shown only from retained run records. Current directories, memory or previews cannot reconstruct past input. The records below are explicitly synthetic fixtures.'))+fields32(select32('trace','run',tr('保留的运行记录','Retained run'),d.run,[['','选择运行','Choose a run'],...(c.traces||[]).map(x=>[x.id,x.id,x.id])])+field32('trace','requested',tr('或输入运行 ID','Or enter a run ID'),d.requested||''))+'<div class="actions">'+button32(tr('打开实际轨迹','Open actual trace'),'trace-open','primary')+link(tr('查看诊断偏好','Diagnostic preferences'),'settings/diagnostics')+'</div>'+(trace?'<section class="cs-zone"><h3>'+content(trace.id)+'</h3>'+facts([[tr('记录类型','Record kind'),tr('合成保留输入 / 没有模型调用','Synthetic retained input / no model call')],[tr('模型','Model'),content(trace.model)],[tr('时间','Time'),content(trace.at)]])+trace.events.slice(Number(d.page)*2,Number(d.page)*2+2).map(e=>'<article class="cs-zone"><h3>'+content(e.kind)+'</h3><p class="cs-preserve" data-user-content>'+esc(e.text)+'</p></article>').join('')+'<div class="actions">'+button32(tr('上一页内容','Previous content'),'trace-page','text','data-offset="-1" '+(d.page?'':'disabled'))+button32(tr('下一页内容','Next content'),'trace-page','text','data-offset="1" '+((Number(d.page)+1)*2<trace.events.length?'':'disabled'))+'</div></section>':note(tr('没有此运行的详细记录。需要事先启用详细 Agent 记录；缺失、截断或过期内容不能从当前记忆补造。','No detailed record exists for this run. Detailed Agent logging must have been enabled beforehand; missing, truncated or historical content cannot be fabricated from current memory.'),'warn'))+'</article>';}
  function policyError(d){
    if(Number(d.maxAudioMinutes)<1||Number(d.maxAudioMinutes)>1440||Number(d.timeoutSeconds)<1||Number(d.timeoutSeconds)>3600)return tr('时长需为 1–1440 分钟，超时需为 1–3600 秒。','Audio length must be 1–1440 minutes and timeout 1–3600 seconds.');
    for(const p of d.profiles){
      if(!p.name.trim())return tr('每个方案都需要名称。','Each plan needs a name.');
      const v=p.parameters||{},numbers=['speakerCount','speakerMin','speakerMax'].filter(k=>v[k]!==''&&v[k]!=null);
      if(numbers.some(k=>!Number.isInteger(Number(v[k]))||Number(v[k])<1||Number(v[k])>16))return tr('说话人数需为 1–16 的整数，未知时留空。','Speaker counts must be integers from 1–16; leave them blank when unknown.');
      if(v.speakerCount&&(v.speakerMin||v.speakerMax)||v.speakerMin&&v.speakerMax&&Number(v.speakerMin)>Number(v.speakerMax))return tr('准确人数与范围不可同时填写，且下限不能超过上限。','Use an exact speaker count or a range; the minimum cannot exceed the maximum.');
      const service=d.services.find(s=>s.id===p.service),provider=central().providers?.find(x=>x.id===service?.reference);
      if(processorMeta[p.processor]?.local&&provider&&!provider.local)return tr('本地多人录音必须引用本地执行的连接；草稿保留。','Local multi-speaker recording requires a local connection; the draft is retained.');
    }
    if(d.services.some(s=>!s.name.trim()))return tr('每个服务都需要名称。','Each service needs a name.');
    if(!d.rules.some(r=>!r.source&&r.type==='*/*'))return tr('请保留全局“其他”回退规则。','Keep a global other-type fallback rule.');
    const used=new Set();for(const r of d.rules){const key=r.source+'|'+r.type;if(!/^(\*|[a-z0-9.+-]+)\/(\*|[a-z0-9.+-]+)$/i.test(r.type)||used.has(key))return tr('MIME 规则格式不正确，或同一来源重复配置了同一类型。','A MIME pattern is invalid or duplicated for the same source.');used.add(key);const profile=d.profiles.find(p=>p.id===r.profile);if(!profile||!profileCompatible(profile,r.type))return tr('所选方案与文件类型不兼容，或插件不可用。请明确选择可用方案。','The selected plan is incompatible or its plugin is unavailable. Explicitly choose an eligible plan.');}
    return '';
  }
  function addWorkReceipt(receipt){works32().unshift({id:receipt.id,title:tr('文件重新处理','File reprocessing'),status:'queued',source:receipt.source,material:receipt.items[0]?.id||'',stage:tr('等待处理器','Waiting for processor'),progress:0,cause:'',owner:'settings/file-processing',branches:receipt.items.map(item=>({id:item.id,title:item.title,status:'queued',result:false,evidence:[],events:[tr('已按保存的规则版本排队；原件保留。','Queued against the saved policy revision; original retained.')],kind:'context',attempts:0,next:tr('等待执行名额与服务','Waiting for execution capacity and service')}))});}
  const priorAction32=window.performCentralSemantics32;
  window.performCentralSemantics32=async function(action,el){
    rememberDisclosures32();
    const c=central(),id=el.dataset.id;
    if(action==='provider-delete'){
      const used=c.processing?.saved.services.some(s=>s.reference===c.providerId)||c.plugins?.instances.some(i=>i.model===c.providerId||i.credential===c.providerId);
      if(used)return finish32('provider',tr('此连接仍被文件处理服务或插件实例引用；先解除引用再删除。','This connection is still referenced by a file service or plugin instance. Remove those references before deletion.'),true);
    }
    if(action.startsWith('policy-')){
      const p=processing(),d=policyDraft();
      if(action==='policy-save'){
        if(d.revision!==p.revision)return finish32('policy',tr('保存版本冲突；草稿保留。请重新加载已保存值后再编辑。','Revision conflict; draft retained. Reload saved values before editing again.'),true);
        const error=policyError(d);if(error)return finish32('policy',error,true);
        const saved=cp(d);delete saved.revision;p.saved=saved;p.revision++;d.revision=p.revision;p.preview=null;p.match=null;p.checks={};
        return finish32('policy',tr('处理设置已保存为版本 ','Processing settings saved as revision ')+p.revision+tr('。新文件和未完成任务采用此版本；已完成结果保留。','; new and unfinished work uses it, while completed results remain.'));
      }
      if(action==='policy-reload'){c.drafts.policy={revision:p.revision,...cp(p.saved)};p.preview=null;p.match=null;return finish32('policy',tr('已重新加载保存值，草稿已明确放弃。','Saved values reloaded; the draft was explicitly discarded.'));}
      if(action==='policy-rule-add')d.rules.push({id:uid('rule'),source:'',type:'application/json',profile:'p-archive'});
      if(action==='policy-override-add'&&state.sources[0])d.rules.push({id:uid('override'),source:state.sources[0].id,type:'audio/*',profile:d.profiles.find(x=>x.processor==='archive')?.id||d.profiles[0].id});
      if(action==='policy-rule-remove'){const i=Number(el.dataset.index);if(d.rules[i]&&(d.rules[i].source||d.rules[i].type!=='*/*'))d.rules.splice(i,1);}
      if(action==='policy-plan-add')d.profiles.push({id:uid('plan'),name:tr('新处理方案','New processing plan'),processor:'archive',parameters:{},service:'',speaker:'audio.diarize',analysis:'',summary:false});
      if(action==='policy-plan-copy'){const source=d.profiles.find(x=>x.id===id);if(source)d.profiles.push({...cp(source),id:uid('plan'),name:source.name+tr(' 副本',' copy')});}
      if(action==='policy-plan-remove'){if(d.rules.some(r=>r.profile===id))return finish32('policy',tr('方案仍被规则引用，未删除。','A rule still references this plan; it was not deleted.'),true);d.profiles=d.profiles.filter(x=>x.id!==id);}
      if(action==='policy-service-add')d.services.push({id:uid('service'),name:tr('新服务','New service'),kind:'asr',reference:''});
      if(action==='policy-service-remove'){if(d.profiles.some(x=>x.service===id||x.analysis===id))return finish32('policy',tr('服务仍被方案引用，未删除。','A plan still references this service; it was not deleted.'),true);d.services=d.services.filter(x=>x.id!==id);}
      if(action==='policy-service-test'){
        if(policyDirty())return finish32('policy',tr('检测只使用已保存的服务，请先保存。','Checks use saved services only; save the draft first.'),true);
        const s=p.saved.services.find(x=>x.id===id),provider=c.providers?.find(x=>x.id===s?.reference);
        p.checks[id]=provider?.local?{text:tr('合成检测回执：转写 ','Synthetic check receipt: ASR ')+tr(p.models.dialogue?'就绪':'未就绪',p.models.dialogue?'ready':'not ready')+' · '+tr('说话人分离 ','speaker grouping ')+tr(p.models.dialogue||p.models.wespeaker?'就绪':'未就绪',p.models.dialogue||p.models.wespeaker?'ready':'not ready')+tr('。未访问真实服务。','; no real service was contacted.'),error:!p.models.dialogue}:{text:tr('已保存服务没有本地连接引用。请配置本地连接后再检测；远程连接不被当作本地服务。','This saved service has no local connection reference. Configure a local connection before checking; a remote reference is not treated as local.'),error:true};return repaint32();
      }
      if(action==='policy-model-install'){p.models[id]=true;return finish32('policy',tr('示例模型包状态已核对为已安装；没有下载或运行模型。','Fixture model package state is installed; no model was downloaded or run.'));}
      if(['policy-match','policy-preview','policy-confirm'].includes(action)){
        if(policyDirty())return finish32('policy-trial',tr('存在未保存修改；当前试算 / 预览未提交。','Unsaved changes remain; this trial or preview was not submitted.'),true);
        const trial=draft32('policy-trial',{source:'',type:'*/*',mime:'audio/wav'});
        if(action==='policy-match'){const matched=matchRule(trial.source,trial.mime);if(!matched)return finish32('policy-trial',tr('没有匹配的保存规则。','No saved rule matched.'),true);p.match={revision:p.revision,source:matched.rule.source,type:matched.rule.type,name:matched.profile?.name||'',processor:matched.profile?.processor||''};return finish32('policy-trial',tr('已按保存的版本试算。未执行内容处理。','Matched the saved revision. No content processing was executed.'));}
        if(action==='policy-preview'){
          if(!p.saved.enabled)return finish32('policy-trial',tr('文件处理已关闭，请先保存启用状态。','File processing is disabled; save an enabled policy first.'),true);
          const files=state.materials.filter(m=>['file','audio','image'].includes(m.type)&&(!trial.source||m.sourceId===trial.source)),items=[];let skipped=0;
          for(const m of files){const mime=m.mime||({audio:'audio/wav',image:'image/png',file:'text/plain'}[m.type]);if(!mimeMatches(trial.type,mime))continue;const match=matchRule(m.sourceId||'',mime),running=Object.values(c.files?.[m.id]?.stages||{}).some(s=>s==='running');if(!match?.profile||match.profile.processor==='archive'||running||m.shadow){skipped++;continue;}if(items.length<100)items.push({id:m.id,title:m.title,plan:match.profile.name,rule:match.rule.type});}
          p.preview={id:uid('preview'),revision:p.revision,fingerprint:JSON.stringify(trial),source:trial.source,items,skipped,expiresAt:new Date(Date.now()+600000).toISOString()};return finish32('policy-trial',tr('已生成当前原件的合成预览，确认后才会安排任务。','Synthetic preview created for current originals. Confirmation is required to queue work.'));
        }
        const preview=p.preview;if(!preview||preview.revision!==p.revision||preview.fingerprint!==JSON.stringify(trial)||Date.parse(preview.expiresAt)<=Date.now())return finish32('policy-trial',tr('预览已失效，请重新预览。没有安排任务。','The preview is stale; create another preview. No work was queued.'),true);
        const receipt={id:uid('reprocess'),items:cp(preview.items),source:preview.source,revision:p.revision,createdAt:stamp()};p.receipts.unshift(receipt);p.preview=null;addWorkReceipt(receipt);return finish32('policy-trial',tr('这批已加入模拟队列。原件保留，后续派生版本与旧修正分开显示。','This batch entered the simulated queue. Originals remain; later derived versions are distinct from earlier corrections.'));
      }
      p.preview=null;p.match=null;return repaint32();
    }
    if(action.startsWith('grant-')){
      const grants=grants32(),d=draft32('grant',{name:'',access:'read'});
      if(action==='grant-generate'){
        if(!d.name.trim())return finish32('grant',tr('请填写连接名称。','Enter a connection name.'),true);
        const sources=state.sources.filter(s=>d['source-'+s.id]).map(s=>s.id);if(d.access==='write'&&!sources.length)return finish32('grant',tr('写入必须明确选择已有来源。','Writing requires an explicitly selected existing source.'),true);
        const id=uid('mcp-grant'),token='DEMO-NOT-A-REAL-CREDENTIAL-'+id;grants.unshift({id,name:d.name.trim(),access:d.access,sources,createdAt:stamp(),expiresAt:new Date(Date.now()+2592000000).toISOString(),revoked:false});grantSecret={id,config:{demo:true,mcpServers:{mote:{type:'http',url:(state.accountServiceUrl||'https://mote.example.invalid').replace(/\/$/,'')+'/mcp',headers:{Authorization:'Bearer '+token}}}}};return finish32('grant',tr('已生成本次示例配置。请复制或下载，之后可以隐藏。','The one-time fixture configuration is ready. Copy or download it before hiding.'));
      }
      if(action==='grant-copy'){if(!grantSecret)return true;try{await navigator.clipboard.writeText(JSON.stringify(grantSecret.config,null,2));return finish32('grant',tr('配置已复制。连接继续有效。','Configuration copied. The connection remains active.'));}catch{return finish32('grant',tr('浏览器未允许复制；可以选择 JSON 文本或下载配置。','Clipboard access was unavailable; select the JSON text or download the configuration.'),true);}}
      if(action==='grant-download'){if(grantSecret)download32('mote-mcp-demo-'+grantSecret.id+'.json',JSON.stringify(grantSecret.config,null,2));return finish32('grant',tr('示例配置文件已生成。','The fixture configuration file was generated.'));}
      if(action==='grant-hide'){grantSecret=null;return finish32('grant',tr('已隐藏凭据。连接仍有效；此页面不能重新显示旧凭据。','Credential hidden. The connection remains active; this page cannot reveal it again.'));}
      if(action==='grant-refresh')return finish32('grant',tr('已刷新当前账号的连接范围与状态。','Refreshed the current account’s connection scopes and states.'));
      if(action==='grant-revoke')c.revokeGrant=id;
      if(action==='grant-revoke-cancel')c.revokeGrant='';
      if(action==='grant-revoke-confirm'){const g=grants.find(x=>x.id===id);if(g){g.revoked=true;g.revokedAt=stamp();if(grantSecret?.id===id)grantSecret=null;}c.revokeGrant='';return finish32('grant',tr('所选连接已撤销。资料归档、其他连接和设备凭据保留。','The selected connection was revoked. Archives, other connections and device credentials remain.'));}
      return repaint32();
    }
    if(action.startsWith('plugin-')||action.startsWith('memory-plan-')||['memory-pause','memory-stop','memory-stop-confirm','memory-stop-cancel'].includes(action)){
      const p=plugins32(),install=draft32('plugin-install',{repository:'',tag:''});
      if(action==='memory-pause'){p.paused=!p.paused;state.memoryPaused=p.paused;if(!p.paused){p.stopped=false;state.memoryStopped=false;}return finish32('plugins',tr(p.paused?'新自动记忆任务已暂停。已接收任务继续收尾，原件仍归档。':'已恢复新资料的自动记忆。没有自动补算暂停期间的历史。',p.paused?'New automatic memory admissions are paused. Admitted work can finish and originals still archive.':'Automatic memory resumed for new material. Paused history was not automatically backfilled.'));}
      if(action==='memory-stop'){p.stopReview=true;return repaint32();}
      if(action==='memory-stop-cancel'){p.stopReview=false;return repaint32();}
      if(action==='memory-stop-confirm'){p.paused=true;p.stopped=true;p.stopReview=false;state.memoryPaused=true;state.memoryStopped=true;state.taskCanceled=true;const w=works32().find(w=>w.id==='memory-study');if(w){w.status='cancelled';w.branches.filter(b=>b.status==='running').forEach(b=>{b.status='cancelled';b.events.push('旧自动记忆写入权限已撤销；已保存正文保留。');});}return finish32('plugins',tr('旧自动记忆写入权限已撤销，并发出取消请求。外部未确认结果仍单独显示。','Old automatic memory write authority was revoked and cancellation requested. Unconfirmed external outcomes remain explicit.'));}
      if(action==='plugin-discover'){
        try{const u=new URL(install.repository);if(u.protocol!=='https:')throw Error();}catch{return finish32('plugin-install',tr('填写 HTTPS 仓库地址；草稿保留。','Enter an HTTPS repository URL; draft retained.'),true);}
        p.release={repository:install.repository,tag:install.tag||'v1.2.0',version:'1.2.0'};p.installPreview=null;return finish32('plugin-install',tr('发现 1 个合成示例版本，未访问仓库。','One synthetic release was discovered; no repository was contacted.'));
      }
      if(action==='plugin-preview'){if(!p.release)return true;const manifest=JSON.stringify(p.release),hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(manifest)))].map(x=>x.toString(16).padStart(2,'0')).join('');p.installPreview={...p.release,commit:'synthetic-fixture-'+hash.slice(0,12),hash,fingerprint:JSON.stringify(install)};return repaint32();}
      if(action==='plugin-preview-cancel'){p.installPreview=null;return repaint32();}
      if(action==='plugin-installer-toggle'){p.installationAvailable=!p.installationAvailable;return repaint32();}
      if(action==='plugin-install'){
        if(!c.admin||!p.installationAvailable)return finish32('plugin-install',tr('此账号或部署当前不能安装插件。','This account or deployment cannot install plugins.'),true);
        const preview=p.installPreview;if(!preview||preview.fingerprint!==JSON.stringify(install))return finish32('plugin-install',tr('预览已过期，请重新预览当前发布版本。','The preview is stale; preview this release again.'),true);
        const pkg={id:uid('package'),name:'Memory extension fixture',version:preview.version,installed:true,builtin:false,runtime:'Central Worker',hash:preview.hash,capabilities:['memory.extract','memory.query'],restart:false};p.packages.push(pkg);p.installPreview=null;p.release=null;p.revision++;return finish32('plugins',tr('示例包已安装；尚未创建实例、启用或绑定为当前方案。','The fixture package is installed. It has no instance and is not enabled or bound as the current plan.'));
      }
      if(action==='plugin-instance-new'||action==='plugin-instance-open'){p.instanceDrafts||={};const previousKey=p.selectedInstance||('new:'+p.selectedPackage);if(c.drafts['plugin-instance'])p.instanceDrafts[previousKey]=cp(c.drafts['plugin-instance']);p.selectedInstance=action==='plugin-instance-open'?id:'';p.selectedPackage=action==='plugin-instance-new'?id:p.instances.find(x=>x.id===id)?.package;p.editInstance=true;const nextKey=p.selectedInstance||('new:'+p.selectedPackage);if(p.instanceDrafts[nextKey])c.drafts['plugin-instance']=cp(p.instanceDrafts[nextKey]);else delete c.drafts['plugin-instance'];return repaint32();}
      if(action==='plugin-instance-close'){p.editInstance=false;return repaint32();}
      if(action==='plugin-instance-reload'){if(p.instanceDrafts)delete p.instanceDrafts[p.selectedInstance||('new:'+p.selectedPackage)];delete c.drafts['plugin-instance'];return finish32('plugin-instance',tr('已读取当前保存版本；草稿已明确放弃。','Current saved configuration reloaded; the draft was explicitly discarded.'));}
      if(action==='plugin-instance-conflict'){const i=p.instances.find(x=>x.id===p.selectedInstance);if(i)i.revision++;return finish32('plugin-instance',tr('已模拟另一会话更新。当前草稿保留；保存时会核对版本。','Another-session update was simulated. The draft remains and its revision will be checked when saved.'),true);}
      if(action==='plugin-instance-save'){
        const d=instanceDraft(),old=p.instances.find(i=>i.id===d.id);if(!d.name.trim())return finish32('plugin-instance',tr('实例名称不能为空。','Enter an instance name.'),true);if(old&&old.revision!==d.revision)return finish32('plugin-instance',tr('保存冲突：当前配置已变化。草稿保留，请明确重新读取后再编辑。','Conflict: the saved configuration changed. The draft remains; explicitly reload before editing again.'),true);
        const saved={...cp(d),id:old?.id||uid('instance'),revision:(old?.revision||0)+1,name:d.name.trim(),sources:state.sources.filter(s=>d['source-'+s.id]??d.sources.includes(s.id)).map(s=>s.id),validated:false,enabled:old?.enabled||false};if(old)Object.assign(old,saved);else p.instances.push(saved);p.selectedInstance=saved.id;c.drafts['plugin-instance']=cp(saved);return finish32('plugin-instance',tr('实例配置已保存，需要验证。保存没有自动启用或替换当前记忆方案。','Instance configuration saved and needs validation. Saving did not automatically enable it or replace the current memory plan.'));
      }
      if(action==='plugin-instance-validate'){const i=p.instances.find(x=>x.id===id);if(!i)return true;const model=c.providers?.find(x=>x.id===i.model);if(!model){i.validated=false;return finish32('plugins',tr('实例缺少可用模型连接，请配置后再验证。','The instance lacks an available model connection. Configure it before validation.'),true);}i.validated=true;i.validatedRevision=i.revision;return finish32('plugins',tr('已验证这份保存配置的合成回执。没有真实处理调用；尚未替换当前方案。','A synthetic validation receipt was recorded for this saved configuration. No real processing ran and the current plan did not change.'));}
      if(action==='plugin-instance-toggle'){const i=p.instances.find(x=>x.id===id);if(!i)return true;if(!i.enabled&&!i.validated)return finish32('plugins',tr('先验证当前保存的配置，再启用实例。','Validate the current saved configuration before enabling this instance.'),true);i.enabled=!i.enabled;return finish32('plugins',tr(i.enabled?'实例已启用，当前方案仍需单独绑定。':'实例已禁用，安装包和已有资料保留。',i.enabled?'Instance enabled; the current plan still requires a separate binding.':'Instance disabled; package and saved material remain.'));}
      if(action==='plugin-plan-open'){const i=p.instances.find(x=>x.id===id);if(!i)return true;if(!i.enabled||!i.validated)return finish32('plugins',tr('此实例需先验证并启用，才能注册可准备的方案。','Validate and enable this instance before registering a plan for preparation.'),true);let plan=p.plans.find(x=>x.instance===i.id);if(!plan){plan={id:uid('plan'),instance:i.id,name:i.name+' plan',verified:true};p.plans.push(plan);}draft32('memory-preparation',{target:'',scope:'',cost:false}).target=plan.id;c.messages['memory-preparation']={text:tr('方案已注册。请展开“准备替换方案”，预览范围后单独准备。','Plan registered. Open “Prepare a replacement plan”, preview the scope, then prepare it separately.'),error:false};return finish32('plugins',tr('已打开实例的注册方案；当前方案未改变。','The instance’s registered plan is available; the current plan is unchanged.'));}
      if(action==='plugin-uninstall'){p.uninstall=id;return repaint32();}
      if(action==='plugin-uninstall-cancel'){p.uninstall='';return repaint32();}
      if(action==='plugin-uninstall-confirm'){const pkg=p.packages.find(x=>x.id===id);if(!c.admin||!pkg||pkg.builtin||packageUsed(pkg))return finish32('plugins',tr('重新核验未通过：此包存在绑定、历史读取 / 排空依赖，或当前账号无卸载权限。','Eligibility recheck failed: the package is bound, has historical-reader / draining dependencies, or this account lacks uninstall access.'),true);p.packages=p.packages.filter(x=>x.id!==id);p.instances=p.instances.filter(i=>i.package!==id);p.plans=p.plans.filter(plan=>p.instances.some(i=>i.id===plan.instance));p.uninstall='';return finish32('plugins',tr('示例安装包已卸载。已有归档资料没有删除。','The fixture package was uninstalled. Archived material was not deleted.'));}
      if(action.startsWith('memory-plan-')){
        const d=draft32('memory-preparation',{target:'',scope:'',cost:false}),prep=p.preparations.at(-1);
        if(action==='memory-plan-preview'){
          const target=p.plans.find(x=>x.id===d.target&&x.id!==p.currentPlan);if(!target||!d.scope.trim()||!d.cost)return finish32('memory-preparation',tr('选择另一已注册方案，并填写已授权的历史范围及费用确认。','Choose another registered plan, enter the already-authorized history scope and acknowledge potential cost.'),true);
          p.planPreview={target:d.target,scope:d.scope,fingerprint:JSON.stringify(d)};return finish32('memory-preparation',tr('预览已生成，当前方案保持原样。','Preview created; the current plan remains unchanged.'));
        }
        if(action==='memory-plan-prepare'){if(!p.planPreview||p.planPreview.fingerprint!==JSON.stringify(d))return finish32('memory-preparation',tr('范围已修改，请重新预览后准备。','The scope changed; preview again before preparation.'),true);if(prep&&['preparing','verified'].includes(prep.status))return finish32('memory-preparation',tr('已有同一账号的方案正在准备，请先完成或取消。','This account already has an active preparation; complete or cancel it first.'),true);p.preparations.push({id:uid('memory-preparation'),target:d.target,scope:d.scope,oldPlan:p.currentPlan,status:'preparing',phase:'copy retained memory / validate index',createdAt:stamp()});p.planPreview=null;return finish32('memory-prep-result',tr('已登记准备回执；还没有切换方案。','Preparation receipt recorded; the current plan has not switched.'));}
        if(!prep)return true;
        if(action==='memory-plan-verify'&&prep.status==='preparing'){prep.status='verified';prep.phase='content and index verified; tail drained';return finish32('memory-prep-result',tr('合成核验已完成。请单独点击“设为当前方案”才会切换。','Synthetic validation completed. Activate separately with “Set as current plan”.'));}
        if(action==='memory-plan-cancel'){prep.status='cancelled';prep.phase='cancelled; old plan retained';return finish32('memory-prep-result',tr('准备已取消，旧方案与查询快照保留。','Preparation cancelled; the old plan and query snapshot remain.'));}
        if(action==='memory-plan-fail'){prep.status='failed';prep.phase='synthetic index validation failure';return finish32('memory-prep-result',tr('已模拟索引核验失败，没有切换方案。可重试同一次准备。','Index validation failure simulated; no plan switch occurred. Retry the same preparation.'),true);}
        if(action==='memory-plan-retry'){prep.status='preparing';prep.phase='retrying retained preparation';return finish32('memory-prep-result',tr('同一准备回执继续处理，范围保持原样。','The same preparation receipt is continuing with its original scope.'));}
        if(action==='memory-plan-activate'){if(prep.status!=='verified')return finish32('memory-prep-result',tr('准备尚未通过核验，不能切换。','Preparation has not been verified and cannot activate.'),true);const plan=p.plans.find(x=>x.id===prep.target),instance=p.instances.find(x=>x.id===plan?.instance);if(!instance?.enabled||!instance.validated)return finish32('memory-prep-result',tr('目标实例已变化或未启用，请重新核对。','The target instance changed or is disabled; recheck it.'),true);const old=p.plans.find(x=>x.id===p.currentPlan),oldInstance=p.instances.find(x=>x.id===old?.instance);if(oldInstance&&!p.historyReaders.includes(oldInstance.package))p.historyReaders.push(oldInstance.package);p.currentPlan=prep.target;prep.status='applied';prep.phase='current binding verified';c.messages['memory-preparation']=null;state.memoryScheme=plan.name;return finish32('memory-prep-result',tr('已单独激活新方案。旧查询快照保留用于历史读取。','The new plan was explicitly activated. The old query snapshot remains for historical reads.'));}
      }
      return repaint32();
    }

    if(action.startsWith('question-')){
      const q=questions32().find(x=>x.id===id);if(!q)return true;const d=questionDraft(q),key='question-'+q.id;
      if(action==='question-choice'){if(!['open','deferred'].includes(q.state))return true;const choice=q.choices.find(x=>x.id===el.dataset.choice);if(choice){d.choice=choice.id;d.text=choice.answer;}return repaint32();}
      if(action==='question-fail-next'){q.failNext=true;return finish32(key,tr('下一次回答将模拟提交失败，草稿不会丢失。','The next answer will simulate submission failure without losing its draft.'));}
      if(action==='question-stale'){
        q.state='obsolete';q.revision++;const replacement={...cp(q),id:uid('question'),state:'open',revision:1,failNext:false,prompt:tr('来源有新版本。请核对当前录音中“第一轮设计”的阶段。','The source has a new revision. Confirm the stage meant by “first design round” in the current recording.'),messages:[]};delete replacement.replacement;q.replacement=replacement.id;questions32().push(replacement);const w=works32().find(x=>x.id===q.work);if(w){w.owner='ask/clarifications/'+replacement.id;w.cause='question';w.status='attention';w.stage=tr('等待新版背景说明','Waiting for clarification of the new revision');w.branches.forEach(b=>{b.status='waiting';b.result=false;});}return finish32(key,tr('旧问题已失效；原草稿仍保留，但不能提交到旧版本。','The old question is stale. Its draft remains but cannot be submitted to that revision.'),true);
      }
      if(action==='question-reopen'){if(q.state!=='closed')return true;q.state='open';q.revision++;d.revision=q.revision;const work=works32().find(x=>x.id===q.work);if(work){work.status='attention';work.cause='question';work.stage=tr('等待新的补充','Waiting for new clarification');work.owner='ask/clarifications/'+q.id;work.branches.forEach(b=>{b.status='waiting';b.result=false;});}return finish32(key,tr('已重新打开，可补充新的信息。之前的原文和记录保留。','Reopened for new information. Previous evidence and records remain.'));}
      if(!['open','deferred'].includes(q.state)||d.revision!==q.revision)return finish32(key,tr('问题状态或版本已变化，未接受旧回答。草稿保留。','The question state or revision changed. The old answer was not accepted and the draft remains.'),true);
      if(action==='question-answer'){
        if(!d.text.trim())return finish32(key,tr('请输入回答，或选择一条已提供的回答。','Enter an answer or choose one of the authored responses.'),true);
        if(d.text.length>6000)return finish32(key,tr('回答最多 6000 个字符；请缩短后再提交。','An answer can contain up to 6,000 characters. Shorten it before submitting.'),true);
        if(q.failNext){q.failNext=false;return finish32(key,tr('模拟提交失败。回答草稿与所选原文保留，可重试相同回答。','Simulated submission failure. The answer and original evidence remain; retry the same answer.'),true);}
        q.messages.push({text:d.text,choice:d.choice||null,time:stamp(),revision:q.revision});q.state='answered';q.revision++;d.revision=q.revision;d.text='';d.choice='';state.clarificationResolved=true;state.clarificationAnswer=q.messages.at(-1).text;const w=works32().find(x=>x.id===q.work);if(w){w.status='review';w.cause='';w.stage=tr('回答已记录，等待成果审核','Answer recorded; awaiting result review');w.branches.forEach(b=>{b.status='review';b.result=false;b.events.push(tr('收到限定范围的回答；尚未保存新的记忆。','Scope-limited answer received; no new memory has been saved.'));});}return finish32(key,tr('回答已记录，只继续这份资料的处理。记忆尚未发布。','Answer recorded for this material’s processing only. Memory is not yet published.'));
      }
      if(action==='question-defer'){q.state='deferred';q.revision++;d.revision=q.revision;return finish32(key,tr('已推迟这项问题；回答草稿保留，其他工作继续。','This question was deferred. The answer draft remains and unrelated work continues.'));}
      if(action==='question-end'){q.state='closed';q.revision++;d.revision=q.revision;const w=works32().find(x=>x.id===q.work);if(w){w.cause='';w.status='succeeded';w.stage=tr('保留不确定性后结束追问','Question ended with uncertainty retained');w.branches.forEach(b=>{b.status='succeeded';b.result=false;});}return finish32(key,tr('已结束这次追问。原件与不确定性保留；有新信息时可重新打开。','This question ended. Evidence and uncertainty remain; reopen it when you have new information.'));}
      return true;
    }
    if(action.startsWith('work-')||action==='technical-page'||action.startsWith('trace-')){
      const d=draft32('work-list',{filter:'all',source:'',material:'',page:0}),w=relatedWorks().find(x=>x.id===id),branch=w?.branches.find(x=>x.id===el.dataset.branch);
      if(action==='work-refresh'){c.workLoadError=false;c.workConnectionInterrupted=false;return finish32('work-list',tr('已刷新模拟工作状态。进度连接与任务执行分别记录。','Simulated work state refreshed. Progress connectivity and task execution are recorded separately.'));}
      if(action==='work-scope-clear'){d.source='';d.material='';d.page=0;return repaint32();}
      if(action==='work-page'){d.page=Math.max(0,Number(d.page)+Number(el.dataset.offset));return repaint32();}
      if(action==='work-interrupt'){c.workConnectionInterrupted=true;persist();render();setTimeout(()=>{if(!c.workConnectionInterrupted)return;c.workConnectionInterrupted=false;finish32('work-list',tr('模拟进度连接已恢复；后台工作一直保留其原状态。','The simulated progress connection recovered; work retained its execution state throughout.'));},1600);return true;}
      if(action==='work-load-fail'){c.workLoadError=true;return repaint32();}
      if(action==='work-owner'){if(w){if(w.cause==='model')c.returnWork=w.id;persist();go(w.owner);}return true;}
      if(action==='work-cause-reload'){
        if(!w)return true;
        if(w.cause==='model'&&c.assignments?.memory){w.cause='';w.status='queued';w.stage=tr('记忆模型已就绪，等待执行','Memory model ready; queued');w.branches.forEach(b=>{b.status='queued';b.next=tr('等待执行名额','Waiting for capacity');b.events.push('Memory module now references '+c.assignments.memory);});return finish32('work-'+w.id,tr('所需记忆模型已配置；原工作保留并进入队列。正文、索引与记忆仍各自计算。','The memory model is configured and this original work is queued. Body, index and memory retain separate states.'));}
        if(w.cause==='source'&&state.taskRetried){w.cause='';w.status='succeeded';w.stage=tr('授权恢复已确认','Authorization recovery confirmed');return finish32('work-'+w.id,tr('授权恢复已确认，原工作已更新。','Authorization recovery confirmed and the original work updated.'));}
        return finish32('work-'+w.id,tr('已重新读取现有执行记录。原因仍未解决，未把未知状态标为成功。','Existing execution records reloaded. The cause is unresolved; unknown state was not marked successful.'),true);
      }
      if(action==='work-branch'){if(w){c.selectedBranch||={};c.selectedBranch[w.id]=el.dataset.branch;}return repaint32();}
      if(action==='work-branches-page'){if(w){c.branchPage||={};c.branchPage[w.id]=Math.max(0,Number(c.branchPage[w.id]||0)+Number(el.dataset.offset));}return repaint32();}
      if(action==='work-operation'){if(w&&branch){c.operation={work:w.id,branch:branch.id};persist();go('activity/technical');}return true;}
      if(action==='technical-page'){const f=draft32('technical',{status:'all',kind:'all',page:0});f.page=Math.max(0,Number(f.page)+Number(el.dataset.offset));return repaint32();}
      if(action==='work-step-cancel'){if(!w||!branch||!['queued','running','waiting'].includes(branch.status))return true;branch.status='cancelled';branch.events.push(tr('已取消当前技术步骤；之前保存的产品保留。','Current technical step cancelled; saved products remain.'));branch.next=tr('已取消','Cancelled');return finish32('operation',tr('这一步已取消，已保存产品保留。','This step was cancelled; saved products remain.'));}
      if(action==='work-step-retry'){
        if(!w||!branch||!['index','context'].includes(branch.kind)||!['failed','cancelled'].includes(branch.status))return finish32('operation',tr('此操作当前不支持重试。','This operation is not eligible for retry.'),true);
        if(w.cause)return finish32('operation',tr('相关依赖仍未解决，请先处理所属工作的原因。','A dependency remains unresolved; resolve the owning work’s cause first.'),true);
        branch.attempts++;branch.status='queued';branch.next=tr('现在已具备执行条件','Eligible to run now');branch.events.push(tr('已重试同一索引 / 上下文步骤；原件与已完成产品保留。','The same index / context step was retried; original and completed products remain.'));return finish32('operation',tr('这一步已重新排队；并未重复外部调用。','This eligible step is queued again; no external call was duplicated.'));
      }
      if(action==='work-trace'){
        if(!w||!branch?.evidence.length)return true;const trace={id:'trace-'+w.id+'-'+branch.id,at:stamp(),model:'demo-text (synthetic fixture)',events:[{kind:'context',text:'Synthetic initial task: '+w.title},{kind:'model',text:'Fixture model selection: demo-text; no live request.'},...branch.evidence.map(e=>({kind:'tool read',text:'Recorded fixture read: '+e.id+'\n'+e.text}))]};c.traces||=[];if(!c.traces.some(x=>x.id===trace.id))c.traces.push(trace);c.traceRun=trace.id;c.drafts.trace={run:trace.id,requested:'',page:0};persist();go('settings/agent-events');return true;
      }
      if(action==='trace-open'){const f=draft32('trace',{run:'',page:0});if(f.requested?.trim())f.run=f.requested.trim();f.page=0;return repaint32();}
      if(action==='trace-page'){const f=draft32('trace',{run:'',page:0});f.page=Math.max(0,Number(f.page)+Number(el.dataset.offset));return repaint32();}
      return true;
    }
    if(action==='invite-reopen'){const i=c.invites?.find(x=>x.id===id);if(i){c.selectedInvite=i.id;c.drafts.invite={url:i.url,name:i.name,device:i.device};persist();go('setup/device');}return true;}
    if(action==='invite-refresh'){return finish32('invite',tr('邀请列表与到期状态已刷新。关闭详情不会取消邀请。','Invitation status and expiry refreshed. Closing a detail does not cancel the invitation.'));}
    if(action==='invite-expire-demo'){const i=c.invites?.find(x=>x.id===id);if(i)i.expires=Date.now()-1;return finish32('invite',tr('已模拟到期；旧邀请不能确认，可以明确重新生成。','Expiry was simulated. The old invitation cannot be confirmed; explicitly regenerate it.'));}
    if(action==='invite-qr-download'){const i=c.invites?.find(x=>x.id===c.selectedInvite);if(!i)return true;download32('mote-invitation-demo-'+i.id+'.svg',demoQR32(),'image/svg+xml');return finish32('invite',tr('已保存示例二维码图像。图像编码的是 DEMO 标记，不是设备配对凭据。','Demo QR image saved. It encodes a DEMO marker, not a device-pairing credential.'));}
    return priorAction32?priorAction32(action,el):false;
  };
  const previousDetail32=settingsDetail;
  settingsDetail=function(id){if(id==='file-processing')return policyPage();if(id==='access')return grantPage(true);if(id==='plugins')return pluginPage();if(id==='agent-events')return tracePage32();return previousDetail32(id);};
  accessPage=function(embedded=false){return grantPage(embedded);};
  const previousAsk32=askPage;
  askPage=function(){return state.page.startsWith('ask/clarifications')?questionPage():previousAsk32();};
  const previousActivity32=activityPage;
  activityPage=function(){if(state.page==='activity')return workPage();if(state.page==='activity/technical')return technicalPage();if(state.page==='activity/details')return workDetailPage('source-recovery');if(state.page==='activity/clarification')return workDetailPage('recording-memory');if(state.page.startsWith('activity/work/'))return workDetailPage(state.page.split('/')[2]);return previousActivity32();};
  function setPath32(target,path,value){const keys=path.split('.');let object=target;for(let i=0;i<keys.length-1;i++){object[keys[i]]||={};object=object[keys[i]];}object[keys.at(-1)]=value;}
  function capture32(el){
    if(!el.dataset.csForm)return false;const name=el.dataset.csForm,key=el.dataset.csPath,d=draft32(name,{});setPath32(d,key,el.type==='checkbox'?el.checked:el.value);
    if(name.startsWith('question-')&&key==='text')d.choice='';
    if(name==='policy'){processing().preview=null;processing().match=null;const marker=document.getElementById('cs32-policy-dirty');if(marker)marker.textContent=tr('有未保存修改','Unsaved changes');document.querySelectorAll('[data-action="cs-policy-match"],[data-action="cs-policy-preview"],[data-action="cs-policy-confirm"],[data-action="cs-policy-service-test"]').forEach(button=>button.disabled=true);}
    if(name==='policy-trial'){processing().preview=null;processing().match=null;}
    if(name==='work-list'&&key!=='page')d.page=0;
    if(name==='technical'&&key!=='page')d.page=0;
    if(name==='memory-preparation')plugins32().planPreview=null;
    if(name==='grant'&&key==='access'&&d.access==='write')central().openDisclosures=['cs32-grant-sources'];
    persist();return true;
  }
  document.addEventListener('input',e=>capture32(e.target));
  document.addEventListener('change',e=>{const el=e.target;if(!capture32(el))return;const name=el.dataset.csForm,key=el.dataset.csPath;
    if(name==='policy'&&key.endsWith('.processor')){const profile=policyDraft().profiles[Number(key.split('.')[1])];profile.parameters={};profile.service='';profile.analysis='';profile.summary=false;}
    if((el.tagName==='SELECT'||el.type==='checkbox')&&(['policy','policy-trial','grant','work-list','technical','trace'].includes(name)||name==='plugin-instance'&&key==='package'))repaint32();
  });
  const previousEnhance32=window.enhanceCentralSemantics;
  window.enhanceCentralSemantics=function(){
    if(previousEnhance32)previousEnhance32();const c=central();if(c.returnWork&&state.page==='activity/work/'+c.returnWork){c.returnWork='';persist();}
    if(!['access','settings/access'].includes(state.page))grantSecret=null;
    if(c.returnWork&&state.page.startsWith('settings/')&&!document.getElementById('cs32-return-work')){const target=document.querySelector('.settings-content');if(target)target.insertAdjacentHTML('afterbegin','<div id="cs32-return-work">'+note(tr('正在恢复原工作。配置完成后返回同一项工作，重新核对阻塞原因。','Recovering the original work. Return after configuration and reload its cause.')+link(tr('返回原工作','Return to original work'),'activity/work/'+c.returnWork))+'</div>');}
    if(state.page==='setup/device'){
      const main=document.querySelector('main .cs-task'),i=c.invites?.find(x=>x.id===c.selectedInvite);
      if(main&&!document.getElementById('cs32-invitation-list'))main.insertAdjacentHTML('beforeend',disclose('invitation-list',tr('已发出的邀请','Issued invitations'),(c.invites||[]).map(v=>row32(content(v.name),tr(v.cancelled?'已取消':v.acknowledged?'已确认':Date.now()>=v.expires?'已过期':'等待确认',v.cancelled?'Cancelled':v.acknowledged?'Acknowledged':Date.now()>=v.expires?'Expired':'Awaiting confirmation')+' · '+content(new Date(v.expires).toISOString()),button32(tr('重新打开并管理','Reopen and manage'),'invite-reopen','subtle','data-id="'+v.id+'"'))).join('')+button32(tr('刷新到期状态','Refresh expiry state'),'invite-refresh','text'),true));
      if(main&&i&&!document.getElementById('cs32-invite-qr'))main.insertAdjacentHTML('beforeend',disclose('invite-qr',tr('示例二维码图像与到期预览','Demo QR image and expiry preview'),'<p>'+tr('本图像仅编码 DEMO 标记，不能配对设备。邀请数据通过上方 JSON 交付演示。','This image encodes only a DEMO marker and cannot pair a device. Invitation data delivery is demonstrated with the JSON above.')+'</p>'+demoQR32()+'<div class="actions">'+button32(tr('保存示例二维码图像','Save demo QR image'),'invite-qr-download','subtle')+button32(tr('模拟这份邀请到期','Simulate this invitation expiring'),'invite-expire-demo','text','data-id="'+i.id+'"')+'</div>'));
    }
  };
  function demoQR32(){const rows=["11111110111100011111001111111", "10000010011101101101101000001", "10111010100110111010101011101", "10111010011100100001001011101", "10111010001101110110101011101", "10000010101100010110101000001", "11111110101010101010101111111", "00000000010010111000100000000", "10100011010111100001000100101", "01110100100101100101011111010", "00000111101000010111000001100", "00010100101101000101001001111", "10001010010011011011010000100", "11001100110010001101010110100", "00110111111011101111100101001", "10110100000000111000000010101", "01011011111011100110101100110", "00001101001111100101111000101", "11010011001010010000001101001", "00010000010101000101010001011", "11100111010101011100111110100", "00000000110110001001100011011", "11111110100001101111101010010", "10000010001110111010100011001", "10111010010011100111111110011", "10111010001010100110000111110", "10111010100000110000010111011", "10000010001000100100010101101", "11111110100011011101010000111"];const modules=rows.flatMap((row,y)=>[...row].map((bit,x)=>bit==='1'?'<rect x="'+(33+x*6)+'" y="'+(65+y*6)+'" width="6" height="6"/>':'')).join('');return '<svg xmlns="http://www.w3.org/2000/svg" class="cs-demo-qr" viewBox="0 0 240 310" role="img" aria-label="QR encodes MOTE-UI-DEMO-NOT-A-PAIRING-CREDENTIAL"><rect width="240" height="310" fill="white"/><text x="120" y="26" text-anchor="middle" fill="#111" font-size="18">DEMO QR</text><g fill="#111">'+modules+'</g><text x="120" y="282" text-anchor="middle" fill="#111" font-size="10">NOT A PAIRING CREDENTIAL</text><text x="120" y="299" text-anchor="middle" fill="#111" font-size="10">Payload: MOTE-UI-DEMO marker</text></svg>'; }
})();

/* R33: account storage, portable operations, and retained diagnostics. Synthetic fixtures only. */
(function(){
  'use strict';
  const T=(zh,en)=>state.language==='en'?en:zh,copy=value=>JSON.parse(JSON.stringify(value));
  const B=(label,action,kind='subtle',extra='')=>button(label,'cs-'+action,extra,kind);
  const L=(label,path,kind='text')=>goButton(label,path,kind);
  const U=value=>'<span data-user-content>'+esc(value??'')+'</span>';
  const N=(text,kind='')=>'<div class="notice '+kind+'" role="status"><div>'+text+'</div></div>';
  const F=body=>'<div class="fields cs-fields">'+body+'</div>';
  const bind=(name,key)=>' data-cs33-form="'+esc(name)+'" data-cs33-key="'+esc(key)+'"';
  const input=(name,key,label,value='',type='text',extra='')=>'<label class="field"><span>'+label+'</span><input id="cs33-'+esc(name+'-'+key)+'-input" class="field-input"'+bind(name,key)+' type="'+type+'" value="'+esc(value??'')+'" '+extra+'></label>';
  const select=(name,key,label,value,rows)=>'<label class="field"><span>'+label+'</span><select id="cs33-'+esc(name+'-'+key)+'" class="field-input"'+bind(name,key)+'>'+rows.map(([id,zh,en])=>'<option value="'+esc(id)+'" '+(String(id)===String(value)?'selected':'')+'>'+esc(T(zh,en||zh))+'</option>').join('')+'</select></label>';
  const check=(name,key,label,value,extra='')=>'<label class="checkrow"><input id="cs33-'+esc(name+'-'+key)+'" type="checkbox"'+bind(name,key)+' '+(value?'checked':'')+' '+extra+'><span>'+label+'</span></label>';
  const details=(id,label,body,open=false)=>'<details id="cs33-'+esc(id)+'" class="cs-disclosure" '+(open?'open':'')+'><summary>'+label+'</summary><div class="cs-disclosure-body">'+body+'</div></details>';
  const facts=rows=>'<dl class="cs-dl">'+rows.map(([key,value])=>'<div><dt>'+key+'</dt><dd>'+value+'</dd></div>').join('')+'</dl>';
  const row=(title,description,action='')=>'<div class="cs-row"><div><strong>'+title+'</strong><small>'+description+'</small></div><div class="actions">'+action+'</div></div>';
  const stamp=()=>new Date().toISOString(),uid=()=>crypto.randomUUID();
  function C(){state.cs||={};state.cs.drafts||={};state.cs.messages||={};state.cs.admin??=state.accountName==='林同学';return state.cs;}
  function draft(name,initial){return C().drafts[name]||(C().drafts[name]=copy(initial));}
  function message(name){const m=C().messages[name];return m?N(esc(m.text),m.error?'warn':'good'):'';}
  function remember(){state.focus||={};state.focus.details||={};document.querySelectorAll('main details[id^="cs"]').forEach(d=>{state.focus.details[state.page+'|'+d.id]=d.open;});}
  function redraw(){remember();persist();render();return true;}
  function result(name,text,error=false){C().messages[name]={text,error};return redraw();}
  function download(name,value,type='application/json'){const url=URL.createObjectURL(new Blob([value],{type})),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  async function digest(text){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))].map(n=>n.toString(16).padStart(2,'0')).join('');}
  function identity(){return {deploymentId:'demo-deployment:'+new URL(state.accountServiceUrl||'https://mote.example.invalid').origin,userId:'demo-account:'+state.accountName};}
  function scope(){const x=identity();return facts([[T('当前账号','Current account'),U(state.accountName)],[T('原部署标识','Original deployment'),U(x.deploymentId)],[T('账号标识','Account identity'),U(x.userId)]]);}
  function scopeMatches(value){const x=identity();return value?.deploymentId===x.deploymentId&&value?.userId===x.userId;}
  function storage(){const c=C();c.storage33||={revision:1,enabled:!!state.maintenance?.encrypt,objects:state.dataState==='empty'?[]:[{id:'demo-image',title:'fixture-image.png',encrypted:true},{id:'demo-original',title:'fixture-original.md',encrypted:true},{id:'demo-part',title:'fixture-upload-part',encrypted:false},{id:'demo-audio',title:'fixture-audio.wav',encrypted:true,unreadable:true}],job:null,pending:null,history:[],retention:{revision:1,saved:{days:0,capacity:10240},effective:{days:0,capacity:10240},status:'applied'},statisticsChecked:stamp()};return c.storage33;}
  function archives(){const c=C();c.archives33||={export:null,receipts:[],selected:'',page:0,retryTarget:'',selection:null};return c.archives33;}
  function diagnostics(){const c=C();c.diagnostics33||={revision:1,saved:{enabled:state.maintenance?.logs!==false,level:'info',debug:!!state.maintenance?.debug},effective:null,trace:{revision:1,enabled:!!state.maintenance?.detailed},checked:stamp()};c.diagnostics33.effective||=copy(c.diagnostics33.saved);return c.diagnostics33;}
  function indexState(){const c=C();c.index33||={job:null,pending:null};return c.index33;}
  const stageLabel=value=>({waiting:T('等待执行','Waiting'),running:T('进行中','Running'),working:T('正在合并','Merging'),completed:T('已完成','Completed'),cancelled:T('已取消','Cancelled'),failed:T('失败，可恢复','Failed; recoverable'),blocked:T('等待处理','Blocked'),skipped:T('不在本次范围','Outside this scope'),pending:T('尚未处理','Pending'),verified:T('已核验','Verified'),preparing:T('正在准备','Preparing'),ready:T('等待下载','Ready to download')}[value]||value);
  const routes33={
    'storage-content':['内容存储','Content storage','后续写入加密与已有文件转换','Future-write encryption and existing-file conversion','storage'],
    'storage-retention':['保留与容量','Retention and capacity','管理员实例政策，分别核对保存与生效值','Administrator instance policy with saved and effective values','storage'],
    'portable-export':['导出账号资料','Export account material','核对范围、校验结果，再下载归档','Review scope and validate before downloading','storage'],
    'portable-import':['导入便携归档','Import a portable archive','合并原部署和原账号的规范资料','Merge normative material from the original deployment and account','storage'],
    'index-maintenance':['检索索引维护','Search-index maintenance','管理员维护实例索引，保留原始资料','Administrator instance-index maintenance preserves originals','storage'],
    'diagnostic-preferences':['诊断偏好','Diagnostic preferences','运行日志与个人输入追踪分别保存','Save runtime logging and account input tracing separately','diagnostics']
  };
  Object.entries(routes33).forEach(([id,v])=>configurationDefs[id]={title:v[0],desc:v[2],parent:v[4]});
  const catalogCorrections33={C01:{title:'登录并管理当前会话',purpose:'使用用户名和密码登录，管理会话时长、密码和当前账号。',path:'设置 → 账号与设备',route:'settings/account',actions:['使用用户名和密码登录','验证后回到原目的地','选择浏览器会话、1 天、7 天或 30 天','修改密码并重新登录','退出当前会话']},A30:{title:'管理检索与外部连接的保存设置',purpose:'保存检索模型与来源连接设置，分别核对已保存值和当前生效值。',path:'设置 → 模型与服务 → 检索与外部连接',route:'settings/advanced',actions:['设置向量模型与服务地址','保存来源同步间隔','配置 MCP 读写与来源范围','设置 OAuth 回调地址','保存设置并查看逐项生效状态','恢复保存值或刷新实际生效值']}};
  for(const [id,patch] of Object.entries(catalogCorrections33)){const item=DIRECTORY.find(x=>x.id===id);if(item)Object.assign(item,patch);const unit=CATALOG.directory?.find(x=>x.id===id);if(unit){unit.title=patch.title;unit.description=patch.purpose;unit.destination={page:'settings',view:patch.route.split('/')[1],href:'#/'+patch.route};unit.keywords=[patch.title,patch.path];}}
  configurationDefs.advanced.title='检索与外部连接';configurationDefs.advanced.desc='保存设置，分别核对已保存与当前生效值';
  const previousFeature33=featurePage;
  featurePage=function(){const id=state.page.split('/')[1],v=catalogCorrections33[id];if(!v)return previousFeature33();return heading(T(v.title,id==='C01'?'Sign in and manage the current session':'Manage saved retrieval and connection settings'),T(v.purpose,id==='C01'?'Sign in with a username and password; manage session duration, password, and the current account.':'Save retrieval and connection settings, then inspect saved and currently effective values.'),L(T('返回全部功能','Back to all features'),'guide'))+'<article class="cs-task"><p>'+T('进入对应页面使用实际输入、保存与恢复控件。','Open the task page to use its input, save, and recovery controls.')+'</p>'+L(T('进入相关页面','Open task page'),v.route,'primary')+'</article>';};
  function retainedFixtures33(){const c=C();if(c.traceFixtures33)return;c.traceFixtures33=true;c.traces||=[];if(state.dataState==='empty')return;for(const id of ['trace-memory-study-body','trace-memory-study-memory','trace-file-complete-published']){if(c.traces.some(x=>x.id===id))continue;c.traces.push({id,at:'2026-10-20T09:25:00Z',model:'demo-text (pre-recorded synthetic fixture)',events:[{kind:'context',text:'Pre-recorded synthetic task: inspect retained research material. No live model request was made.'},{kind:'model',text:'Pre-recorded synthetic model selection: demo-text.'},{kind:'tool read',text:'Pre-recorded fixture read: m2\n调研笔记记录了原始资料、记忆与洞察之间的关系。'}]});}}
  function storageHome(){const s=storage();return '<article class="cs-task">'+N(T('这里管理当前账号在 Central 保存的资料。本机队列的位置、容量和清理由对应采集端管理。','Manage this account’s archived material in Central. Queue location, capacity, and cleanup belong to the relevant collector.'))+row(T('当前账号的存储','This account’s storage'),T('原件、上传分片与个人配置的范围统计','Scoped totals for originals, upload parts, and account configuration'),L(T('查看运行状态与空间','Inspect storage use'),'settings/system'))+'<section class="cs-zone"><h3>'+T('资料与归档','Material and archives')+'</h3>'+row(T('内容存储','Content storage'),T(s.enabled?'后续图片与原件加密；已有格式保持不变':'后续图片与原件明文；已有格式保持不变',s.enabled?'Future images and originals are encrypted; existing formats remain':'Future images and originals are plaintext; existing formats remain'),L(T('打开','Open'),'settings/storage-content'))+row(T('导出本账号资料','Export this account’s material'),T('规范资料或按类型选择的可用文件；不含凭据与执行授权','Normative material or selected available files; excludes credentials and execution grants'),L(T('选择导出范围','Choose export scope'),'settings/portable-export'))+row(T('导入便携归档','Import a portable archive'),T('仅原部署、原账号的 portable3；支持同一操作恢复','Same-deployment, same-account portable3 with operation recovery'),L(T('选择归档','Choose an archive'),'settings/portable-import'))+'</section>'+details('instance-storage',T('管理员：实例保留与维护','Administrator: instance retention and maintenance'),C().admin?row(T('保留与容量','Retention and capacity'),T('正数保留周期会按采集时间清理旧记录','Positive retention periods clean old records by capture time'),L(T('核对政策','Review policy'),'settings/storage-retention'))+row(T('共享全文索引','Shared full-text index'),T('重建索引，不重建或改写原始资料','Rebuild the index without recreating or rewriting originals'),L(T('打开维护','Open maintenance'),'settings/index-maintenance')):N(T('当前为普通账号。实例政策由管理员管理，个人资料仍可导入与导出。','This is a regular account. Administrators manage instance policy; personal import and export remain available.')))+details('offline-backup',T('完整实例备份','Full-instance backup'),'<p>'+T('网页导出只覆盖当前账号的规范资料。完整实例备份与恢复需要中央节点停机，并在部署机器执行命令。此原型没有运行备份或恢复。','Web export covers this account’s normative material. Full-instance backup and restore require stopping Central and running commands on its deployment machine. This prototype does not run backup or restore.')+'</p><code>npm run backup -- --help</code>')+'</article>';}
  function decryptReceipt(s){const j=s.job;if(!j)return '<p>'+T('尚无批量转换操作。','No batch conversion has been started.')+'</p>';const n=j.counts;return '<section class="cs-zone" data-cs33-decrypt="'+j.operationId+'"><h3>'+T('解密操作回执','Decryption receipt')+'</h3>'+facts([[T('操作编号','Operation ID'),U(j.operationId)],[T('状态 / 尝试','State / attempts'),stageLabel(j.state)+' / '+j.attempts],[T('已检查 / 总量','Checked / total'),n.checked+' / '+j.total],[T('已转换 / 无需转换 / 失败','Converted / unchanged / failed'),n.converted+' / '+n.unchanged+' / '+n.failed]])+'<progress aria-label="'+T('批量解密进度','Batch decryption progress')+'" max="'+Math.max(1,j.total)+'" value="'+n.checked+'"></progress>'+(j.failures.length?details('decrypt-failures',T('失败项与保留的原件','Failed items and retained originals'),j.failures.map(x=>row(U(x.title),T('读取失败；加密原件仍保留。检查原密钥与存储空间。','Read failed; the encrypted original remains. Check the original key and storage space.'))).join(''),true):'')+'<div class="actions">'+(['running','blocked'].includes(j.state)?B(T('取消解密','Cancel decryption'),'storage-decrypt-cancel'):'')+(['failed','blocked'].includes(j.state)?B(T('重试原操作','Retry the original operation'),'storage-decrypt-retry','primary'):'')+L(T('在活动中查看','View in Activity'),'activity/work/'+j.operationId)+'</div></section>';}
  function contentPage(){const s=storage(),d=draft('storage-encryption',{revision:s.revision,enabled:s.enabled}),busy=!!s.pending||['running','blocked'].includes(s.job?.state);return '<article class="cs-task">'+N(T('仅当前账号的后续图片、原件和上传分片。已有明文或加密文件保持原格式并可继续读取；SQLite 正文与索引不因此全部加密。','Applies to this account’s future images, originals, and upload parts. Existing plaintext and encrypted files retain their formats and readability; SQLite bodies and indexes are not all encrypted by this setting.'))+message('storage-encryption')+F(check('storage-encryption','enabled',T('加密后续保存的图片和原件','Encrypt future images and originals'),d.enabled,busy?'disabled':'')+'<div class="form-actions">'+B(T('保存后续写入策略','Save future-write policy'),'storage-encryption-save','primary',busy?'disabled':'')+B(T('重新读取已保存值','Reload saved policy'),'storage-encryption-reload','text')+'</div>')+facts([[T('当前生效','Currently effective'),T(s.enabled?'后续写入加密':'后续写入明文',s.enabled?'Encrypt future writes':'Plaintext future writes')],[T('保存版本','Saved revision'),s.revision],[T('已有文件格式','Existing formats'),s.objects.filter(x=>x.encrypted).length+T(' 个示例加密对象；其余保持明文',' synthetic encrypted objects; the rest remain plaintext')]])+details('decrypt',T('一次性批量解密已有文件','One-time decryption of existing files'),'<p>'+T('先关闭并保存后续加密。任务逐项处理图片、原件和上传分片，连接凭据不参与转换。离开页面不会取消已准入任务。','Disable and save future encryption first. The job converts images, originals, and upload parts item by item; connection credentials are excluded. Leaving does not cancel admitted work.')+'</p>'+message('decrypt')+(s.pending?N(T('提交结果待确认。重试使用原操作编号，不新建任务。','Submission outcome is unconfirmed. Retrying uses the original operation ID without creating another job.')+'<div class="actions">'+B(T('重试原操作','Retry the original operation'),'storage-decrypt-retry','primary')+B(T('移除本机待确认提交','Remove this browser’s pending submission'),'storage-decrypt-forget','text')+'</div><p>'+T('移除本机记录不取消已准入的 Central 任务；仍可从下方回执或活动打开。','Removing this local record does not cancel an admitted Central job; its receipt and Activity entry remain available.')+'</p>','warn'):'')+'<div class="actions">'+B(T('开始一次性批量解密','Start one-time batch decryption'),'storage-decrypt-start','primary',s.enabled||busy?'disabled':'')+'</div>'+decryptReceipt(s)+'<p>'+T('取消后保留已完成的转换；再次运行会跳过已转换对象。失败对象保留原文件。','Cancellation retains completed conversions; another run skips converted objects. Failed objects retain their originals.')+'</p>'+details('decrypt-fixtures',T('原型：推进与恢复合成操作','Prototype: advance and recover a synthetic operation'),'<div class="actions">'+B(T('推进一个示例对象','Process one fixture object'),'storage-decrypt-step','text',s.job?.state==='running'?'':'disabled')+B(T('模拟修复原密钥与空间','Simulate recovered key and space'),'storage-decrypt-recover','text')+B(T('下次提交模拟回执丢失','Lose the next submission receipt'),'storage-decrypt-unknown','text')+'</div><p>'+T('这里只改变示例回执，不读取或改写真实文件。','Only fixture receipts change; no real file is read or rewritten.')+'</p>'),true)+'</article>';}
  function retentionPage(){const r=storage().retention,d=draft('retention',{revision:r.revision,...r.saved});return '<article class="cs-task">'+N(T('这是整个 Central 实例的保留与容量政策。正数保留天数会按采集时间清理旧记录；0 表示持续保留。','This policy covers retention and capacity for the Central instance. Positive retention days clean older records by capture time; 0 means continuous retention.'))+message('retention')+(C().admin?F(select('retention','days',T('历史记录保留','Record retention'),d.days,[['0','持续保留','Keep continuously'],['30','30 天','30 days'],['90','90 天','90 days'],['180','180 天','180 days'],['365','1 年','1 year'],...(!['0','30','90','180','365'].includes(String(d.days))?[[String(d.days),'当前自定义值 · '+d.days,'Current custom value · '+d.days]]:[])])+select('retention','capacity',T('资料容量上限','Storage capacity limit'),d.capacity,[['1024','1 GiB','1 GiB'],['5120','5 GiB','5 GiB'],['10240','10 GiB','10 GiB'],['51200','50 GiB','50 GiB'],['102400','100 GiB','100 GiB'],...(!['1024','5120','10240','51200','102400'].includes(String(d.capacity))?[[String(d.capacity),d.capacity+' MiB',d.capacity+' MiB']]:[])])+details('retention-custom',T('自定义保留与容量','Custom retention and capacity'),input('retention','days',T('自定义保留天数','Custom retention days'),d.days,'number','min="0" max="36500" step="1"')+input('retention','capacity',T('自定义容量（MiB）','Custom capacity (MiB)'),d.capacity,'number','min="1" max="1000000" step="any"'))+'<div class="form-actions">'+B(T('保存并应用','Save and apply'),'retention-save','primary')+B(T('还原草稿','Restore draft'),'retention-reload','text')+'</div>'):N(T('此账号不能修改实例政策。请由管理员核对保存与生效状态。','This account cannot change instance policy. An administrator can inspect saved and effective status.')))+facts([[T('已保存保留 / 容量','Saved retention / capacity'),r.saved.days+' '+T('天','days')+' / '+r.saved.capacity+' MiB'],[T('当前生效保留 / 容量','Effective retention / capacity'),r.effective.days+' '+T('天','days')+' / '+r.effective.capacity+' MiB'],[T('状态','Status'),T(r.status==='restart-required'?'已保存，需部署重启后生效':'已应用',r.status==='restart-required'?'Saved; deployment restart required':'Applied')],[T('版本','Revision'),r.revision]])+'<p>'+T('需要重启时保持当前生效值。刷新只读取回执；这里没有执行部署重启的按钮。原型不会清理任何资料。','Current effective values remain while a restart is required. Refresh only reads the receipt; this page does not execute a deployment restart. The prototype does not delete material.')+'</p>'+B(T('刷新实际生效值','Refresh effective values'),'retention-refresh','text')+'</article>';}
  function exportMaterial(m,withData){const value={id:m.id,title:m.title,type:m.type,sourceId:m.sourceId||'',time:m.time||m.date||'',provenance:m.original||m.path||''};if(withData)value.body=String(m.body||'');return value;}
  function portablePayload(){const id=identity();return {format:'mote-portable',version:3,...id,prototype:'mote-ui-demo',createdAt:stamp(),scope:'account',materials:state.materials.map(m=>copy(m)),sources:state.sources.map(s=>({id:s.id,title:s.title||s.name,description:state.sourceConfigs?.[s.id]?.contextDescription||''})),exclusions:['credentials','execution-grants','instance-backup'],attachments:[]};}
  function mime(m){return {audio:'audio/wav',image:'image/png',text:'text/plain',file:/\.pdf$/i.test(m.title)?'application/pdf':'text/plain',note:'text/plain',screen:'image/png'}[m.type]||'text/plain';}
  function matchMime(pattern,value){return pattern==='*/*'||pattern===value||pattern.endsWith('/*')&&value.startsWith(pattern.slice(0,-1));}
  function exportPage(){const a=archives(),d=draft('archive-export',{type:'*/*',selection:'current',mode:'metadata'}),j=a.export;return '<article class="cs-task">'+N(T('只导出当前账号获授权且仍保留的资料。凭据、执行授权和完整实例备份不在范围内。下载的是明确标注的原型 JSON 归档，不会读取真实媒体文件。','Export only this account’s authorized retained material. Credentials, execution grants, and full-instance backup are excluded. Downloads are explicitly marked prototype JSON archives; no real media file is read.'))+scope()+message('archive-export')+'<section class="cs-zone"><h3>'+T('规范资料归档','Normative material archive')+'</h3><p>'+T('为同一部署和账号准备 portable3 示例归档；包含现有资料正文与来源说明。','Prepare a portable3 fixture for this deployment and account, including retained bodies and source descriptions.')+'</p>'+B(T('准备账号资料归档','Prepare account archive'),'archive-export-portable','primary',j?.state==='preparing'?'disabled':'')+'</section>'+details('file-export',T('按文件类型导出','Export by file type'),F(select('archive-export','type',T('文件类型','File type'),d.type,[['*/*','所有类型','All types'],['text/*','文本','Text'],['image/*','图片','Images'],['audio/*','音频','Audio'],['video/*','视频','Video'],['application/pdf','PDF','PDF'],['application/json','JSON','JSON']])+select('archive-export','selection',T('版本范围','Version scope'),d.selection,[['current','当前版本','Current versions'],['history','包含仍保留且获授权的历史','Include authorized retained history']])+select('archive-export','mode',T('导出内容','Export content'),d.mode,[['metadata','仅元数据，不读取正文或文件字节','Metadata only; no body or file bytes'],['data','可用正文与附件','Available bodies and attachments']]))+'<p>'+T('示例中的媒体字节不可用，会列为缺失，不能计入已导出附件。历史范围不恢复已删除或失去授权的版本。','Fixture media bytes are unavailable and are listed as missing, not exported attachments. Historical scope does not restore deleted or unauthorized versions.')+'</p>'+B(T('准备所选文件导出','Prepare selected-file export'),'archive-export-files','subtle',j?.state==='preparing'?'disabled':''))+(j?'<section class="cs-zone" data-cs33-export="'+j.id+'"><h3>'+T('本次导出回执','Export receipt')+'</h3>'+facts([[T('操作编号','Operation ID'),U(j.id)],[T('状态','State'),stageLabel(j.state)],[T('资料 / 缺失附件','Materials / missing attachments'),j.count+' / '+j.missing],[T('范围','Scope'),U(j.scope)],[T('校验','Validation'),j.digest?U('SHA-256 '+j.digest):T('尚未校验','Not validated')]])+'<div class="actions">'+(j.state==='preparing'?B(T('校验准备的归档','Validate the prepared archive'),'archive-export-validate','primary')+B(T('取消导出','Cancel export'),'archive-export-cancel','text'):'')+(j.state==='ready'?B(T('下载已校验的示例归档','Download validated fixture archive'),'archive-export-download','primary'):'')+(j.state==='failed'?B(T('重新准备同一导出','Prepare this export again'),'archive-export-retry','primary'):'')+'</div></section>':'')+details('export-fixture',T('原型：校验失败','Prototype: validation failure'),B(T('下一次校验模拟失败','Fail the next validation'),'archive-export-fail','text'))+'</article>';}
  let portableFile=null;
  function portableReceipt(r){return '<section class="cs-zone" data-cs33-portable="'+r.id+'"><h3>'+T('导入操作回执','Import receipt')+'</h3>'+facts([[T('原操作编号','Original operation ID'),U(r.id)],[T('当前阶段','Current stage'),U(r.phase)],[T('状态 / 尝试','State / attempts'),(r.unknown?T('提交回执待确认','Submission receipt unconfirmed'):stageLabel(r.state))+' / '+r.attempts],[T('原归档','Original archive'),U(r.filename)],[T('文件指纹','File fingerprint'),U(r.fingerprint)],[T('已合并 / 已有，跳过','Merged / already present, skipped'),r.merged+' / '+r.duplicates]])+details('portable-domains-'+r.id,T('覆盖范围与处理状态','Domains and processing states'),r.domains.map(d=>row(U(d.name),stageLabel(d.state))).join(''))+(r.error?N(esc(r.error),'warn'):'')+'<div class="actions">'+(r.state==='working'?B(T('取消导入','Cancel import'),'portable-cancel','text','data-id="'+r.id+'"'):'')+(['failed','cancelled'].includes(r.state)||r.unknown?B(T('使用原文件重试原操作','Retry original operation with original file'),'portable-retry','primary','data-id="'+r.id+'"'):'')+B(T('刷新回执','Refresh receipt'),'portable-refresh','subtle','data-id="'+r.id+'"')+L(T('打开活动回执','Open Activity receipt'),'activity/work/'+r.id)+'</div><p>'+T('重试需使用同一归档和原操作。刷新页面后需要重新选择原文件；已合并资料保留，已完成阶段不会重复合并。','Retry requires the same archive and operation. After refresh, reselect the original file; merged material remains and completed stages are not merged again.')+'</p>'+details('portable-fixtures-'+r.id,T('原型：导入阶段与恢复','Prototype: import stages and recovery'),B(T('推进一个合成阶段','Advance one synthetic stage'),'portable-step','text','data-id="'+r.id+'" '+(r.state==='working'&&!r.unknown?'':'disabled'))+B(T('模拟当前阶段失败','Fail the current stage'),'portable-fail','text','data-id="'+r.id+'" '+(r.state==='working'?'':'disabled'))+B(T('模拟提交回执中断','Interrupt the submission receipt'),'portable-unknown','text','data-id="'+r.id+'" '+(r.state==='working'?'':'disabled')))+'<p class="small">'+T('回执为合成状态；未调用真实导入服务。','Receipt states are synthetic; no live import service was called.')+'</p></section>';}
  function importPage33(){const a=archives(),routeId=state.page.split('/')[2];if(a.lastRoute!==state.page){a.lastRoute=state.page;if(a.receipts.some(x=>x.id===routeId))a.selected=routeId;}const r=a.receipts.find(x=>x.id===a.selected),selection=a.selection,offset=a.page*3;return '<article class="cs-task">'+N(T('仅合并原部署、原账号的 Mote portable3。当前设置、凭据与执行授权保持不变；其他账号或部署的归档会被拒绝。','Merge only Mote portable3 from the original deployment and account. Current settings, credentials, and execution grants remain unchanged; other origins and accounts are rejected.'))+scope()+message('portable')+'<section class="cs-zone"><label class="field"><span>'+T(a.retryTarget?'重新选择原操作的归档':'选择 Mote portable3 JSON 归档',a.retryTarget?'Reselect the original operation’s archive':'Select a Mote portable3 JSON archive')+'</span><input id="cs33-portable-file" type="file" accept="application/json,.json"></label>'+(selection?facts([[T('已选择','Selected'),U(selection.name)],[T('资料数量','Material count'),selection.count],[T('文件指纹','File fingerprint'),U(selection.fingerprint)]])+B(T(a.retryTarget?'继续原操作':'导入所选归档',a.retryTarget?'Continue original operation':'Import selected archive'),'portable-start','primary',portableFile?'':'disabled'):'')+(!portableFile&&selection?'<p>'+T('文件选择不跨浏览器刷新保留，请重新选择同一文件。','The selected file does not survive browser refresh; reselect the same file.')+'</p>':'')+'<div class="actions">'+B(T('下载同账号示例文件','Download a same-account fixture'),'portable-fixture','text')+L(T('先导出当前账号资料','Export this account first'),'settings/portable-export')+'</div></section>'+(r?portableReceipt(r):'')+details('portable-history',T('导入回执历史','Import receipt history'),a.receipts.slice(offset,offset+3).map(x=>row(U(x.filename),stageLabel(x.state)+' · '+U(x.createdAt),B(T('打开回执','Open receipt'),'portable-open','subtle','data-id="'+x.id+'"'))).join('')+'<div class="actions">'+B(T('上一页','Previous page'),'portable-page','text','data-offset="-1" '+(a.page?'':'disabled'))+'<span>'+T('第 ','Page ')+(a.page+1)+' / '+Math.max(1,Math.ceil(a.receipts.length/3))+'</span>'+B(T('下一页','Next page'),'portable-page','text','data-offset="1" '+(offset+3<a.receipts.length?'':'disabled'))+'</div>',a.receipts.length>1)+'</article>';}
  function indexPage(){const x=indexState(),j=x.job;return '<article class="cs-task">'+N(T('只重建共享全文索引。提交前与发布结果前重新核对管理员权限；此页不提供其他账号的正文。原件和已发布正文保持原样。','Rebuild only the shared full-text index. Administrator authority is rechecked before admission and result publication; other accounts’ bodies are not exposed. Originals and published bodies remain unchanged.'))+message('index')+(!C().admin?N(T('当前账号没有实例索引维护权限。','This account cannot maintain the instance index.'),'warn'):'<div class="actions">'+B(T(x.pending||['failed','blocked'].includes(j?.state)?'重试原操作':'重建全文索引',x.pending||['failed','blocked'].includes(j?.state)?'Retry original operation':'Rebuild full-text index'),'index-start','primary',!x.pending&&j&&['waiting','running'].includes(j.state)?'disabled':'')+(j&&['waiting','running','blocked'].includes(j.state)?B(T('取消索引重建','Cancel index rebuild'),'index-cancel','text'):'')+'</div>')+(x.pending?N(T('提交结果待确认；重试保留原操作编号，不重复排队。','Submission is unconfirmed; retry retains the original operation ID and does not queue a duplicate.')+'<div class="actions">'+B(T('移除本机待确认提交','Remove this browser’s pending submission'),'index-forget','text')+'</div><p>'+T('移除本机提交不会取消已经准入的中央任务。','Removing the local submission does not cancel an admitted Central job.')+'</p>','warn'):'')+(j?facts([[T('操作编号','Operation ID'),U(j.operationId)],[T('状态','State'),stageLabel(j.state)],[T('尝试次数','Attempts'),j.attempts],[T('内容授权核验','Content authorization recheck'),T(j.reauthorized===false?'核验未通过，尚未发布结果':j.state==='completed'?'发布前核验通过':'发布前还需重新核验',j.reauthorized===false?'Failed; no result published':j.state==='completed'?'Rechecked before publication':'Recheck required before publication')]])+L(T('在活动中查看','View in Activity'),'activity/work/'+j.operationId):'')+(C().admin?details('index-fixtures',T('原型：索引恢复状态','Prototype: index recovery states'),B(T('推进合成索引阶段','Advance synthetic index stage'),'index-step','text',j&&['waiting','running'].includes(j.state)?'':'disabled')+B(T('下次提交模拟回执丢失','Lose the next submission receipt'),'index-unknown','text')+B(T('模拟发布前授权失效','Simulate authorization loss before publication'),'index-authorization','text',j&&['waiting','running'].includes(j.state)?'':'disabled')+B(T('模拟重新核验通过','Simulate restored authorization'),'index-authorize','text',j?.state==='blocked'?'':'disabled')):'')+'</article>';}
  function statsRows(){if(state.dataState==='empty')return [];return [{type:'original',label:T('原始文件','Original files'),date:'2026-10-22',bytes:10485760,files:2},{type:'image',label:T('图片','Images'),date:'2026-10-20',bytes:2621440,files:12},{type:'original',label:T('原始文件','Original files'),date:'2026-10-02',bytes:3145728,files:4},{type:'json',label:T('个人配置与上传分片','Account configuration and upload parts'),date:'2026-09-15',bytes:524288,files:6}];}
  function statTable(rows){return '<table class="cs-table"><thead><tr><th>'+T('分组','Group')+'</th><th>'+T('文件数','Files')+'</th><th>'+T('字节','Bytes')+'</th></tr></thead><tbody>'+rows.map(x=>'<tr><th>'+U(x.label)+'</th><td>'+x.files+'</td><td>'+x.bytes.toLocaleString()+'</td></tr>').join('')+'</tbody></table>';}
  function statisticsPage(){const s=storage(),d=draft('storage-statistics',{days:'7'}),rows=statsRows(),cutoff=new Date(Date.now()-Number(d.days)*86400000).toISOString().slice(0,10),selected=rows.filter(x=>d.days==='0'||x.date>=cutoff),grouped=key=>{const map=new Map();for(const x of selected){const id=x[key];if(!map.has(id))map.set(id,{label:key==='date'?id:x.label,bytes:0,files:0});const r=map.get(id);r.bytes+=x.bytes;r.files+=x.files;}return [...map.values()];};return '<article class="cs-task">'+N(T('统计仅覆盖本账号的原件、上传分片、个人配置和受管服务目录。共享数据库与索引、模型、其他账号及外部服务卷不计入。','Totals cover this account’s originals, upload parts, configuration, and managed-service directories. Shared databases and indexes, models, other accounts, and external service volumes are excluded.'))+message('storage-statistics')+F(select('storage-statistics','days',T('最后修改日期范围（UTC）','Last-modified range (UTC)'),d.days,[['7','过去 7 天','Past 7 days'],['30','过去 30 天','Past 30 days'],['0','全部时间','All time']]))+facts([[T('当前范围字节 / 文件数','Selected-range bytes / files'),selected.reduce((n,x)=>n+x.bytes,0).toLocaleString()+' / '+selected.reduce((n,x)=>n+x.files,0)],[T('全范围已知字节 / 文件数','All-range known bytes / files'),rows.reduce((n,x)=>n+x.bytes,0).toLocaleString()+' / '+rows.reduce((n,x)=>n+x.files,0)],[T('最近读取','Last read'),U(s.statisticsChecked)]])+(rows.length?N(T('有 1 个示例文件无法读取；已知总量不包含它，统计不完整。','One fixture file is unreadable and excluded from known totals; the report is partial.'),'warn'):'<p>'+T('当前账号没有可统计的文件。','This account has no files to count.')+'</p>')+'<p>'+T('按最后修改日期（UTC）归组，日期分布不是每天新增的文件或净增长字节。以上均为合成容量。','Grouped by last-modified date in UTC. The distribution is not daily additions or net byte growth. All capacities are synthetic.')+'</p>'+details('statistics-types',T('按文件类型','By file type'),statTable(grouped('type')),true)+details('statistics-dates',T('按最后修改日期','By last-modified date'),statTable(grouped('date')))+'<div class="actions">'+B(T('刷新统计','Refresh statistics'),'storage-statistics-refresh')+L(T('用量与费用','Usage and cost'),'settings/usage')+L(T('存储与备份','Storage and backup'),'settings/storage')+'</div></article>';}
  const logStages=[['all','全部阶段','All stages'],['system','系统','System'],['request','请求','Request'],['ingest','入库','Ingest'],['index','索引','Index'],['agent','Agent','Agent'],['source','资料','Source'],['maintenance','维护','Maintenance'],['file','文件','File'],['unknown','未知','Unknown']];
  function logFixtures(){const base=Date.parse('2026-10-22T02:00:00Z');return Array.from({length:126},(_,i)=>({seq:i+1,at:new Date(base+i*10*60000).toISOString(),stage:logStages[1+i%9][0],event:['queue.received','operation.checked','operation.finished'][i%3],count:1+i%4,durationMs:12+i%7,file:i<36?'1':'0'}));}
  function logView(){const d=draft('diagnostic-log',{file:'0',stage:'all',page:1,size:'50',hours:'24',wrap:true,auto:false}),rows=logFixtures().filter(x=>x.file===d.file&&(d.stage==='all'||x.stage===d.stage)),pages=Math.max(1,Math.ceil(rows.length/Number(d.size))),page=Math.min(Math.max(1,Number(d.page)),pages);d.page=page;const end=rows.length-(page-1)*Number(d.size),shown=rows.slice(Math.max(0,end-Number(d.size)),end);return {d,rows,pages,shown,raw:shown.map(({file,...item})=>JSON.stringify(item)).join('\n')+(shown.length?'\n':'')};}
  function diagnosticPage(){const s=diagnostics(),v=logView(),d=v.d;return '<article class="cs-task">'+N(T('这里只显示实例运行的安全元数据：固定事件、数量与耗时。私人正文、详细 Agent 轨迹、端点队列和共享索引统计不在覆盖范围内。','This view contains safe instance metadata: fixed events, counts, and timings. Private bodies, detailed Agent traces, endpoint queues, and shared-index statistics are outside its scope.'))+'<div class="actions">'+B(T('刷新诊断','Refresh diagnostics'),'diagnostic-refresh')+L(T('诊断偏好','Diagnostic preferences'),'settings/diagnostic-preferences')+L(T('帮助与版本','Help and versions'),'settings/help')+'</div>'+message('diagnostic')+facts([[T('环境 / 范围','Environment / scope'),'demo · instance-safe-diagnostics'],[T('当前运行日志','Runtime logging'),s.effective.enabled?s.effective.level:T('已关闭，历史仍可查看','Off; retained history remains readable')],[T('保留事件 / 最早记录','Retained events / oldest event'),'126 / 2026-10-22T02:00:00Z'],[T('最后刷新','Last refreshed'),U(s.checked)]])+details('diagnostic-logs',T('日志中心','Log center'),'<p>'+T('从所选文件的最新一页开始，页内保留原始行序。刷新不会跳回第一页。按阶段筛选不拆字段或重排事件。','Start with the selected file’s newest page while preserving raw row order within it. Refresh retains the page. Stage filtering does not split fields or reorder events.')+'</p>'+F(select('diagnostic-log','file',T('日志文件','Log file'),d.file,[['0','central.0.ndjson · 当前','central.0.ndjson · current'],['1','central.1.ndjson · 保留历史','central.1.ndjson · retained history'],['2','central.2.ndjson · 已轮转清理','central.2.ndjson · rotated away']])+select('diagnostic-log','stage',T('日志阶段','Log stage'),d.stage,logStages)+select('diagnostic-log','size',T('每页条数','Rows per page'),d.size,[['50','50','50'],['100','100','100'],['200','200','200'],['500','500','500']])+check('diagnostic-log','wrap',T('自动换行','Wrap lines'),d.wrap)+check('diagnostic-log','auto',T('自动刷新（5 秒）','Auto-refresh (5 seconds)'),d.auto))+'<div class="actions">'+B(T('最新一页','Newest page'),'diagnostic-page','text','data-page="1" '+(d.page===1?'disabled':''))+B(T('较新','Newer'),'diagnostic-page','text','data-page="'+(d.page-1)+'" '+(d.page===1?'disabled':''))+'<span>'+T('第 ','Page ')+d.page+' / '+v.pages+' · '+v.rows.length+' '+T('条','rows')+'</span>'+B(T('较旧','Older'),'diagnostic-page','text','data-page="'+(d.page+1)+'" '+(d.page>=v.pages?'disabled':''))+'</div>'+(d.file==='2'?N(T('这个历史文件已被轮转清理，没有可恢复的日志。选择其他保留文件继续。','This historical file was rotated away and cannot be recovered. Choose a retained file.'),'warn'):'')+'<label class="field"><span>'+T('原始日志（合成事件）','Raw log (synthetic events)')+'</span><textarea class="cs33-log" id="cs33-raw-log" readonly spellcheck="false" wrap="'+(d.wrap?'soft':'off')+'">'+esc(v.raw)+'</textarea></label><div class="actions">'+B(T('复制当前页','Copy current page'),'diagnostic-copy','subtle',v.raw?'':'disabled')+B(T('全选当前页','Select current page'),'diagnostic-select','text',v.raw?'':'disabled')+'</div>'+message('diagnostic-copy'),true)+details('diagnostic-export',T('导出诊断包','Export diagnostic bundle'),F(select('diagnostic-log','hours',T('导出时间范围','Export time range'),d.hours,[['1','最近 1 小时','Last hour'],['24','最近 24 小时','Last 24 hours'],['168','最近 7 天','Last 7 days']]))+'<p>'+T('导出所选时段内全部已保留日志。轮转前清理的部分无法恢复，下载文件会注明请求范围和实际覆盖。采集、电量及本机队列诊断应从对应 App 导出。','Exports retained logs within the requested period. Rotated-away logs cannot be recovered; the file records requested and actual coverage. Collection, battery, and local-queue diagnostics are exported by their own app.')+'</p>'+B(T('导出合成诊断包','Export synthetic diagnostic bundle'),'diagnostic-export','primary')+message('diagnostic-export')+(s.lastExport?facts([[T('请求范围','Requested range'),U(s.lastExport.after)+' → '+U(s.lastExport.before)],[T('实际覆盖','Retained coverage'),U(s.lastExport.actualAfter||T('无保留事件','No retained events'))+' → '+U(s.lastExport.actualBefore||'—')],[T('日志数 / 完整性','Event count / completeness'),s.lastExport.count+' / '+T(s.lastExport.partial?'部分覆盖，未恢复清理内容':'请求范围内保留记录已导出',s.lastExport.partial?'Partial; cleared content was not recovered':'Retained events in the requested range exported')]]):''))+'</article>';}
  function preferencesPage(){const s=diagnostics(),d=draft('diagnostic-preferences',{revision:s.revision,...s.saved}),trace=draft('trace-preferences',{revision:s.trace.revision,enabled:s.trace.enabled});return '<article class="cs-task"><section class="cs-zone"><h3>'+T('实例运行诊断','Instance runtime diagnostics')+'</h3><p>'+T('管理员保存后立即生效，重启后保留。','Administrator changes apply immediately and persist across restarts.')+'</p>'+message('diagnostic-preferences')+(C().admin?F(check('diagnostic-preferences','enabled',T('记录运行诊断','Record runtime diagnostics'),d.enabled)+select('diagnostic-preferences','level',T('日志详细程度','Log verbosity'),d.level,['silent','error','warn','info','debug'].map(x=>[x,x,x]))+check('diagnostic-preferences','debug',T('启用调试模式','Enable debug mode'),d.debug)+'<div class="form-actions">'+B(T('保存运行诊断设置','Save runtime logging'),'diagnostic-preferences-save','primary')+B(T('重新读取并还原草稿','Reload and restore draft'),'diagnostic-preferences-reload','text')+'</div>'):N(T('当前账号不能修改实例运行日志；仍可管理本账号的输入追踪。','This account cannot change instance runtime logs, but can manage its own input tracing.')))+facts([[T('已保存 / 当前生效','Saved / currently effective'),U(JSON.stringify(s.saved))+'<br>'+U(JSON.stringify(s.effective))],[T('版本','Revision'),s.revision]])+'</section><section class="cs-zone"><h3>'+T('本账号的详细 Agent 输入','Detailed Agent input for this account')+'</h3><p>'+T('可能包含问题、私人正文、上下文、模型输出与工具返回。关闭立即停止新增详细记录；已保留记录仍按原到期规则管理，不会因此删除或补造历史。','May contain questions, private bodies, context, model output, and tool results. Disabling stops new detailed capture immediately; retained records keep their expiry rules and are neither deleted nor reconstructed.')+'</p>'+message('trace-preferences')+F(check('trace-preferences','enabled',T('记录本账号的 Agent 输入与读取','Record this account’s Agent input and reads'),trace.enabled)+'<div class="form-actions">'+B(T('保存个人输入追踪','Save account input tracing'),'trace-preferences-save','primary')+B(T('还原已保存值','Restore saved value'),'trace-preferences-reload','text')+'</div>')+facts([[T('当前生效','Currently effective'),T(s.trace.enabled?'记录之后发生的输入与工具返回':'停止新增详细输入记录',s.trace.enabled?'Capture future input and tool results':'Do not capture new detailed inputs')],[T('保存版本','Saved revision'),s.trace.revision]])+L(T('查看已保留轨迹','Inspect retained traces'),'settings/agent-events')+'</section>'+details('diagnostic-effective',T('部署与生效配置','Deployment and effective configuration'),'<p>'+T('以下为安全配置快照，不包含路径、凭据、其他账号资料或私人日志。没有在此执行重启或修改部署文件。','This is a safe configuration snapshot without host paths, credentials, other accounts, or private logs. No restart or deployment-file modification occurs here.')+'</p>'+facts([[T('环境','Environment'),'demo'],[T('运行日志保存 / 生效','Runtime logging saved / effective'),U(s.saved.level)+' / '+U(s.effective.level)],[T('本账号详细输入','Account detailed input'),String(s.trace.enabled)],[T('生效方式','Application'),T('诊断与追踪：保存后立即生效','Diagnostics and tracing: immediate after save')]])+L(T('其他部署保存与生效值','Other saved and effective deployment values'),'settings/advanced'))+'</article>';}
  function operationWork(id,title,stateValue,owner,stage,progress=0){const c=C();c.maintenanceWorks33||=[];const next={id,title,status:stateValue==='completed'?'succeeded':stateValue==='working'?'running':['failed','blocked'].includes(stateValue)?'attention':stateValue,source:'',material:'',stage,progress,cause:'',owner,branches:[]},old=c.maintenanceWorks33.find(x=>x.id===id);if(old)Object.assign(old,next);else c.maintenanceWorks33.push(next);if(c.works){const w=c.works.find(x=>x.id===id);if(w)Object.assign(w,copy(next));else c.works.unshift(copy(next));}}
  function syncDecryptWork(){const j=storage().job;if(j)operationWork(j.operationId,T('已有文件批量解密','Decrypt existing files'),j.state,'settings/storage-content',T('合成转换回执：','Synthetic conversion receipt: ')+j.counts.checked+' / '+j.total,j.total?Math.round(j.counts.checked/j.total*100):100);}
  function syncPortableWork(r){operationWork(r.id,T('合并便携归档：','Merge portable archive: ')+r.filename,r.state,'settings/portable-import/'+r.id,r.phase,Math.round(r.domains.filter(x=>x.state==='completed'||x.state==='skipped').length/r.domains.length*100));}
  function syncIndexWork(){const j=indexState().job;if(j)operationWork(j.operationId,T('重建共享全文索引','Rebuild shared full-text index'),j.state,'settings/index-maintenance',T('管理员实例维护；原件保留','Administrator instance maintenance; originals retained'),j.state==='completed'?100:j.state==='running'?50:0);}
  function startDecrypt(){const s=storage();if(s.enabled)return result('decrypt',T('请先关闭并保存后续加密。','Disable and save future encryption first.'),true);if(s.pending)return retryDecrypt();if(s.job&&['running','blocked'].includes(s.job.state))return result('decrypt',T('已有未结束的转换操作，请查看原回执。','A conversion operation is already active; inspect its receipt.'),true);if(s.job)s.history.push(copy(s.job));const id=uid();s.job={operationId:id,id:'decrypt-'+id,state:s.objects.length?'running':'completed',attempts:1,total:s.objects.length,cursor:0,counts:{checked:0,converted:0,unchanged:0,failed:0},failures:[],processed:[],createdAt:stamp()};if(s.loseReceipt){s.pending=id;s.loseReceipt=false;}syncDecryptWork();return result('decrypt',T(s.pending?'合成提交回执中断；操作编号已保留，结果待确认。':'合成解密操作已准入；尚未把未检查对象标为完成。',s.pending?'Synthetic receipt interrupted; operation identity retained and outcome unconfirmed.':'Synthetic decryption admitted; unchecked objects are not marked complete.'),!!s.pending);}
  function retryDecrypt(){const s=storage(),j=s.job;if(!j)return result('decrypt',T('找不到原操作，请重新读取。','Original operation unavailable; reload first.'),true);if(s.pending&&s.pending!==j.operationId)return result('decrypt',T('回执与原操作不一致，未创建新任务。','Receipt does not match the original operation; no new job created.'),true);s.pending=null;j.attempts++;if(['failed','blocked'].includes(j.state)){const failedIds=new Set(j.failures.map(x=>x.id));j.processed=j.processed.filter(id=>!failedIds.has(id));j.counts.checked-=j.counts.failed;j.counts.failed=0;j.failures=[];j.state='running';}syncDecryptWork();return result('decrypt',T('已核对并继续原操作：','Original operation verified and continued: ')+j.operationId);}
  function decryptStep(){const s=storage(),j=s.job;if(!j||j.state!=='running'||s.pending)return result('decrypt',T('先核对提交回执，再继续当前操作。','Verify the submission receipt before continuing.'),true);const o=s.objects.find(x=>!j.processed.includes(x.id));if(o){j.processed.push(o.id);j.counts.checked++;if(o.unreadable){j.counts.failed++;j.failures.push({id:o.id,title:o.title});}else if(o.encrypted){o.encrypted=false;j.counts.converted++;}else j.counts.unchanged++;}if(j.counts.checked===j.total)j.state=j.counts.failed?'failed':'completed';syncDecryptWork();return result('decrypt',T(j.state==='failed'?'部分对象失败，原文件保留。':'合成回执已更新，已完成转换保留。',j.state==='failed'?'Some objects failed; original files remain.':'Synthetic receipt updated; completed conversions remain.'),j.state==='failed');}
  async function prepareExport(mode){const a=archives(),d=draft('archive-export',{type:'*/*',selection:'current',mode:'metadata'}),id=uid(),portable=mode==='portable',materials=state.materials.filter(m=>matchMime(d.type,mime(m))),missing=portable?0:materials.filter(m=>['audio','image','screen'].includes(m.type)).length,payload=portable?portablePayload():{format:'mote-ui-files-fixture',version:1,...identity(),scope:'account',mode:d.mode,selection:d.selection,type:d.type,materials:materials.map(m=>exportMaterial(m,d.mode==='data')),availableAttachments:[],missingAttachments:materials.filter(m=>['audio','image','screen'].includes(m.type)).map(m=>({materialId:m.id,reason:'Synthetic fixture: original media bytes unavailable'})),exclusions:['credentials','execution-grants','instance-backup']};const text=JSON.stringify(payload,null,2);a.export={id,state:'preparing',createdAt:stamp(),payload:text,expectedDigest:await digest(text),digest:'',count:portable?state.materials.length:materials.length,missing,scope:portable?'account · mote-portable3':d.mode+' · '+d.type+' · '+d.selection,filename:portable?'mote-portable3-demo.json':'mote-files-'+d.mode+'-demo.json',owner:identity()};return result('archive-export',T('导出范围已固定。校验内容长度与摘要后才提供下载；准备中可取消。','Export scope fixed. Download is available only after length and digest validation; preparation can be cancelled.'));}
  function selectedReceipt(){const a=archives();return a.receipts.find(x=>x.id===a.selected);}
  async function choosePortable(file){if(!file)return;const a=archives(),fixed=identity();try{const text=await file.text(),value=JSON.parse(text);if(!scopeMatches(fixed))return;if(value?.format!=='mote-portable'||value.version!==3||!scopeMatches(value))throw Error(T('请选择原部署、原账号的 Mote portable3 归档。旧 v2 或其他账号归档不能导入。','Select Mote portable3 from the original deployment and account. Old v2 and other-account archives cannot be imported.'));if(!Array.isArray(value.materials)||value.materials.some(m=>!m||typeof m.id!=='string'||typeof m.title!=='string'||typeof m.body!=='string'))throw Error(T('归档资料结构无效，未修改已保存资料。','Invalid archive material structure; saved material was not changed.'));const fingerprint=await digest(text);if(!scopeMatches(fixed))return;const target=a.receipts.find(x=>x.id===a.retryTarget);if(target&&target.fingerprint!==fingerprint)throw Error(T('这不是原操作使用的同一归档。请选择指纹一致的原文件；原操作保持不变。','This is not the same archive used by the original operation. Select the original fingerprint; the operation remains unchanged.'));portableFile={archive:value,fingerprint,filename:file.name,owner:fixed};a.selection={name:file.name,count:value.materials.length,fingerprint};return result('portable',T(a.retryTarget?'原归档已重新选择；继续时使用同一操作编号。':'归档身份与结构已核对；下一步明确导入所选归档。',a.retryTarget?'Original archive reselected; continuing uses the same operation ID.':'Archive identity and structure verified; explicitly import the selected archive next.'));}catch(error){portableFile=null;a.selection=null;return result('portable',error.message,true);}}
  function portableStart(){const a=archives(),f=portableFile;if(!f||!scopeMatches(f.owner))return result('portable',T('请先选择同账号的原归档。','First select the original same-account archive.'),true);let r=a.receipts.find(x=>x.id===a.retryTarget);if(r){if(f.fingerprint!==r.fingerprint)return result('portable',T('文件指纹不同，不能恢复原操作。','Fingerprint differs; the original operation cannot resume.'),true);r.attempts++;r.state='working';r.unknown=false;r.error='';r.domains.forEach(x=>{if(x.state==='failed')x.state='pending';});r.phase=T('继续未完成阶段','Continue unfinished stages');}else{r={id:uid(),...identity(),filename:f.filename,fingerprint:f.fingerprint,createdAt:stamp(),attempts:1,state:'working',phase:T('核验范围，等待合并','Scope verified; waiting to merge'),unknown:false,merged:0,duplicates:0,error:'',domains:[{name:'sources',state:'pending'},{name:'materials',state:'pending'},{name:'attachments',state:'skipped'}],submitted:copy(f.archive)};a.receipts.unshift(r);}a.selected=r.id;a.retryTarget='';syncPortableWork(r);return result('portable',T('合成导入使用操作编号：','Synthetic import uses operation ID: ')+r.id);}
  function portableStep(r){if(!r||r.state!=='working'||r.unknown)return result('portable',T('先核对原操作回执，当前阶段不可推进。','Verify the original receipt before advancing this stage.'),true);if(!scopeMatches(r))return result('portable',T('操作不属于当前部署和账号，未合并资料。','Operation belongs to another deployment or account; nothing merged.'),true);const domain=r.domains.find(x=>x.state==='pending');if(domain?.name==='sources'){for(const source of r.submitted.sources||[]){if(typeof source.id!=='string'||typeof source.title!=='string')continue;if(state.sources.some(x=>x.id===source.id)){r.duplicates++;continue;}state.sources.push({id:source.id,title:source.title,status:T('来自同账号归档','From same-account archive'),subtitle:T('一次性便携归档','One-time portable archive')});state.sourceConfigs||={};state.sourceConfigs[source.id]={contextDescription:String(source.description||'')};r.merged++;}domain.state='completed';}else if(domain?.name==='materials'){for(const value of r.submitted.materials){if(state.materials.some(x=>x.id===value.id)){r.duplicates++;continue;}state.materials.push({...copy(value),type:value.type||'text',sourceId:value.sourceId||'',body:String(value.body)});r.merged++;}domain.state='completed';}r.phase=domain?T('已完成阶段：','Completed stage: ')+domain.name:r.phase;if(r.domains.every(x=>['completed','skipped'].includes(x.state))){r.state='completed';r.phase=T('规范资料合并完成；设置与授权保持不变','Normative merge completed; settings and grants unchanged');}syncPortableWork(r);return result('portable',T('合成回执已保存；已完成阶段不会重复合并。','Synthetic receipt saved; completed domains will not be merged again.'));}
  const previousAction33=window.performCentralSemantics32;
  window.performCentralSemantics32=async function(action,el){
    remember();
    const id=el.dataset.id;
    if(action==='work-trace'){retainedFixtures33();const traceId='trace-'+id+'-'+el.dataset.branch;C().traceRun=traceId;C().drafts.trace={run:traceId,requested:'',page:0};persist();go('settings/agent-events');return true;}
    if(action==='storage-encryption-save'){const s=storage(),d=draft('storage-encryption',{revision:s.revision,enabled:s.enabled});if(s.pending||['running','blocked'].includes(s.job?.state))return result('storage-encryption',T('转换或待确认提交未结束，暂不能更改策略。','A conversion or unconfirmed submission is active; policy cannot change yet.'),true);if(d.revision!==s.revision)return result('storage-encryption',T('保存版本已变化；草稿保留，请重新读取后再编辑。','Saved revision changed; draft retained. Reload before editing.'),true);s.enabled=!!d.enabled;s.revision++;d.revision=s.revision;state.maintenance.encrypt=s.enabled;return result('storage-encryption',T('后续写入策略已保存并立即生效；没有转换已有文件。','Future-write policy saved and effective immediately; existing files were not converted.'));}
    if(action==='storage-encryption-reload'){const s=storage();C().drafts['storage-encryption']={revision:s.revision,enabled:s.enabled};return result('storage-encryption',T('已重新读取并还原草稿。','Saved policy reloaded and draft restored.'));}
    if(action==='storage-decrypt-start')return startDecrypt();
    if(action==='storage-decrypt-step')return decryptStep();
    if(action==='storage-decrypt-retry'){if(storage().enabled)return result('decrypt',T('先关闭并保存后续加密，再恢复转换。','Disable and save future encryption before resuming conversion.'),true);return retryDecrypt();}
    if(action==='storage-decrypt-cancel'){const s=storage();if(s.job&&['running','blocked'].includes(s.job.state)){s.job.state='cancelled';s.pending=null;syncDecryptWork();}return result('decrypt',T('剩余转换已取消；已转换对象保留明文，未完成和失败对象保留原件。','Remaining conversion cancelled; completed objects stay plaintext and unfinished or failed objects retain originals.'));}
    if(action==='storage-decrypt-forget'){storage().pending=null;return result('decrypt',T('仅移除了本浏览器待确认提交。Central 合成任务仍保留，可以从同一回执继续查看。','Only this browser’s pending submission was removed. The synthetic Central job remains accessible by the same receipt.'));}
    if(action==='storage-decrypt-unknown'){storage().loseReceipt=true;return result('decrypt',T('下一次合成提交将模拟回执丢失。','The next synthetic submission will lose its receipt.'));}
    if(action==='storage-decrypt-recover'){storage().objects.forEach(x=>x.unreadable=false);return result('decrypt',T('已模拟恢复原密钥与存储空间。失败原件仍保留，请明确重试原操作。','Original-key and space recovery simulated. Failed originals remain; explicitly retry the original operation.'));}
    if(action==='retention-save'){const r=storage().retention,d=draft('retention',{revision:r.revision,...r.saved});if(!C().admin)return result('retention',T('只有管理员可修改实例保留政策。','Only administrators can change instance retention.'),true);if(d.revision!==r.revision)return result('retention',T('保存版本冲突；草稿保留。请重新读取。','Revision conflict; draft retained. Reload the saved policy.'),true);const days=Number(d.days),capacity=Number(d.capacity);if(d.days===''||!Number.isInteger(days)||days<0||days>36500)return result('retention',T('保留天数需为 0–36500 的整数。','Retention days must be an integer from 0 to 36500.'),true);if(d.capacity===''||!Number.isFinite(capacity)||capacity<1||capacity>1000000||!Number.isSafeInteger(capacity*1048576))return result('retention',T('容量需为 1–1000000 MiB，并可表示为完整字节数。','Capacity must be 1–1000000 MiB and represent a whole number of bytes.'),true);r.saved={days,capacity};r.revision++;d.revision=r.revision;r.status=JSON.stringify(r.saved)===JSON.stringify(r.effective)?'applied':'restart-required';return result('retention',T(r.status==='restart-required'?'实例政策已保存；需部署重启后生效，当前生效值保持不变。':'保存值与当前生效值一致。',r.status==='restart-required'?'Instance policy saved; deployment restart required. Current effective values remain.':'Saved policy matches current effective values.'));}
    if(action==='retention-reload'){const r=storage().retention;C().drafts.retention={revision:r.revision,...copy(r.saved)};return result('retention',T('草稿已恢复为保存值。','Draft restored to the saved policy.'));}
    if(action==='retention-refresh')return result('retention',T('已读取当前生效值；没有执行部署重启或资料清理。','Effective values read; no deployment restart or data cleanup performed.'));
    if(action==='storage-statistics-refresh'){storage().statisticsChecked=stamp();return result('storage-statistics',T('合成统计已刷新；不可读文件仍计为覆盖缺口。','Synthetic statistics refreshed; unreadable files remain a coverage gap.'));}
    if(action==='archive-export-portable')return prepareExport('portable');
    if(action==='archive-export-files')return prepareExport('files');
    if(action==='archive-export-fail'){archives().failValidation=true;return result('archive-export',T('下一次归档校验将模拟失败。','The next archive validation will fail.'));}
    if(action==='archive-export-cancel'){const j=archives().export;if(j?.state==='preparing'){j.state='cancelled';j.payload='';j.digest='';}return result('archive-export',T('导出已取消，没有提供不完整的下载文件。原资料保留。','Export cancelled without providing an incomplete download. Original material remains.'));}
    if(action==='archive-export-retry'){const j=archives().export;if(j?.state==='failed'){j.state='preparing';j.digest='';}return result('archive-export',T('已重新准备同一导出回执，请再次校验。','The same export receipt is prepared again; validate it before download.'));}
    if(action==='archive-export-validate'){const a=archives(),j=a.export;if(!j||j.state!=='preparing')return true;if(!scopeMatches(j.owner)||a.failValidation||await digest(j.payload)!==j.expectedDigest){a.failValidation=false;j.state='failed';return result('archive-export',T('归档身份或摘要校验失败，未提供下载。可以重新准备同一导出。','Archive identity or digest validation failed; no download is available. Prepare the same export again.'),true);}j.digest=j.expectedDigest;j.bytes=new TextEncoder().encode(j.payload).length;j.state='ready';return result('archive-export',T('身份、内容长度与 SHA-256 已核对。可下载这份示例归档；缺失附件未计为成功。','Identity, content length, and SHA-256 verified. Download this fixture archive; missing attachments are not counted as exported.'));}
    if(action==='archive-export-download'){const j=archives().export;if(!j||j.state!=='ready'||!scopeMatches(j.owner))return result('archive-export',T('当前账号没有这份已校验归档的可用回执。','No valid receipt for this archive is available to the current account.'),true);download(j.filename,j.payload);return result('archive-export',T('已提供已校验的原型归档下载。','Validated prototype archive download provided.'));}
    if(action==='portable-fixture'){download('mote-portable3-demo.json',JSON.stringify(portablePayload(),null,2));return result('portable',T('已下载当前部署和账号的合成 portable3 文件，可用文件选择器核对导入。','Same-deployment, same-account synthetic portable3 downloaded; select it to inspect import.'));}
    if(action==='portable-start')return portableStart();
    if(action==='portable-open'){archives().selected=id;return redraw();}
    if(action==='portable-page'){const a=archives();a.page=Math.max(0,Math.min(Math.max(0,Math.ceil(a.receipts.length/3)-1),a.page+Number(el.dataset.offset)));return redraw();}
    if(['portable-step','portable-fail','portable-unknown','portable-retry','portable-cancel','portable-refresh'].includes(action)){const a=archives(),r=a.receipts.find(x=>x.id===id);if(!r||!scopeMatches(r))return result('portable',T('未找到属于当前账号的原操作。','No original operation belongs to the current account.'),true);a.selected=id;if(action==='portable-step')return portableStep(r);if(action==='portable-fail'&&r.state==='working'){const domain=r.domains.find(x=>x.state==='pending');if(domain)domain.state='failed';r.state='failed';r.error=T('合成阶段失败；已合并内容保留。使用原归档重试同一操作。','Synthetic stage failed; merged material remains. Retry the same operation with its original archive.');syncPortableWork(r);return result('portable',r.error,true);}if(action==='portable-unknown'&&r.state==='working'){r.unknown=true;return result('portable',T('提交回执已模拟中断；不能据此认定失败或新建操作。','Submission receipt interrupted; this does not prove failure or justify a new operation.'),true);}if(action==='portable-refresh'){r.unknown=false;return result('portable',T('已重新读取原操作回执；未创建其他导入。','Original operation receipt reread; no other import created.'));}if(action==='portable-cancel'&&r.state==='working'){r.state='cancelled';r.unknown=false;syncPortableWork(r);return result('portable',T('未完成阶段已取消；已合并资料和当前设置保留。','Unfinished stages cancelled; merged material and current settings remain.'));}if(action==='portable-retry'){a.retryTarget=r.id;if(portableFile?.fingerprint===r.fingerprint&&scopeMatches(portableFile.owner))return portableStart();portableFile=null;a.selection=null;result('portable',T('请选择原操作使用的同一归档。文件指纹匹配后才能恢复，操作编号不变。','Select the same archive used by the original operation. Matching its fingerprint resumes that operation ID.'));document.getElementById('cs33-portable-file')?.click();return true;}return true;}
    if(action.startsWith('index-')){const x=indexState(),j=x.job;if(!C().admin)return result('index',T('重新核对权限后拒绝操作；只有管理员可以维护实例索引。','Authority recheck rejected the action; only an administrator can maintain the instance index.'),true);if(action==='index-unknown'){x.loseReceipt=true;return result('index',T('下次合成提交会丢失回执，但保留原操作编号。','The next synthetic submission will lose its receipt while retaining the original operation ID.'));}if(action==='index-forget'){x.pending=null;return result('index',T('本浏览器待确认记录已移除；已准入索引任务未取消。','This browser’s pending record was removed; the admitted index job was not cancelled.'));}if(action==='index-start'){if(x.pending){if(!j||j.operationId!==x.pending)return result('index',T('原操作回执不匹配，未新建任务。','Original receipt mismatch; no new task created.'),true);x.pending=null;j.attempts++;}else if(j&&['failed','blocked'].includes(j.state)){j.attempts++;j.state='waiting';}else{if(j&&['waiting','running'].includes(j.state))return result('index',T('已有索引任务，请继续原回执。','An index job is active; continue its receipt.'),true);const operationId=uid();x.job={operationId,id:'index-'+operationId,state:'waiting',attempts:1,reauthorized:true,...identity()};if(x.loseReceipt){x.pending=operationId;x.loseReceipt=false;}}syncIndexWork();return result('index',T(x.pending?'合成提交回执待确认，请重试原操作。':'索引操作回执已保留；原始资料没有改变。',x.pending?'Synthetic submission is unconfirmed; retry its original operation.':'Index receipt retained; original material was not changed.'),!!x.pending);}if(action==='index-cancel'&&j&&['waiting','running','blocked'].includes(j.state)){j.state='cancelled';x.pending=null;syncIndexWork();return result('index',T('索引操作已取消；已保存的原件与正文仍可阅读。','Index operation cancelled; saved originals and bodies remain readable.'));}if(action==='index-authorization'&&j){j.reauthorized=false;return result('index',T('已模拟发布前权限失效；下一阶段将拒绝发布结果。','Authorization loss before publication simulated; the next stage will reject publication.'));}if(action==='index-authorize'&&j){j.reauthorized=true;return result('index',T('已模拟核验恢复，请重试同一索引操作。','Authorization recovery simulated; retry the same index operation.'));}if(action==='index-step'&&j&&!x.pending&&['waiting','running'].includes(j.state)){if(!scopeMatches(j)||j.reauthorized===false){j.state='blocked';syncIndexWork();return result('index',T('发布前授权重新核验未通过；没有发布索引结果，原件保留。','Authorization recheck failed before publication. No index result was published; originals remain.'),true);}j.state=j.state==='waiting'?'running':'completed';syncIndexWork();return result('index',T(j.state==='completed'?'合成索引已完成并通过发布前授权核验；没有重建原始资料。':'合成索引正在处理，结果尚未发布。',j.state==='completed'?'Synthetic index completed after authorization recheck; original material was not recreated.':'Synthetic index is processing; its result is not yet published.'));}return true;}
    if(action==='diagnostic-refresh'){diagnostics().checked=stamp();return result('diagnostic',T('已刷新保留的合成诊断。当前文件、阶段和页码保持不变。','Retained synthetic diagnostics refreshed. File, stage, and page selection are preserved.'));}
    if(action==='diagnostic-page'){draft('diagnostic-log',{}).page=Math.max(1,Number(el.dataset.page));return redraw();}
    if(action==='diagnostic-select'){const text=document.getElementById('cs33-raw-log');text?.focus();text?.select();return true;}
    if(action==='diagnostic-copy'){const raw=logView().raw;try{await navigator.clipboard.writeText(raw);return result('diagnostic-copy',T('已复制当前页原始日志，顺序保持不变。','Current raw log page copied in its original order.'));}catch{result('diagnostic-copy',T('剪贴板不可用，已全选当前页；请按 Ctrl / ⌘ + C 复制。','Clipboard unavailable; the page is selected. Press Ctrl / ⌘ + C to copy.'));const text=document.getElementById('cs33-raw-log');text?.focus();text?.select();return true;}}
    if(action==='diagnostic-export'){const s=diagnostics(),d=logView().d,before=stamp(),after=new Date(Date.now()-Number(d.hours)*3600000).toISOString(),all=logFixtures(),items=all.filter(x=>x.at>=after&&x.at<=before),coverage={after,before,actualAfter:items[0]?.at||null,actualBefore:items.at(-1)?.at||null,count:items.length,partial:after<all[0].at,reason:after<all[0].at?'Earlier requested logs were rotated away; they were not reconstructed.':'Only retained events within the requested range are included.'};s.lastExport=coverage;download('mote-safe-diagnostics-demo.json',JSON.stringify({format:'mote-ui-safe-diagnostics',prototype:true,scope:'instance-safe-diagnostics',coverage,includes:{instanceMetadata:true,privateContents:false,privateTraces:false,credentials:false,nativeQueues:false},runtime:{environment:'demo',uptimeMs:7200000,rssBytes:134217728},events:items.map(({file,...x})=>x)},null,2));return result('diagnostic-export',T(coverage.partial?'已下载部分覆盖的合成诊断包；轮转清理的较早日志未恢复。':'已下载所选范围内保留的合成诊断包。',coverage.partial?'Partial synthetic diagnostic bundle downloaded; earlier rotated logs were not recovered.':'Retained synthetic diagnostics within the selected range downloaded.'));}
    if(action==='diagnostic-preferences-save'){const s=diagnostics(),d=draft('diagnostic-preferences',{revision:s.revision,...s.saved});if(!C().admin)return result('diagnostic-preferences',T('只有管理员可以保存实例诊断偏好。','Only an administrator can save instance diagnostic preferences.'),true);if(d.revision!==s.revision)return result('diagnostic-preferences',T('保存版本已变化；草稿保留，请重新读取。','Saved revision changed; draft retained. Reload first.'),true);if(!['silent','error','warn','info','debug'].includes(d.level))return result('diagnostic-preferences',T('请选择受支持的日志级别。','Select a supported log level.'),true);s.saved={enabled:!!d.enabled,level:d.level,debug:!!d.debug};s.effective=copy(s.saved);s.revision++;d.revision=s.revision;return result('diagnostic-preferences',T('运行诊断偏好已保存并立即生效。已保留日志没有删除。','Runtime diagnostic preferences saved and applied immediately. Retained logs were not deleted.'));}
    if(action==='diagnostic-preferences-reload'){const s=diagnostics();C().drafts['diagnostic-preferences']={revision:s.revision,...copy(s.saved)};return result('diagnostic-preferences',T('已读取保存值并还原草稿。','Saved values reloaded and draft restored.'));}
    if(action==='trace-preferences-save'){const s=diagnostics(),d=draft('trace-preferences',{revision:s.trace.revision,enabled:s.trace.enabled});if(d.revision!==s.trace.revision)return result('trace-preferences',T('个人追踪版本已变化；草稿保留，请重新读取。','Account trace revision changed; draft retained. Reload first.'),true);s.trace.enabled=!!d.enabled;s.trace.revision++;d.revision=s.trace.revision;return result('trace-preferences',T(s.trace.enabled?'已开始记录之后发生的个人输入；没有补录旧运行。':'已停止新增个人输入记录；已保留轨迹没有删除。',s.trace.enabled?'Future account input capture enabled; historical runs were not backfilled.':'New account input capture disabled; retained traces were not deleted.'));}
    if(action==='trace-preferences-reload'){const s=diagnostics();C().drafts['trace-preferences']={revision:s.trace.revision,enabled:s.trace.enabled};return result('trace-preferences',T('已还原个人追踪保存值。','Saved account-trace preference restored.'));}
    return previousAction33?previousAction33(action,el):false;
  };
  const previousDetail33=settingsDetail;
  settingsDetail=function(id){if(id==='agent-events')retainedFixtures33();const pages={storage:storageHome,'storage-content':contentPage,'storage-retention':retentionPage,'portable-export':exportPage,'portable-import':importPage33,'index-maintenance':indexPage,system:statisticsPage,diagnostics:diagnosticPage,'diagnostic-preferences':preferencesPage};return pages[id]?pages[id]():previousDetail33(id);};
  const previousActivity33=activityPage;
  activityPage=function(){const initial=previousActivity33();if(C().maintenanceWorks33?.length&&C().works){for(const work of C().maintenanceWorks33){const existing=C().works.find(x=>x.id===work.id);if(existing)Object.assign(existing,copy(work));else C().works.unshift(copy(work));}return previousActivity33();}return initial;};
  function capture33(el){if(!el.dataset.cs33Form)return false;const name=el.dataset.cs33Form,key=el.dataset.cs33Key,d=draft(name,{});d[key]=el.type==='checkbox'?el.checked:el.value;delete C().messages[name];if(name==='diagnostic-log'&&['file','stage','size'].includes(key))d.page=1;persist();return true;}
  document.addEventListener('input',e=>capture33(e.target));
  document.addEventListener('change',e=>{const el=e.target;if(el.id==='cs33-portable-file'){void choosePortable(el.files?.[0]);return;}if(!capture33(el))return;if((el.tagName==='SELECT'||el.type==='checkbox')&&['diagnostic-log','storage-statistics','retention'].includes(el.dataset.cs33Form))redraw();});
  const previousEnhance33=window.enhanceCentralSemantics;let logRefreshTimer;
  window.enhanceCentralSemantics=function(){if(previousEnhance33)previousEnhance33();const key=state.page.split('/')[1],def=routes33[key];if(def&&state.language==='en'){const heading=document.querySelector('.settings-content>.section-head h2'),description=document.querySelector('.settings-content>.section-head p');if(heading)heading.textContent=def[1];if(description)description.textContent=def[3];}if(state.page==='settings/agent-events'&&!document.getElementById('cs33-trace-capture-state')){const target=document.querySelector('.settings-content .cs-task'),s=diagnostics();if(target)target.insertAdjacentHTML('afterbegin','<aside id="cs33-trace-capture-state">'+N(T(s.trace.enabled?'当前账号的后续输入追踪已开启。此列表只含已保留记录。':'当前账号的后续输入追踪已关闭。已保留轨迹仍可阅读，旧运行不会自动补录。',s.trace.enabled?'Future input tracing is enabled for this account. This list contains retained records only.':'Future input tracing is disabled for this account. Retained traces remain readable; old runs are not backfilled.')+L(T('管理个人追踪偏好','Manage account tracing'),'settings/diagnostic-preferences'))+'</aside>');}clearTimeout(logRefreshTimer);if(state.page==='settings/diagnostics'&&draft('diagnostic-log',{}).auto)logRefreshTimer=setTimeout(()=>{if(state.page==='settings/diagnostics'){diagnostics().checked=stamp();redraw();}},5000);};
})();

/* R34: measured usage, pinned prices, and three distinct Agent inspection surfaces. */
(function(){
  'use strict';
  const translations=new Map(),T=(zh,en)=>{const pair={zh,en};translations.set(zh,pair);translations.set(en,pair);return state.language==='en'?en:zh;},copy=value=>JSON.parse(JSON.stringify(value));
  const B=(label,action,kind='subtle',extra='')=>button(label,'cs-'+action,extra,kind);
  const L=(label,path,kind='text')=>goButton(label,path,kind);
  const U=value=>'<span data-user-content>'+esc(value??'')+'</span>';
  const N=(text,kind='')=>'<div class="notice '+kind+'" role="status"><div>'+text+'</div></div>';
  const F=body=>'<div class="fields cs-fields">'+body+'</div>';
  const bind=(name,key)=>' data-cs34-form="'+esc(name)+'" data-cs34-key="'+esc(key)+'"';
  const input=(name,key,label,value='',type='text',extra='',id='')=>'<label class="field"><span>'+label+'</span><input id="'+(id||'cs34-'+esc(name+'-'+key))+'" class="field-input"'+bind(name,key)+' type="'+type+'" value="'+esc(value??'')+'" '+extra+'></label>';
  const select=(name,key,label,value,rows,id='')=>'<label class="field"><span>'+label+'</span><select id="'+(id||'cs34-'+esc(name+'-'+key))+'" class="field-input"'+bind(name,key)+'>'+rows.map(([v,zh,en])=>'<option value="'+esc(v)+'" '+(String(v)===String(value)?'selected':'')+'>'+esc(T(zh,en||zh))+'</option>').join('')+'</select></label>';
  const details=(id,label,body,open=false)=>'<details id="cs34-'+esc(id)+'" class="cs-disclosure" '+(open?'open':'')+'><summary>'+label+'</summary><div class="cs-disclosure-body">'+body+'</div></details>';
  const facts=rows=>'<dl class="cs-dl">'+rows.map(([key,value])=>'<div><dt>'+key+'</dt><dd>'+value+'</dd></div>').join('')+'</dl>';
  const row=(title,description,action='')=>'<div class="cs-row"><div><strong>'+title+'</strong><small>'+description+'</small></div><div class="actions">'+action+'</div></div>';
  const known=value=>typeof value==='number'&&Number.isFinite(value),number=value=>Number(value).toLocaleString(state.language==='en'?'en-US':'zh-CN');
  const stamp=()=>new Date().toISOString(),percent=value=>value==null?'—':(value*100).toFixed(1)+'%',seconds=value=>value==null?'—':(value/1000).toFixed(1)+T(' 秒',' s');
  function C(){state.cs||={};state.cs.drafts||={};state.cs.messages||={};return state.cs;}
  function draft(name,initial){return C().drafts[name]||(C().drafts[name]=copy(initial));}
  function message(name){const m=C().messages[name];return m?N(esc((state.language==='en'?m.en:m.zh)||m.text),m.error?'warn':'good'):'';}
  function remember(){state.focus||={};state.focus.details||={};document.querySelectorAll('main details[id^="cs"]').forEach(d=>{state.focus.details[state.page+'|'+d.id]=d.open;});}
  function redraw(){remember();persist();render();return true;}
  function result(name,text,error=false){C().messages[name]={text,error,...(translations.get(text)||{})};return redraw();}
  function money(value,currency){return value==null?currency+' '+T('未估算','not estimated'):currency+' '+Number(value).toFixed(6);}
  const usageLabels={agentId:{'context-query':['上下文查询 Agent','Context query Agent'],'file-analysis':['文件分析 Agent','File analysis Agent'],'document-import':['文档导入 Agent','Document import Agent']},moduleId:{conversations:['问答','Questions'],insights:['洞察','Insights'],memories:['记忆','Memory'],files:['文件分析','File analysis'],imports:['资料导入','Imports']},skillId:{'personal-insight':['个人洞察','Personal insight'],'memory-extraction':['记忆提取','Memory extraction'],'document-import':['文档导入','Document import'],'__none__':['未指定 Skill','No primary Skill'],'__unknown__':['历史未标记','Historically unlabelled']}};
  function label(key,value){if(value==='__unknown__')return T('历史未标记','Historically unlabelled');const v=usageLabels[key]?.[value];return v?T(...v):value;}
  function identity(r){return {agentId:r.attribution?.agentId??'__unknown__',moduleId:r.attribution?.moduleId??'__unknown__',skillId:r.attribution?(r.attribution.skillId??'__none__'):'__unknown__'};}
  function complete(t){return !!t&&(t.measurement==='thread_cumulative'?t.complete===true:t.requests>0&&t.requests===t.reportedRequests);}
  const priceKeys=['input','output','cacheRead','cacheWrite'];
  const priceLabels={input:['未缓存输入','Uncached input'],output:['输出','Output'],cacheRead:['缓存读取','Cache read'],cacheWrite:['缓存写入','Cache write']};
  const fixtureDay='2026-10-22';
  function usage(){
    const c=C();if(c.usage34)return c.usage34;
    const usd={provider:'demo-cloud',model:'demo-text',currency:'USD',input:.8,output:3.2,cacheRead:.2,cacheWrite:1,revision:1,savedAt:'2026-10-16T00:00:00Z'},cny={provider:'demo-cn',model:'demo-reasoning',currency:'CNY',input:2,output:6,cacheRead:.5,cacheWrite:2.5,revision:1,savedAt:'2026-10-16T00:00:00Z'};
    const full=(input,output)=>({requests:1,reportedRequests:1,inputTokens:input,outputTokens:output,totalTokens:input+output,cacheReadTokens:Math.floor(input/4),cacheWriteTokens:0,reasoningTokens:0});
    const make=(id,date,moduleId,tokens,status='completed',price=usd,more={})=>({id,provider:price?.provider||'demo-unpriced',model:price?.model||'demo-partial',currency:price?.currency||'USD',createdAt:date+'T09:25:00Z',durationMs:4100,status,tokens,price:price?copy(price):null,estimatedCost:price&&tokens&&complete(tokens)?((tokens.inputTokens-(tokens.cacheReadTokens||0)-(tokens.cacheWriteTokens||0))*price.input+tokens.outputTokens*price.output+(tokens.cacheReadTokens||0)*price.cacheRead+(tokens.cacheWriteTokens||0)*price.cacheWrite)/1e6:null,attribution:{agentId:moduleId==='imports'?'document-import':moduleId==='files'?'file-analysis':'context-query',moduleId,skillId:moduleId==='memories'?'memory-extraction':moduleId==='insights'?'personal-insight':moduleId==='imports'?'document-import':null},...more});
    const rows=state.dataState==='empty'?[]:[
      make('usage-001','2026-10-22','conversations',full(2400,600),'completed',usd,{traceId:'trace-memory-study-body'}),
      make('usage-002','2026-10-22','files',{requests:2,reportedRequests:1,inputTokens:900,outputTokens:50,totalTokens:950},'failed',null,{durationMs:5700,reason:'Provider reported only the first request; no model price was configured.'}),
      make('usage-003','2026-10-22','imports',full(1200,200),'failed',usd,{durationMs:2700,reason:'A later validation failed after the provider reported usage.'}),
      make('usage-004','2026-10-22','memories',null,'running',usd,{durationMs:null,reason:'The run has no final receipt.'}),
      make('usage-005','2026-10-21','insights',{...full(3600,900),cacheWriteTokens:200,reasoningTokens:300},'completed',cny,{durationMs:8300}),
      make('usage-006','2026-10-21','conversations',{measurement:'thread_cumulative',complete:true,requests:0,reportedRequests:0,inputTokens:2200,outputTokens:700,totalTokens:2900,cacheReadTokens:500,cacheWriteTokens:0,reasoningTokens:200},'completed',usd,{durationMs:6100}),
      make('usage-007','2026-10-20','conversations',null,'completed',null,{attribution:null,reason:'This historical run did not retain a usage receipt.',durationMs:3300,traceId:'historical-before-tracing'}),
      make('usage-008','2026-10-20','memories',full(1800,500),'completed',usd,{traceId:'trace-demo-partial'}),
      make('usage-009','2026-10-19','imports',full(800,250),'completed',usd),
      make('usage-010','2026-10-18','files',full(1200,300),'completed',cny),
      make('usage-011','2026-10-17','memories',full(1600,400),'completed',usd),
      make('usage-012','2026-10-16','insights',full(2100,500),'completed',usd)
    ];
    c.usage34={rows,prices:[usd,cny],filters:{from:'2026-10-16',to:fixtureDay,agentId:'',moduleId:'',skillId:'',provider:'',model:'',status:''},groupBy:'agentId',page:1,pageSize:10,readAt:stamp()};return c.usage34;
  }
  function selectedUsage34(){const u=usage(),f=u.filters;return u.rows.filter(r=>{const i=identity(r),day=r.createdAt.slice(0,10);return (!f.from||day>=f.from)&&(!f.to||day<=f.to)&&['agentId','moduleId','skillId'].every(k=>!f[k]||i[k]===f[k])&&['provider','model','status'].every(k=>!f[k]||r[k]===f[k]);});}
  function totals(rows){
    const reported=key=>rows.reduce((n,r)=>n+(known(r.tokens?.[key])?r.tokens[key]:0),0),finished=rows.filter(r=>r.status!=='running'),durations=finished.map(r=>r.durationMs).filter(known).sort((a,b)=>a-b),cached=rows.filter(r=>known(r.tokens?.cacheReadTokens)&&known(r.tokens?.inputTokens));
    const costs={};for(const currency of ['USD','CNY']){const same=rows.filter(r=>r.currency===currency),priced=same.filter(r=>known(r.estimatedCost));costs[currency]={runs:same.length,known:priced.length?priced.reduce((n,r)=>n+r.estimatedCost,0):null,missing:same.length-priced.length};}
    return {runs:rows.length,completed:rows.filter(r=>r.status==='completed').length,failed:rows.filter(r=>r.status==='failed').length,running:rows.filter(r=>r.status==='running').length,input:reported('inputTokens'),output:reported('outputTokens'),total:reported('totalTokens'),cacheRead:reported('cacheReadTokens'),cacheWrite:reported('cacheWriteTokens'),reasoning:reported('reasoningTokens'),requests:rows.filter(r=>r.tokens?.measurement!=='thread_cumulative').reduce((n,r)=>n+(r.tokens?.requests||0),0),reportedRequests:rows.filter(r=>r.tokens?.measurement!=='thread_cumulative').reduce((n,r)=>n+(r.tokens?.reportedRequests||0),0),unknownRequests:rows.filter(r=>!r.tokens||r.tokens.measurement==='thread_cumulative').length,unknownUsage:rows.filter(r=>!complete(r.tokens)).length,unknownCache:rows.filter(r=>!known(r.tokens?.cacheReadTokens)).length,unknownWrite:rows.filter(r=>!known(r.tokens?.cacheWriteTokens)).length,unknownReasoning:rows.filter(r=>!known(r.tokens?.reasoningTokens)).length,cacheRate:cached.reduce((n,r)=>n+r.tokens.inputTokens,0)?cached.reduce((n,r)=>n+r.tokens.cacheReadTokens,0)/cached.reduce((n,r)=>n+r.tokens.inputTokens,0):null,success:finished.length?rows.filter(r=>r.status==='completed').length/finished.length:null,average:durations.length?durations.reduce((a,b)=>a+b,0)/durations.length:null,p95:durations.length?durations[Math.ceil(durations.length*.95)-1]:null,costs};
  }
  function costSummary(s){return ['USD','CNY'].map(currency=>'<div>'+U(s.costs[currency].runs?money(s.costs[currency].known,currency):currency+' '+T('无记录','no records'))+(s.costs[currency].missing?' · '+s.costs[currency].missing+T(' 次未估算',' unpriced runs'):'')+'</div>').join('');}
  function scopeText(f){return U((f.from||'…')+' → '+(f.to||'…'))+' · UTC'+['agentId','moduleId','skillId','provider','model','status'].filter(k=>f[k]).map(k=>' · '+U(label(k,f[k]))).join('');}
  function usagePage(){
    const u=usage(),run=state.page.split('/')[3];if(state.page.split('/')[2]==='run')return usageRunPage(run);
    const d=draft('usage',u.filters),rows=selectedUsage34(),s=totals(rows),pages=Math.max(1,Math.ceil(rows.length/u.pageSize));u.page=Math.min(u.page,pages);
    const options=key=>[['',T('全部','All'),T('全部','All')],...[...new Set(u.rows.map(r=>identity(r)[key]))].map(v=>[v,label(key,v),label(key,v)])];
    const models=[...new Map(u.rows.map(r=>[r.provider+' / '+r.model,{provider:r.provider,model:r.model}])).values()];
    const groups=[...new Set(rows.map(r=>u.groupBy==='model'?r.provider+' / '+r.model:u.groupBy==='provider'?r.provider:identity(r)[u.groupBy]))].map(key=>{const values=rows.filter(r=>(u.groupBy==='model'?r.provider+' / '+r.model:u.groupBy==='provider'?r.provider:identity(r)[u.groupBy])===key);return {key,values,total:totals(values)};}).sort((a,b)=>b.total.total-a.total.total);
    return '<article class="cs-task">'+N(T('当前账号的固定合成用量账本，示例截止 2026-10-22。原型没有发送模型请求；这里的金额均为估算示例。','Fixed synthetic usage ledger for the current account, ending 2026-10-22. The prototype sent no model requests; all costs here are fixture estimates.'))+'<div class="actions">'+L(T('维护模型价格','Manage model prices'),'settings/usage-prices')+B(T('刷新用量','Refresh usage'),'usage-refresh','text')+'</div><section class="cs-zone">'+message('usage')+F('<div class="cs-editor-row">'+input('usage','from',T('开始日期','Start date'),d.from,'date')+input('usage','to',T('结束日期','End date'),d.to,'date')+'</div>')+details('usage-filters',T('按任务、模型与状态筛选','Filter by task, model, and status'),F(select('usage','agentId','Agent',d.agentId,options('agentId'))+select('usage','moduleId',T('模块','Module'),d.moduleId,options('moduleId'))+select('usage','skillId','Skill',d.skillId,options('skillId'))+select('usage','modelChoice',T('模型与服务 ID','Model and provider IDs'),d.model?d.provider+' / '+d.model:'',[['','全部模型','All models'],...models.map(v=>[v.provider+' / '+v.model,v.provider+' / '+v.model,v.provider+' / '+v.model])])+select('usage','status',T('运行状态','Run status'),d.status,[['','全部状态','All states'],['completed','已完成','Completed'],['failed','失败','Failed'],['running','进行中','Running']]))+'<p>'+T('筛选字段仅使用运行记录的归属，不从问题或正文猜测。','Filters use recorded execution attribution, without inferring it from questions or body text.')+'</p>')+'<div class="actions">'+B(T('应用筛选','Apply filters'),'usage-apply','primary')+B(T('清除条件','Clear conditions'),'usage-clear','text')+[1,7,30].map(days=>B(T('示例近 '+days+' 天','Fixture '+days+' days'),'usage-preset','text','data-days="'+days+'"')).join('')+'</div><p class="small" data-cs34-usage-scope>'+T('当前结果范围：','Current result scope: ')+scopeText(u.filters)+'</p></section><section class="cs-zone"><h3>'+T('已上报的消耗','Reported consumption')+'</h3><div class="cs34-metrics"><div><span>'+T('已知 token','Known tokens')+'</span><strong>'+number(s.total)+'</strong><small>'+T('输入 / 输出','Input / output')+' '+number(s.input)+' / '+number(s.output)+'</small></div><div><span>'+T('已知费用 · 分币种','Known cost · separate currencies')+'</span><strong>'+costSummary(s)+'</strong></div><div><span>'+T('运行次数','Runs')+'</span><strong>'+s.runs+'</strong><small>'+s.running+T(' 进行中 · ',' running · ')+s.failed+T(' 失败',' failed')+'</small></div></div><p>'+s.unknownUsage+T(' 次用量缺失或不完整；',' runs have missing or incomplete usage; ')+s.unknownCache+T(' 次未提供缓存读取。未知部分没有按零计算。',' did not report cache reads. Unknown values are not counted as zero.')+'</p>'+details('usage-measurements',T('缓存、推理、请求数与完成质量','Cache, reasoning, request counts, and finished-run quality'),facts([[T('已上报缓存读取 / 写入','Reported cache read / write'),number(s.cacheRead)+' / '+number(s.cacheWrite)+' · '+s.unknownWrite+T(' 次写入未上报',' unreported write buckets')],[T('已上报推理 token','Reported reasoning tokens'),number(s.reasoning)+' · '+s.unknownReasoning+T(' 次未上报；已包含在输出',' unreported; included in output')],[T('缓存命中率','Cache hit rate'),percent(s.cacheRate)],[T('已计量 / 已知模型请求','Measured / known model requests'),s.reportedRequests+' / '+s.requests+' · '+s.unknownRequests+T(' 次运行底层请求数未知',' runs with unknown underlying request counts')],[T('结束运行成功率','Finished-run success rate'),percent(s.success)],[T('结束运行耗时均值 / P95','Finished-run mean / P95 duration'),seconds(s.average)+' / '+seconds(s.p95)]])+'<p>'+T('成功率与耗时仅统计已结束运行；失败运行的已上报消耗仍计入。缓存率只按已上报缓存数据的输入加权。累计会话 token 不推算底层请求次数。','Success and latency include only finished runs; reported consumption from failed runs is included. Cache rate is weighted only by inputs with reported cache data. Thread totals do not imply an underlying request count.')+'</p>')+'</section>'+details('usage-groups',T('按维度查看消耗分布','Inspect consumption by dimension'),select('usage-view','groupBy',T('聚合维度','Group by'),u.groupBy,[['agentId','Agent','Agent'],['moduleId','模块','Module'],['skillId','Skill','Skill'],['model','模型','Model'],['provider','服务','Provider']])+groups.map(g=>row(U(label(u.groupBy,g.key)),g.total.runs+T(' 次运行 · ',' runs · ')+number(g.total.total)+' token · '+g.total.unknownUsage+T(' 次用量不完整',' incomplete usage')+'<br>'+costSummary(g.total),B(T('筛选这组','Filter this group'),'usage-group','text','data-key="'+esc(g.key)+'"'))).join('')+(!groups.length?'<p>'+T('这个范围没有分组。','No groups in this scope.')+'</p>':''))+details('usage-days',T('每日用量 · 点击日期查看','Daily usage · select a day'),[...new Set(rows.map(r=>r.createdAt.slice(0,10)))].map(date=>{const total=totals(rows.filter(r=>r.createdAt.startsWith(date)));return row(U(date),total.runs+T(' 次运行 · ',' runs · ')+number(total.total)+' token<br>'+costSummary(total),B(T('查看当天','View this day'),'usage-day','text','data-date="'+date+'"'));}).join('')||'<p>'+T('当前范围没有每日记录。','No daily records in this scope.')+'</p>')+'<section class="cs-zone"><h3>'+T('运行明细','Run details')+'</h3><p>'+T('统计包含全部符合条件的记录，下面只对明细分页。','Totals include every matching record; only the detail list is paginated.')+'</p>'+select('usage-view','pageSize',T('每页条数','Runs per page'),u.pageSize,[10,20,50,100].map(n=>[n,String(n),String(n)]))+rows.slice((u.page-1)*u.pageSize,u.page*u.pageSize).map(r=>row(U(r.id)+' · '+U(r.model),U(r.createdAt)+' · '+label('moduleId',identity(r).moduleId)+' · '+statusLabel(r.status)+'<br>'+money(r.estimatedCost,r.currency)+(complete(r.tokens)?'':' · '+T('用量缺失或不完整','Missing or incomplete usage')),L(T('打开运行','Open run'),'settings/usage/run/'+r.id,'subtle'))).join('')+(!rows.length?N(T('当前日期与条件没有用量记录。启用前的历史对话无法补算。','No usage records match these dates and filters. Conversations predating accounting cannot be backfilled.')):'')+'<div class="form-actions">'+B(T('上一页','Previous page'),'usage-page','text','data-delta="-1" '+(u.page>1?'':'disabled'))+'<span>'+u.page+' / '+pages+'</span>'+B(T('下一页','Next page'),'usage-page','text','data-delta="1" '+(u.page<pages?'':'disabled'))+'</div></section></article>';
  }
  function statusLabel(value){return T(...({completed:['已完成','Completed'],failed:['失败','Failed'],running:['进行中','Running']}[value]||[value,value]));}
  function tokenValue(t,key){return known(t?.[key])?number(t[key]):T('未上报','Not reported');}
  function priceFacts(p){return p?facts([[T('服务 / 模型 ID','Provider / model IDs'),U(p.provider)+' / '+U(p.model)],[T('币种','Currency'),U(p.currency)],...priceKeys.map(k=>[T(...priceLabels[k])+' / 1M tokens',U(p[k])])]):N(T('运行开始时没有保存价格，费用未估算。','No price was captured at run start; cost is not estimated.'),'warn');}
  function usageRunPage(id){const u=usage(),r=u.rows.find(x=>x.id===id);if(!r)return '<article class="cs-task">'+N(T('没有这次运行的用量回执。无法根据当前价格补算。','No usage receipt exists for this run. Current prices cannot reconstruct its cost.'),'warn')+L(T('返回用量','Back to usage'),'settings/usage')+'</article>';const t=r.tokens;return '<article class="cs-task"><div class="actions">'+L(T('返回用量与原筛选','Back to usage and filters'),'settings/usage','subtle')+'</div><section class="cs-zone"><h3>'+U(r.id)+'</h3>'+N(T('合成历史回执：下方价格和估算在示例运行开始时固定，不随当前价格修改。','Synthetic historical receipt: its price and estimate were pinned at fixture-run start and do not change with current prices.'))+facts([[T('状态 / 时间','Status / time'),statusLabel(r.status)+' / '+U(r.createdAt)],[T('服务 / 模型','Provider / model'),U(r.provider)+' / '+U(r.model)],[T('Agent / 模块 / 主 Skill','Agent / module / primary Skill'),Object.entries(identity(r)).map(([k,v])=>U(label(k,v))).join(' / ')],[T('历史费用估算','Historical cost estimate'),'<strong data-cs34-historical-cost>'+money(r.estimatedCost,r.currency)+'</strong>'],[T('输入 / 输出 token','Input / output tokens'),tokenValue(t,'inputTokens')+' / '+tokenValue(t,'outputTokens')],[T('缓存读取 / 写入','Cache read / write'),tokenValue(t,'cacheReadTokens')+' / '+tokenValue(t,'cacheWriteTokens')],[T('推理 token（含在输出）','Reasoning tokens (included in output)'),tokenValue(t,'reasoningTokens')],[T('模型请求','Model requests'),t?.measurement==='thread_cumulative'?T('累计会话计量；底层请求数未上报','Thread-cumulative measurement; underlying request count not reported'):t?t.reportedRequests+' / '+t.requests+T(' 次已计量',' measured'):T('未上报','Not reported')],[T('耗时','Duration'),seconds(r.durationMs)]])+(r.reason?N(U(r.reason),r.status==='failed'?'warn':''):'')+(!complete(t)?N(T('只显示已知部分。未上报的 token、缓存、请求或价格均保留为未知；未估算不是免费。','Only known measurements are shown. Unreported tokens, cache, requests, or prices remain unknown; an unestimated run is not free.'),'warn'):'')+'</section>'+details('usage-run-price',T('运行开始时固定的价格','Price pinned at run start'),priceFacts(r.price)+L(T('查看或调整后续运行价格','Inspect or edit future-run prices'),'settings/usage-prices'))+'<div class="actions">'+B(T('查看此运行保留的输入','Inspect retained input for this run'),'usage-trace','text','data-id="'+r.id+'"')+'</div><p class="small">'+T('服务商账单为准；订阅套餐的实际扣费无法由 token 估价推算。','Provider billing is authoritative; subscription charges cannot be inferred from token estimates.')+'</p></article>';}
  function priceDraft(){const u=usage();return draft('prices',{...(u.prices[0]||{provider:'',model:'',currency:'USD',input:'',output:'',cacheRead:'',cacheWrite:'',revision:0}),originalKey:u.prices[0]?u.prices[0].provider+'/'+u.prices[0].model:''});}
  function pricePage(){const u=usage(),d=priceDraft(),saved=u.prices.find(p=>p.provider===d.provider&&p.model===d.model);return '<article class="cs-task">'+N(T('每百万 token 的估算单价，仅用于之后开始的运行。历史回执保留开始时价格；订阅套餐实际扣费不能由这里推算。','Estimation prices per million tokens apply to future runs. Historical receipts retain their start-time price; subscription charges cannot be inferred here.'))+message('prices')+details('price-list',T('已保存的服务与模型','Saved providers and models'),u.prices.map(p=>row(U(p.provider)+' / '+U(p.model),U(p.currency)+' · '+T('保存版本 ','Saved revision ')+p.revision,B(T('读取此价格','Load this price'),'price-load','text','data-provider="'+esc(p.provider)+'" data-model="'+esc(p.model)+'"'))).join('')+'<p>'+T('读取会保留其他模型的未保存草稿。','Loading preserves unsaved drafts for other models.')+'</p>')+F(input('prices','provider',T('服务 ID','Provider ID'),d.provider)+input('prices','model',T('模型 ID','Model ID'),d.model)+select('prices','currency',T('币种','Currency'),d.currency,[['USD','USD','USD'],['CNY','CNY','CNY']])+priceKeys.map(k=>input('prices',k,T(...priceLabels[k])+' / 1M tokens',d[k],'number','min="0" max="1000000" step="any"')).join('')+'<div class="form-actions">'+B(T('保存后续运行价格','Save future-run prices'),'price-save','primary')+B(T('还原这项已保存价格','Restore this saved price'),'price-reload','text')+'</div>')+(saved?details('price-saved',T('当前已保存、供后续运行使用','Saved and available for future runs'),priceFacts(saved)+facts([[T('保存版本 / 时间','Saved revision / time'),saved.revision+' / '+U(saved.savedAt)]]),true):N(T('这组服务与模型尚无已保存价格；草稿不会参与估算。','This provider/model pair has no saved price; its draft is not used for estimation.')))+'<div class="actions">'+L(T('返回用量与历史回执','Back to usage and historical receipts'),'settings/usage')+'</div></article>';}
  const dirs=[['/context/memory','精选记忆','Selected memory','L3 / L4'],['/context/episodes','片段与理解','Episodes and interpretation','L2'],['/context/sources','来源与原文','Sources and originals','L0 / L1'],['/materials','正式资料','Materials','']];
  function agent(){return C().agent34||(C().agent34={scope:{deviceId:'',after:'',before:''},tab:'catalog',path:'/context',source:'',page:0,selected:null,back:[],offset:0,preview:null});}
  function materialDevice(m){if(m.deviceId)return m.deviceId;const device=state.devices.find(d=>d.name===m.device||d.platform===m.device);return device?.id||({Mac:'mac',Android:'android','网页':'web','中央':'central'}[m.device]||m.device||'');}
  function materialTime(m){const fixed={m1:'2026-10-20T09:12:00Z',m2:'2026-10-19T18:34:00Z',m3:'2026-10-19T16:20:00Z',m4:'2026-10-22T14:00:00Z',m5:'2026-10-18T15:30:00Z',m6:'2026-10-18T11:08:00Z'};return m.capturedAt||m.createdAt||m.savedAt||fixed[m.id]||'';}
  function utcTime(value){return Date.parse(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(value)?value+'Z':value);}
  function inScope(m){const s=agent().scope,t=utcTime(materialTime(m));return (!s.deviceId||materialDevice(m)===s.deviceId)&&(!s.after||Number.isFinite(t)&&t>=utcTime(s.after))&&(!s.before||Number.isFinite(t)&&t<=utcTime(s.before));}
  function materialEntries(){return state.materials.filter(inScope).map(m=>({kind:'material',id:m.id,title:m.title,preview:m.preview||'',layer:'L0 / L1',revision:C().files?.[m.id]?.version||1}));}
  function memoryEntries(){const out=[];if(!state.memoryDeleted){const m=state.materials.find(m=>m.id==='m1');if(m&&inScope(m))out.push({kind:'memory',id:'original',title:T('产品设计偏好','Product design preference'),preview:originalMemoryText(),statement:originalMemoryText(),uncertainty:memoryBoundary('original'),evidence:['m1'],revision:memoryVersions('original').length});}if(state.memoryExtracted){const ids=(state.memoryFrom||[]).filter(id=>state.materials.some(m=>m.id===id&&inScope(m)));if(ids.length)out.push({kind:'memory',id:'generated',title:T('从资料整理的记忆','Memory from materials'),preview:state.generatedMemoryText||state.memoryContext||'',statement:state.generatedMemoryText||state.memoryContext||'',uncertainty:memoryBoundary('generated'),evidence:ids,revision:memoryVersions('generated').length});}return out;}
  function entries(){const a=agent();if(a.source)return materialEntries().filter(e=>state.materials.find(m=>m.id===e.id)?.sourceId===a.source);if(a.path==='/materials')return materialEntries();if(a.path==='/context/memory')return memoryEntries();if(a.path==='/context/episodes')return materialEntries().filter(e=>['audio','screen'].includes(state.materials.find(m=>m.id===e.id)?.type)).map(e=>({...e,kind:'episode',layer:'L2',preview:T('当前已保留的转写或屏幕语义正文','Currently retained transcript or screen semantic body')}));if(a.path==='/context/sources')return state.sources.filter(s=>!a.scope.deviceId&&!a.scope.after&&!a.scope.before||state.materials.some(m=>m.sourceId===s.id&&inScope(m))).map(s=>({kind:'source',id:s.id,title:s.title||s.name,preview:T('已保存来源说明与当前可读条目','Saved source description and currently readable entries')}));return [];}
  function sourceDescription(id){const pending=!!state.focus?.sourcePendingAcks?.[id],cfg=state.sourceConfigs?.[id]||{},revision=state.focus?.sourceVersions?.[id]||0;if(pending)return N(T('来源说明尚在本机等待 Central 确认；当前浏览不把它当作已接收的上下文。','This source description is awaiting Central acknowledgement locally and is not presented as received context.'),'warn');if(!revision)return N(T('这项来源尚无已确认的说明版本。可浏览已保存资料，说明草稿不作为已接收上下文。','This source has no acknowledged description revision. Saved material remains browsable; a description draft is not received context.'));const value=typeof savedSourceContext==='function'?savedSourceContext(id):cfg;return facts([[T('已接收的来源关系','Acknowledged source attribution'),U(labelRelation(value.ownerRelation))],[T('已保存说明版本','Saved description revision'),revision]])+'<div class="cs-preserve" data-user-content>'+esc(value.contextDescription||T('尚未保存背景说明。','No background description has been saved.'))+'</div><p class="small">'+T('来源说明属于可读取内容；浏览它不会把它加入任何实际回答。','Source descriptions are accessible content; browsing does not add them to an actual answer.')+'</p>';}
  function labelRelation(value){return T(...({owner:['我的表达或经历','My expression or experience'],third_party:['第三方内容','Third-party content'],mixed:['混合内容','Mixed content'],unknown:['归属未知','Unknown attribution']}[value]||['不声明','Not declared']));}
  function sourcePanel(){const a=agent(),s=state.sources.find(s=>s.id===a.source);return s?'<section class="cs-zone"><h3>'+U(s.title||s.name)+'</h3>'+sourceDescription(s.id)+'<div class="actions">'+B(T('返回来源目录','Back to source directory'),'agent-source-back','text')+'</div></section>':'';}
  function bodyText(m){const f=C().files?.[m.id];return f?.segments?.length?f.segments.map(s=>s.text).join('\n'):String(m.body||'');}
  function entryDetail(){const a=agent(),e=a.selected;if(!e)return '';const memory=e.kind==='memory'?memoryEntries().find(x=>x.id===e.id):null,m=e.kind!=='memory'?state.materials.find(m=>m.id===e.id&&inScope(m)):null;if(!memory&&!m)return N(T('该条目不在当前范围，或已经不再保留。没有补造内容。','This entry is outside the current scope or is no longer retained. No content has been reconstructed.'),'warn');const text=memory?memory.statement:bodyText(m),total=text.length,offset=Math.min(a.offset,Math.max(0,total-1)),end=Math.min(total,offset+80),part=text.slice(offset,end);return '<section class="cs-zone cs34-entry-detail" data-cs34-entry="'+esc(e.id)+'"><div class="cs-summary"><h3>'+U(memory?.title||m.title)+'</h3>'+B(T('关闭展开内容','Close expanded content'),'agent-entry-close','text')+'</div><p>'+T('可访问 · 本次浏览展开','Accessible · expanded for this inspection')+' · '+(memory?'L3 / L4':e.kind==='episode'?'L2':'L0 / L1')+'</p>'+facts([[T('虚拟标识','Virtual reference'),U(memory?'memory:'+memory.id:'material:'+m.id)],[T('当前正文版本','Current body revision'),memory?.revision||C().files?.[m.id]?.version||1],...(m?[[T('设备 / 记录时间','Device / recorded time'),U(materialDevice(m))+' / '+U(materialTime(m)||T('未知','Unknown'))]]:[])])+'<div class="cs-preserve cs34-read-body" data-user-content>'+esc(part)+'</div><p class="small" data-cs34-range>'+T('已展开 ','Expanded ')+offset+'–'+end+' / '+total+T(' 个字符',' characters')+'</p><div class="actions">'+(offset?B(T('返回正文第一页','First body page'),'agent-body-first','text'):'')+(end<total?B(T('继续展开正文','Continue reading body'),'agent-body-next','subtle','data-offset="'+end+'"'):'')+(a.back.length?B(T('返回上一个条目','Back to previous entry'),'agent-entry-back','text'):'')+'</div>'+(memory?'<p><strong>'+T('不确定性与适用范围','Uncertainty and scope')+'</strong> · '+U(memory.uncertainty)+'</p>'+details('agent-evidence-'+memory.id,T('支持证据 · 按需读取原文','Supporting evidence · read originals on demand'),memory.evidence.map(id=>{const source=state.materials.find(m=>m.id===id&&inScope(m));return source?'<blockquote class="cs-preserve" data-user-content>'+esc(bodyText(source).slice(0,80))+'</blockquote>'+B(T('读取原始证据 · ','Read original evidence · ')+source.title,'agent-evidence','text','data-id="'+esc(id)+'"'):N(T('支持原文当前不可读；缺失内容不补造。','Supporting original is currently unavailable; missing content is not reconstructed.'));}).join('')+'<p>'+T('支持原文仅部分展开，读取全部片段仍属于当前浏览。','Supporting originals are partially expanded. Reading further remains an inspection action.')+'</p>'):L(T('打开资料详情','Open material detail'),'material/'+m.id))+'</section>';}
  function scopeView(s){return U(s.deviceId||T('全部设备','All devices'))+' · '+U(s.after||'…')+' → '+U(s.before||'…')+' · UTC';}
  function agentPage(){const a=agent(),d=draft('agent-scope',a.scope),all=entries(),shown=all.slice(a.page*3,a.page*3+3);return '<article class="cs-task"><nav class="actions cs34-view-tabs" aria-label="'+T('Agent 视角','Agent view')+'">'+B(T('可访问目录','Accessible catalog'),'agent-tab','subtle','data-tab="catalog" aria-pressed="'+(a.tab==='catalog')+'"')+B(T('首次上下文','Initial context'),'agent-tab','subtle','data-tab="startup" aria-pressed="'+(a.tab==='startup')+'"')+L(T('实际输入与读取轨迹','Retained input and reads'),'settings/agent-events')+'</nav><section class="cs-zone">'+message('agent-scope')+details('agent-scope',T('设备与时间范围','Device and time scope'),F(input('agent-scope','deviceId',T('设备 ID（留空为全部）','Device ID (blank for all)'),d.deviceId,'text','placeholder="mac"')+input('agent-scope','after',T('开始时间（UTC）','Start time (UTC)'),d.after,'datetime-local')+input('agent-scope','before',T('结束时间（UTC）','End time (UTC)'),d.before,'datetime-local'))+'<p>'+T('已连接设备 ID：','Connected device IDs: ')+U(state.devices.map(v=>v.id).join(', ')||T('暂无','None'))+'</p><div class="actions">'+B(T('应用范围','Apply scope'),'agent-scope-apply','primary')+B(T('清除范围','Clear scope'),'agent-scope-clear','text')+'</div>')+'<p class="small" data-cs34-agent-scope>'+T('当前范围：','Current scope: ')+scopeView(a.scope)+'</p></section>'+(a.tab==='startup'?startupPage():'<section class="cs-zone"><div class="cs-summary"><h3>'+T('只读虚拟目录','Read-only virtual catalog')+'</h3>'+B(T('返回目录首页','Catalog home'),'agent-directory','text','data-path="/context"')+'</div><p>'+T('条目按需披露。没有列出不代表不存在。这里不公开内部磁盘路径或原始 Coding 事件包。','Entries are disclosed on demand. An omitted entry is not evidence of absence. Internal disk paths and raw Coding event packages are not exposed.')+'</p>'+(a.path==='/context'?dirs.map(([path,zh,en,layer])=>row(T(zh,en),U(path)+' · '+layer,B(T('浏览目录','Browse directory'),'agent-directory','subtle','data-path="'+path+'"'))).join(''):'<p><code>'+U(a.path)+'</code></p>'+sourcePanel()+shown.map(e=>row(U(e.title),U(e.preview?.slice(0,140)||e.layer||'')+'<br><code>'+U((e.kind==='source'?'source:':e.kind==='memory'?'memory:':'material:')+e.id)+'</code>',B(T(e.kind==='source'?'打开来源':'展开内容',e.kind==='source'?'Open source':'Expand content'),'agent-entry','subtle','data-kind="'+e.kind+'" data-id="'+esc(e.id)+'"'))).join('')+(!all.length?N(T('当前范围内暂无条目。没有列出不代表不存在；可检查范围或返回目录。','No entries are listed in this scope. Omission does not establish absence; inspect the scope or return to the catalog.')):'')+'<div class="form-actions">'+B(T('上一页条目','Previous entries'),'agent-list-page','text','data-delta="-1" '+(a.page?'':'disabled'))+'<span>'+(a.page+1)+' / '+Math.max(1,Math.ceil(all.length/3))+'</span>'+B(T('下一页条目','Next entries'),'agent-list-page','text','data-delta="1" '+((a.page+1)*3<all.length?'':'disabled'))+'</div>')+'</section>'+entryDetail()+'<p class="small">'+T('目录可访问、此次浏览展开、启动时提供、实际工具读取，分别是不同的记录。当前浏览不会改写历史输入。','Catalog access, inspection expansion, initial context, and recorded tool reads are distinct records. This inspection does not rewrite historical input.')+'</p>')+'</article>';}
  function previewFingerprint(){return JSON.stringify({scope:agent().scope,question:draft('agent-preview',{question:''}).question,memories:memoryEntries().map(m=>({id:m.id,statement:m.statement,revision:m.revision}))});}
  function contextContents(context,synthetic=false){return facts([[T('当前问题','Current question'),U(context.request||T('尚未输入问题','No question supplied'))],[T('时间与设备范围','Time and device scope'),scopeView({deviceId:context.selectedDeviceId,after:context.selectedTimeRange?.after,before:context.selectedTimeRange?.before})]])+'<h4>'+T(synthetic?'此次合成预览包含的记忆线索':'记录中的首次记忆线索',synthetic?'Memory leads in this synthetic preview':'Initially supplied memory leads in this record')+' · '+(context.untrustedMemoryLeads?.length||0)+'</h4>'+(context.untrustedMemoryLeads||[]).map(m=>'<div class="cs34-proof"><strong>'+U(m.title)+'</strong><p class="cs-preserve" data-user-content>'+esc(m.statement)+'</p><p>'+T('不确定性：','Uncertainty: ')+U(m.uncertainty||T('未记录','Not recorded'))+'</p><code>'+U(m.id)+'</code></div>').join('')+(!context.untrustedMemoryLeads?.length?'<p>'+T('此次没有提供记忆线索。目录和原文仍可按需读取。','No memory leads were supplied. Catalogs and originals can still be read on demand.')+'</p>':'')+(context.conversation?'<p>'+T('已提供 ','Included ')+(context.conversation.turns?.length||0)+T(' 轮对话，省略 ',' conversation turns; omitted ')+(context.conversation.omittedTurns||0)+T(' 轮。',' turns.')+'</p>':'')+'<p>'+T('启动时指定证据：','Evidence specified initially: ')+(context.untrustedEvidence?.length||0)+'</p>';}
  function startupPage(){const a=agent(),d=draft('agent-preview',{question:''}),p=a.preview,stale=p&&p.fingerprint!==previewFingerprint();return '<section class="cs-zone"><h3>'+T('一次新对话的首次上下文','Initial context for a new conversation')+'</h3><p>'+T('用当前范围内的已保存记忆生成合成预览，不调用模型，也不执行语义检索。预览不会发送提问或创建回答。','Build a synthetic preview from saved memory in this scope, without a model call or semantic retrieval. Previewing does not submit a question or create an answer.')+'</p>'+message('agent-preview')+F(input('agent-preview','question',T('想问的问题','Question'),d.question,'text','maxlength="4000"')+'<div class="form-actions">'+B(T('预览首次上下文','Preview initial context'),'agent-preview','primary')+'</div>')+(stale?N(T('问题、范围或当前记忆已经变化。下方仍是上次预览，请重新预览后核对。','The question, scope, or current memory changed. The prior preview remains below; preview again to inspect the new inputs.'),'warn'):'')+details('agent-startup-rules',T('默认输入与按需读取','Default inputs and on-demand reads'),'<p>'+T('默认包含系统规则、只读工具说明、当前问题、时间与设备范围，及最多 8 条记忆线索。原型按保存顺序展示示例线索，不声称执行了真实检索。','Defaults include system rules, read-only tool descriptions, the question, time/device scope, and up to eight memory leads. The prototype lists fixture leads in saved order and does not claim real retrieval.')+'</p><p>'+T('已有对话按预算带入历史或工作摘要；此处是没有历史的新对话。完整目录、文件正文和原图按需读取，原图还受独立授权控制。','Existing conversations include history or working summaries according to budget; this preview is a new conversation without history. Full catalogs, bodies, and original images are read on demand; original images require independent permission.')+'</p>')+(p?'<section class="cs-zone" data-cs34-preview><h3>'+T('预览结果 · 模型调用 0','Preview result · 0 model calls')+'</h3>'+contextContents(p.context,true)+details('agent-preview-structure',T('系统规则、只读工具与上下文结构','System rules, read-only tools, and context structure'),'<p class="cs-preserve" data-user-content>'+esc(p.system)+'</p><pre class="cs34-json" data-user-content>'+esc(JSON.stringify({tools:p.tools,context:p.context,modelCalls:0},null,2))+'</pre>')+'<p>'+T('刚才浏览过的来源说明和资料正文没有因此进入此预览。某次实际运行收到什么，只能从当时保留的输入记录核对。','Previously browsed source descriptions and bodies were not thereby added to this preview. Only a retained input record establishes what a particular run actually received.')+'</p></section>':'<p>'+T('填写问题并预览，查看具体的首次输入。','Enter a question and preview its concrete initial inputs.')+'</p>')+'</section>';}
  function retained(){const c=C();if(!c.traceFixtures34){c.traceFixtures34=true;c.traces||=[];if(state.dataState!=='empty'&&!c.traces.some(t=>t.id==='trace-demo-partial')){const context={request:'Pre-recorded synthetic question: review the retained research excerpt.',selectedTimeRange:{after:'2026-10-16T00:00:00Z',before:'2026-10-22T23:59:59Z'},selectedDeviceId:'mac',timeZone:'UTC',untrustedMemoryLeads:[{id:'memory:original',title:'Retained design preference',statement:'Prefer a simple task-oriented starting point.',uncertainty:'A retained fixture, not the current edited memory.'}],conversation:{turns:[],omittedTurns:0},untrustedEvidence:[]};c.traces.push({id:'trace-demo-partial',at:'2026-10-20T09:25:00Z',model:'demo-text (pre-recorded synthetic fixture)',partial:true,oldestSeq:41,events:[{seq:41,type:'run.started',at:'2026-10-20T09:25:00Z',payload:{fixture:true,runId:'trace-demo-partial'}},{seq:42,type:'context.assembled',at:'2026-10-20T09:25:01Z',payload:{prompt:JSON.stringify(context)}},{seq:43,type:'model.started',at:'2026-10-20T09:25:02Z',payload:{provider:'demo-cloud',model:'demo-text',fixture:true}},{seq:44,type:'tool.completed',at:'2026-10-20T09:25:03Z',tool:'material_read',status:'succeeded',payload:{result:{items:[{id:'m2',ref:'material:m2',title:'Retained research excerpt',text:'RETENTION FIXTURE: this captured excerpt remains independent of the current material body.',textRange:{offset:80,total:320}}]}}},{seq:45,type:'tool.completed',at:'2026-10-20T09:25:04Z',tool:'material_read',status:'failed',payload:{error:'Synthetic missing-original receipt; no readable body was returned.'}},{seq:46,type:'tool.completed',at:'2026-10-20T09:25:05Z',tool:'memory_read',status:'succeeded',truncated:true,payload:{retainedPrefix:'Truncated fixture; full tool return is unavailable.'}},{seq:47,type:'run.failed',at:'2026-10-20T09:25:06Z',payload:{reason:'Fixture validation failed after a measured model request.'}}]});}}return c.traces||[];}
  function traceEvents(trace){return trace.events.map((e,index)=>e.type?{...copy(e),runId:trace.id}:{seq:index+1,at:trace.at,runId:trace.id,type:e.kind==='context'?'context.assembled':e.kind==='model'?'model.started':e.kind==='tool read'?'tool.completed':'recorded.event',status:e.kind==='tool read'?'succeeded':undefined,payload:{recordedText:e.text},legacy:true});}
  function recordedContext(e){if(e.truncated||e.type!=='context.assembled'||typeof e.payload?.prompt!=='string')return null;try{const c=JSON.parse(e.payload.prompt);return c&&typeof c.request==='string'&&(!c.untrustedMemoryLeads||Array.isArray(c.untrustedMemoryLeads)&&c.untrustedMemoryLeads.every(m=>m&&['id','title','statement'].every(k=>typeof m[k]==='string')))?c:null;}catch{return null;}}
  function recordedReads(e){if(e.truncated||e.type!=='tool.completed'||e.status==='failed')return [];const data=e.payload?.result?.items;return Array.isArray(data)?data.filter(r=>r&&typeof r.text==='string'):[];}
  function eventName(type){return T(...({'run.started':['运行开始','Run started'],'context.assembled':['首次上下文','Initial context'],'model.started':['模型请求','Model request'],'tool.completed':['工具返回','Tool return'],'run.failed':['运行失败','Run failed']}[type]||[type,type]));}
  function tracePage(){const all=retained(),d=draft('trace',{run:C().traceRun||'',requested:'',page:0}),selected=C().traceRun||'',trace=all.find(t=>t.id===selected),events=(selected?(trace?traceEvents(trace):[]):all.flatMap(traceEvents)),size=2,page=Math.max(0,Math.min(Number(d.page)||0,Math.max(0,Math.ceil(events.length/size)-1)));d.page=page;return '<article class="cs-task"><div class="actions">'+L(T('可访问目录与首次预览','Accessible catalog and initial preview'),'settings/agent-scope')+'</div>'+N(T('以下是预先保留的合成输入记录，不代表原型发生了模型调用。缺失、截断或过期的记录不能由当前目录、记忆或预览补造。','These are prerecorded synthetic input records, not model calls made by this prototype. Missing, truncated, or expired records cannot be reconstructed from current catalogs, memory, or previews.'))+message('trace')+F(select('trace','run',T('保留的运行记录','Retained run'),d.run,[['','全部保留事件','All retained events'],...all.map(t=>[t.id,t.at+' · '+t.id,t.at+' · '+t.id])],'cs32-trace-run')+input('trace','requested',T('或输入运行 ID','Or enter a run ID'),d.requested||'','text','','cs32-trace-requested'))+'<div class="actions">'+B(T('打开实际轨迹','Open actual trace'),'trace-open','primary')+B(T('刷新保留记录','Refresh retained records'),'trace-refresh','text')+'</div>'+(selected?facts([[T('当前读取的运行','Currently inspected run'),U(selected)],[T('保留模型 / 时间','Retained model / time'),trace?U(trace.model)+' / '+U(trace.at):T('没有保留记录','No retained record')]]):'<h3>'+T('全部保留事件','All retained events')+'</h3>')+(trace?.partial?N(T('这是部分保留的轨迹。更早事件已不在保留范围；记录中的片段范围不能证明完整读取范围。','This trace is partially retained. Earlier events are outside retention; recorded excerpt ranges cannot establish the complete read scope.'),'warn'):'')+(!events.length?N(T('没有此运行的详细记录。需要事先启用详细 Agent 记录；缺失、截断或过期内容不能从当前记忆补造。','No detailed record exists for this run. Detailed Agent tracing must have been enabled beforehand; missing, truncated, or expired contents cannot be fabricated from current memory.'),'warn'):events.slice(page*size,page*size+size).map(e=>{const context=recordedContext(e),reads=recordedReads(e);return '<section class="cs-zone" data-cs34-event="'+esc(e.runId+'-'+e.seq)+'"><h3>'+eventName(e.type)+'</h3><p class="small">#'+e.seq+' · '+U(e.at)+' · '+U(e.runId)+(e.tool?' · '+U(e.tool):'')+'</p>'+(e.truncated?N(T('记录已截断，不能还原完整输入，也不从截断返回中推定实际读取内容。','This record is truncated. Full input cannot be restored, and actual reads are not inferred from a truncated return.'),'warn'):'')+(e.type==='tool.completed'?'<p>'+T(e.status==='failed'?'读取失败：没有可确认的返回正文。':'工具调用已完成，以下仅是保留部分。',e.status==='failed'?'Read failed: no returned body can be established.':'The tool call completed; only the retained portion is shown.')+'</p>':'')+(context?contextContents(context):'')+(e.legacy?'<p class="cs-preserve" data-user-content>'+esc(e.payload.recordedText)+'</p><p class="small">'+T('旧合成记录只保留这段文本；未记录的字段保持缺失。','This legacy fixture retained only this text; unrecorded fields remain absent.')+'</p>':'')+reads.map((r,i)=>details('trace-read-'+e.runId+'-'+e.seq+'-'+i,U(r.title||r.ref||r.id)+' · '+T('本次实际返回的保留内容','Retained content returned by this call'),'<p class="small">'+T('记录范围 ','Recorded range ')+(r.textRange?.offset??0)+'–'+((r.textRange?.offset??0)+r.text.length)+' / '+(r.textRange?.total??r.text.length)+T(' 个字符；没有推补其余正文',' characters; no remaining body is reconstructed')+'</p><div class="cs-preserve" data-user-content>'+esc(r.text)+'</div>')).join('')+details('trace-raw-'+e.runId+'-'+e.seq,T('查看保留的事件载荷','Inspect retained event payload'),'<pre class="cs34-json" data-user-content>'+esc(JSON.stringify(e.payload,null,2))+'</pre>')+'</section>';}).join(''))+'<div class="form-actions">'+B(T('返回第一页','First page'),'trace-first','text',page?'':'disabled')+B(T('上一页内容','Previous content'),'trace-page','text','data-offset="-1" '+(page?'':'disabled'))+'<span>'+(page+1)+' / '+Math.max(1,Math.ceil(events.length/size))+'</span>'+B(T('下一页内容','Next content'),'trace-page','text','data-offset="1" '+((page+1)*size<events.length?'':'disabled'))+'</div></article>';}
  const previousPerform34=window.performCentralSemantics32;
  window.performCentralSemantics32=async function(action,el){
    remember();
    if(action.startsWith('usage-')){const u=usage(),d=draft('usage',u.filters);
      if(action==='usage-apply'){if(!/^\d{4}-\d{2}-\d{2}$/.test(d.from)||!/^\d{4}-\d{2}-\d{2}$/.test(d.to)||!Number.isFinite(Date.parse(d.from))||!Number.isFinite(Date.parse(d.to))||d.from>d.to)return result('usage',T('请填写有效日期，开始日期不能晚于结束日期。当前结果与草稿均保留。','Enter valid dates with the start no later than the end. Current results and the draft remain.'),true);const filters=copy(d);delete filters.modelChoice;u.filters=filters;u.page=1;return result('usage',T('已读取这个范围的合成账本，缺失指标仍显示未知。','The synthetic ledger for this scope is shown; missing measurements remain unknown.'));}
      if(action==='usage-clear'){u.filters={...u.filters,agentId:'',moduleId:'',skillId:'',provider:'',model:'',status:''};C().drafts.usage=copy(u.filters);u.page=1;return redraw();}
      if(action==='usage-preset'){const from=new Date(fixtureDay+'T00:00:00Z');from.setUTCDate(from.getUTCDate()-Number(el.dataset.days)+1);u.filters={...u.filters,from:from.toISOString().slice(0,10),to:fixtureDay};C().drafts.usage=copy(u.filters);u.page=1;return redraw();}
      if(action==='usage-refresh'){u.readAt=stamp();return result('usage',T('已刷新保留的合成用量记录；未上报数据没有补算。','Retained synthetic usage was refreshed; unreported data was not backfilled.'));}
      if(action==='usage-page'){u.page=Math.max(1,u.page+Number(el.dataset.delta));return redraw();}
      if(action==='usage-day'){u.filters.from=u.filters.to=el.dataset.date;C().drafts.usage=copy(u.filters);u.page=1;return redraw();}
      if(action==='usage-group'){const key=el.dataset.key;if(u.groupBy==='model'){const row=u.rows.find(r=>r.provider+' / '+r.model===key);if(row){u.filters.provider=row.provider;u.filters.model=row.model;}}else{u.filters[u.groupBy]=key;if(u.groupBy==='provider')u.groupBy='model';}C().drafts.usage=copy(u.filters);u.page=1;return redraw();}
      if(action==='usage-trace'){const r=u.rows.find(r=>r.id===el.dataset.id);C().traceRun=r?.traceId||r?.id||'';C().drafts.trace={run:C().traceRun,requested:'',page:0};persist();go('settings/agent-events');return true;}
    }
    if(action.startsWith('price-')){const u=usage(),d=priceDraft();
      if(action==='price-load'){u.priceDrafts||={};u.priceDrafts[d.provider+'/'+d.model]=copy(d);const p=u.prices.find(p=>p.provider===el.dataset.provider&&p.model===el.dataset.model);if(p)C().drafts.prices=copy(u.priceDrafts[p.provider+'/'+p.model]||{...p,originalKey:p.provider+'/'+p.model});return redraw();}
      if(action==='price-reload'){const p=u.prices.find(p=>p.provider===d.provider&&p.model===d.model);if(!p)return result('prices',T('这组 ID 没有已保存价格，草稿保留。','No saved price exists for these IDs; the draft remains.'),true);C().drafts.prices={...copy(p),originalKey:p.provider+'/'+p.model};return result('prices',T('已重新读取这组 ID 的保存价格。','Saved prices for these IDs were reloaded.'));}
      if(action==='price-save'){const provider=String(d.provider||'').trim(),model=String(d.model||'').trim();if(!provider||!model)return result('prices',T('服务 ID 和模型 ID 均不能为空；草稿保留。','Both provider and model IDs are required; the draft remains.'),true);if(!['USD','CNY'].includes(d.currency)||priceKeys.some(k=>d[k]===''||!known(Number(d[k]))||Number(d[k])<0||Number(d[k])>1000000))return result('prices',T('四种单价都需为 0–1,000,000 的有限数值。空白是未知，不会按零保存。','All four prices must be finite values from 0 to 1,000,000. Blank means unknown and is not saved as zero.'),true);const old=u.prices.find(p=>p.provider===provider&&p.model===model);if(old&&d.originalKey===provider+'/'+model&&old.revision!==d.revision)return result('prices',T('保存版本已变化，草稿保留；请明确重新读取后再编辑。','The saved revision changed. The draft remains; explicitly reload before editing.'),true);const saved={provider,model,currency:d.currency,...Object.fromEntries(priceKeys.map(k=>[k,Number(d[k])])),revision:(old?.revision||0)+1,savedAt:stamp()};if(old)Object.assign(old,saved);else u.prices.push(saved);C().drafts.prices={...copy(saved),originalKey:provider+'/'+model};return result('prices',T('已保存四种单价，供之后开始的运行使用。历史估算与开始时价格保持原值。','All four prices were saved for future runs. Historical estimates and their pinned start-time prices remain unchanged.'));}
    }
    if(action.startsWith('agent-')){const a=agent();
      if(action==='agent-tab'){a.tab=el.dataset.tab;return redraw();}
      if(action==='agent-scope-apply'){const d=draft('agent-scope',a.scope);if([d.after,d.before].some(v=>v&&!Number.isFinite(utcTime(v)))||d.after&&d.before&&utcTime(d.after)>utcTime(d.before))return result('agent-scope',T('请填写有效时间，开始不能晚于结束。当前范围与草稿保留。','Enter valid times with the start no later than the end. Current scope and draft remain.'),true);a.scope=copy(d);a.page=0;a.selected=null;a.source='';a.back=[];return result('agent-scope',T('当前浏览范围已更新。上次首次上下文预览仍单独保留。','The inspection scope was updated. The prior initial-context preview remains separate.'));}
      if(action==='agent-scope-clear'){a.scope={deviceId:'',after:'',before:''};C().drafts['agent-scope']=copy(a.scope);a.page=0;a.selected=null;a.source='';a.back=[];return redraw();}
      if(action==='agent-directory'){if(!['/context',...dirs.map(d=>d[0])].includes(el.dataset.path))return true;a.path=el.dataset.path;a.source='';a.page=0;a.selected=null;a.back=[];return redraw();}
      if(action==='agent-entry'){if(el.dataset.kind==='source'){a.source=el.dataset.id;a.page=0;a.selected=null;}else{a.selected={kind:el.dataset.kind,id:el.dataset.id};a.offset=0;a.back=[];}return redraw();}
      if(action==='agent-source-back'){a.source='';a.page=0;a.selected=null;return redraw();}
      if(action==='agent-list-page'){a.page=Math.max(0,a.page+Number(el.dataset.delta));a.selected=null;a.offset=0;return redraw();}
      if(action==='agent-body-next'){a.offset=Number(el.dataset.offset)||0;return redraw();}
      if(action==='agent-body-first'){a.offset=0;return redraw();}
      if(action==='agent-entry-close'){a.selected=null;a.back=[];a.offset=0;return redraw();}
      if(action==='agent-evidence'){a.back.push({selected:copy(a.selected),offset:a.offset});a.selected={kind:'material',id:el.dataset.id};a.offset=0;return redraw();}
      if(action==='agent-entry-back'){const last=a.back.pop();if(last){a.selected=last.selected;a.offset=last.offset;}return redraw();}
      if(action==='agent-preview'){const d=draft('agent-preview',{question:''});if(d.question.length>4000)return result('agent-preview',T('问题最多 4,000 字符；草稿保留。','Questions may contain at most 4,000 characters; draft retained.'),true);a.preview={at:stamp(),fingerprint:previewFingerprint(),context:{request:d.question,selectedTimeRange:{after:a.scope.after||undefined,before:a.scope.before||undefined},selectedDeviceId:a.scope.deviceId||undefined,timeZone:'UTC',untrustedMemoryLeads:memoryEntries().slice(0,8).map(m=>({id:'memory:'+m.id,title:m.title,statement:m.statement,uncertainty:m.uncertainty})),conversation:{turns:[],omittedTurns:0},untrustedEvidence:[]},system:'Synthetic preview: personal material is untrusted evidence. Use read-only context tools; preserve provenance and uncertainty. No model request is made.',tools:[{name:'material_catalog',readOnly:true,fixtureDefinition:true},{name:'memories',readOnly:true,fixtureDefinition:true},{name:'material_read',readOnly:true,fixtureDefinition:true},{name:'attribution_context',readOnly:true,fixtureDefinition:true}]};return result('agent-preview',T('合成预览已生成：模型调用 0。实际输入记录没有因此新增。','Synthetic preview generated: 0 model calls. No actual-input record was added.'));}
    }
    if(action==='trace-open'){const d=draft('trace',{});C().traceRun=String(d.requested||d.run||'').trim();d.page=0;return redraw();}
    if(action==='trace-refresh')return result('trace',T('已重新读取保留的合成快照，没有从当前内容重建缺失记录。','Retained synthetic snapshots were reloaded without reconstructing missing records from current content.'));
    if(action==='trace-page'){const d=draft('trace',{});d.page=Math.max(0,Number(d.page||0)+Number(el.dataset.offset));return redraw();}
    if(action==='trace-first'){draft('trace',{}).page=0;return redraw();}
    return previousPerform34?previousPerform34(action,el):false;
  };
  const previousDetail34=settingsDetail;
  settingsDetail=function(id){if(id==='usage')return usagePage();if(id==='usage-prices')return pricePage();if(id==='agent-scope')return agentPage();if(id==='agent-events'){previousDetail34(id);return tracePage();}return previousDetail34(id);};
  const guide34={C41:{route:'settings/usage',title:['核对模型用量和估算费用','Inspect model usage and cost estimates'],purpose:['按运行归属筛选已知消耗，分别查看币种、缺失数据和历史回执。','Filter known consumption by recorded attribution and inspect separate currencies, missing data, and historical receipts.']},A33:{route:'settings/usage-prices',title:['维护后续运行估价','Maintain future-run prices'],purpose:['保存四种 token 单价，保持历史运行的固定价格与费用。','Save four token price categories while preserving historical pinned prices and costs.']},A26:{route:'settings/agent-scope',title:['查看 Agent 可访问目录与首次上下文','Inspect Agent-accessible catalogs and initial context'],purpose:['按设备和时间浏览只读目录、展开正文依据，单独预览新对话的首次输入。','Browse scoped read-only catalogs, expand body evidence, and separately preview initial input for a new conversation.']},A27:{route:'settings/agent-events',title:['查看保留的实际输入与读取','Inspect retained input and reads'],purpose:['按运行检查保留的上下文、模型与工具事件，保持缺失和截断边界。','Inspect retained context, model, and tool events by run while preserving missing and truncated-record boundaries.']}};
  for(const [id,value] of Object.entries(guide34)){const item=DIRECTORY.find(x=>x.id===id);if(item){item.title=value.title[0];item.purpose=value.purpose[0];item.route=value.route;}const unit=CATALOG.directory?.find(x=>x.id===id);if(unit){unit.title=value.title[0];unit.description=value.purpose[0];unit.destination={page:'settings',view:value.route.split('/')[1],href:'#/'+value.route};}}
  const previousFeature34=featurePage;
  featurePage=function(){const v=guide34[state.page.split('/')[1]];return v?heading(T(...v.title),T(...v.purpose),L(T('打开具体操作','Open controls'),v.route,'primary')):previousFeature34();};
  function capture34(el){const name=el.dataset.cs34Form,key=el.dataset.cs34Key;if(!name)return false;if(name==='usage-view'){const u=usage();u[key]=key==='pageSize'?Number(el.value):el.value;u.page=1;persist();return true;}const d=draft(name,{});d[key]=el.value;if(name==='usage'&&key==='modelChoice'){const selected=usage().rows.find(r=>r.provider+' / '+r.model===el.value);d.provider=selected?.provider||'';d.model=selected?.model||'';}if(name==='trace'&&key==='run')d.requested='';delete C().messages[name];persist();return true;}
  document.addEventListener('input',e=>capture34(e.target));
  document.addEventListener('change',e=>{if(!capture34(e.target))return;if(e.target.dataset.cs34Form==='usage-view')redraw();});
  const previousEnhance34=window.enhanceCentralSemantics;
  window.enhanceCentralSemantics=function(){if(previousEnhance34)previousEnhance34();const routes={usage:['用量与费用','Usage and cost','按运行归属核对已上报用量与分币种估算。','Inspect measured usage and separate-currency estimates by recorded execution attribution.'],'usage-prices':['后续运行的模型价格','Model prices for future runs','保存每百万 token 价格，保留历史运行估算。','Save per-million-token prices while preserving historical run estimates.'],'agent-scope':['Agent 视角','Agent view','浏览可访问目录，并单独预览首次上下文。','Browse accessible catalogs and separately preview initial context.'],'agent-events':['实际输入与读取轨迹','Retained input and read traces','只查看已保留的输入与工具返回。','Inspect retained input and tool returns.']},r=routes[state.page.split('/')[1]];if(r){const h=document.querySelector('.settings-content>.section-head h2'),p=document.querySelector('.settings-content>.section-head p');if(h)h.textContent=T(r[0],r[1]);if(p)p.textContent=T(r[2],r[3]);}};
})();
