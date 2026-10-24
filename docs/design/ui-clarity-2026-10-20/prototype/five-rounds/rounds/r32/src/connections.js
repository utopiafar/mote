(function(){
  'use strict';
  const t=(zh,en)=>state.language==='en'?en:zh;
  const supported=['nas','google','gmail','mcp','lark','recordings'];
  const names={nas:['外部文件 / NAS 引用','External / NAS reference'],google:['Google 日历','Google Calendar'],gmail:['Gmail','Gmail'],mcp:['MCP 资料服务','MCP resources'],lark:['飞书文档与日历','Lark documents and calendars'],recordings:['厂商录音','Vendor recordings']};
  const clone=x=>JSON.parse(JSON.stringify(x));
  const B=(label,action,kind='subtle',attrs='')=>button(label,'cn-'+action,attrs,kind);
  const G=(label,page,kind='text')=>goButton(label,page,kind);
  const D=(id,title,body,open=false)=>'<details class="focus-disclosure" id="cn-'+id+'" '+(open?'open':'')+'><summary>'+title+'</summary><div class="focus-disclosure-body">'+body+'</div></details>';
  const F=(key,label,value,type='text',hint='')=>'<label class="field"><span>'+label+'</span><input class="field-input" id="cn-'+key+'" data-cn-field="'+key+'" type="'+type+'" value="'+esc(value??'')+'">'+(hint?'<small>'+hint+'</small>':'')+'</label>';
  const T=(key,label,value,hint='')=>'<label class="field"><span>'+label+'</span><textarea class="field-input" id="cn-'+key+'" data-cn-field="'+key+'" rows="3" maxlength="12000">'+esc(value??'')+'</textarea>'+(hint?'<small>'+hint+'</small>':'')+'</label>';
  const C=(key,label,value)=>'<label class="checkrow"><input type="checkbox" id="cn-'+key+'" data-cn-field="'+key+'" '+(value?'checked':'')+'><span>'+label+'</span></label>';
  const S=(key,label,value,options)=>'<label class="field"><span>'+label+'</span><select class="field-input" id="cn-'+key+'" data-cn-field="'+key+'">'+options.map(o=>'<option value="'+o[0]+'" '+(String(value)===o[0]?'selected':'')+'>'+t(o[1],o[2]||o[1])+'</option>').join('')+'</select></label>';
  function init(){state.sourceConfigs||={};state.cn||={connections:{},drafts:{},tabs:{},active:{},message:{}};return state.cn;}
  function route(){const p=state.page.split('/');return{kind:p[1],id:p[2]};}
  function defaults(kind,id){return{id:id||kind+'-personal',kind,title:t(...names[kind]),clientId:'',secretMode:'keep',secret:'',hasSecret:false,callback:'https://mote.example.invalid/auth/callback',region:'cn',auto:false,interval:15,auth:'unconfigured',saved:false,enabled:false,selection:[],url:'',token:'',context:'',contextVersion:0,start:'2026-10-01',end:'2026-10-23',vendor:'lark',past:30,future:90,timezone:'Asia/Shanghai',lookback:30,activityOpened:true,activityEdited:false,activityCreated:false,documents:'',folders:'',wiki:'',exclusions:'',results:[],counts:{added:0,duplicate:0,transcript:0,audio:0,pending:0,failed:0},moreHistory:false,records:[],fixture:'resources',phase:'idle'};}
  function current(){
    const c=init(),{kind,id}=route();c.active[kind]=id||c.active[kind]||kind+'-personal';const key=kind+':'+c.active[kind];
    const saved=c.connections[key]||defaults(kind,c.active[kind]);
    c.drafts[key]||=clone(saved);
    const sid='cn-'+kind+'-'+saved.id,context=state.sourceConfigs?.[sid],version=state.focus?.sourceVersions?.[sid];
    if(context&&version>saved.contextVersion){const previous=saved.context;saved.context=context.contextDescription||'';saved.contextVersion=version;if(c.drafts[key].context===previous)c.drafts[key].context=saved.context;c.drafts[key].contextVersion=version;}
    return{c,key,kind,saved,d:c.drafts[key]};
  }
  function msg(text,error=false){const x=current();x.c.message[x.key]={text,error};persist();render();}
  function message(x){const m=x.c.message[x.key];return m?'<p class="notice '+(m.error?'warn':'good')+'" role="status">'+esc(m.text)+'</p>':'';}
  function save(x){x.c.connections[x.key]=x.saved;persist();}
  function sourceId(x){return'cn-'+x.kind+'-'+x.saved.id;}
  function register(x){const id=sourceId(x),old=state.sources.find(s=>s.id===id),row={id,title:x.saved.title||t(...names[x.kind]),type:x.kind,device:'中央连接',desc:t('独立连接 · ','Connection · ')+x.saved.id,status:x.saved.enabled?t('已启用接收','Receiving'):t('未启用接收','Intake disabled')};if(old)Object.assign(old,row);else state.sources.push(row);state.cn.routes||={};state.cn.routes[id]='setup/'+x.kind+'/'+x.saved.id;state.sourceConfigs[id]={...(state.sourceConfigs[id]||{}),contextDescription:x.saved.context};state.focus||={};state.focus.sourceVersions||={};state.focus.sourceVersions[id]=x.saved.contextVersion;}
  const priorSourceRoute=sourceSetupRoute;
  sourceSetupRoute=function(id){return state.cn?.routes?.[id]||priorSourceRoute(id);};
  function nav(x){
    const tab=x.c.tabs[x.key]||'connection';
    return'<nav class="cn-tabs" aria-label="'+t('来源设置步骤','Source settings steps')+'">'+[['connection','连接','Connection'],['scope','选择范围','Choose scope'],['results','查看结果','Results']].map(([id,zh,en])=>B(t(zh,en),'tab',tab===id?'primary':'text','data-tab="'+id+'" aria-current="'+(tab===id?'page':'false')+'"')).join('')+'</nav>';
  }
  function status(x){
    const labels={unconfigured:['等待保存连接','Save connection first'],ready:['等待授权','Authorization needed'],pending:['等待授权回执','Awaiting authorization'],connected:['已授权 · 尚未选择接收范围','Authorized · choose intake scope'],expired:['授权已过期','Authorization expired'],cancelled:['授权已取消','Authorization cancelled'],missing_cli:['部署环境缺少 CLI','Deployment CLI is missing']};
    const q=x.saved.enabled?[t('接收中','Receiving'),t('接收中','Receiving')]:labels[x.saved.auth]||labels.unconfigured;
    return'<div class="cn-status"><div><strong>'+t(...q)+'</strong><p>'+esc(x.saved.id)+(x.saved.simulated?' · '+t('合成回执','Synthetic receipt'):'')+'</p></div>'+(x.saved.enabled?B(t('暂停接收','Pause intake'),'pause'):'')+'</div>';
  }
  function switcher(x){
    const rows=Object.values(x.c.connections).filter(c=>c.kind===x.kind);
    if(rows.length<1)return'';
    return D('connections',t('其他连接','Other connections'),rows.map(v=>'<div class="cn-row"><span>'+esc(v.id)+'</span>'+G(t('打开','Open'),'setup/'+v.kind+'/'+v.id)+'</div>').join('')+B(t('新增独立连接','Add separate connection'),'new','text'));
  }
  function authForm(x){
    const d=x.d,google=['google','gmail'].includes(x.kind),lark=x.kind==='lark',rec=x.kind==='recordings';
    const title=lark?t('应用与授权','Application and authorization'):t('连接信息','Connection information');
    return'<section class="focus-zone"><h2>'+title+'</h2>'+F('id',t('连接 ID','Connection ID'),d.id)+
      (rec?S('vendor',t('录音厂商','Recording vendor'),d.vendor,[['lark','飞书录音','Lark recordings'],['plaud','PLAUD','PLAUD'],['dingtalk','钉钉录音','DingTalk recordings']]):'')+
      F('clientId',google?t('OAuth 客户端 ID','OAuth client ID'):t('应用 ID','App ID'),d.clientId)+
      D('credentials',t('凭据与回调地址','Credentials and callback'),S('secretMode',t('客户端密钥','Client secret'),d.secretMode,[['keep','保留已保存的密钥','Keep saved secret'],['replace','替换密钥','Replace secret'],['clear','清除密钥','Clear secret']])+F('secret',t('新密钥（替换时填写）','New secret (when replacing)'),d.secret,'password')+'<p class="small">'+t(x.saved.hasSecret?'已有已保存密钥，不回显。':'尚未保存密钥。',x.saved.hasSecret?'A saved secret exists and is not redisplayed.':'No saved secret.')+'</p>'+F('callback',t('授权回调地址','Authorization callback URL'),d.callback,'url')+
      (lark?S('region',t('区域','Region'),d.region,[['cn','飞书中国','Feishu China'],['global','Lark 国际','Lark Global']]):''))+
      '<div class="actions">'+B(t('保存连接','Save connection'),'save-connection','primary')+B(t('填入演示连接','Use a demo connection'),'demo-config','text')+'</div></section>'+
      (x.saved.saved?'<section class="focus-zone"><h2>'+t('授权','Authorization')+'</h2><p>'+t(google?'授权后仍需选择范围并启用接收。Gmail 连接需要部署项目启用 Gmail API。':lark?'文档与日历使用独立只读权限；录音授权单独管理。CLI 由部署管理员安装。':'录音使用厂商独立权限；不沿用文档或日历的授权。实际账号仍需在正式环境验证。',google?'Choose scope and enable intake after authorization. Gmail needs the Gmail API enabled in the deployment project.':lark?'Documents and calendars use separate read scopes. Recording authorization is separate. The deployment administrator installs the CLI.':'Recordings use separate vendor scopes, independent of document or calendar authorization. Verify a real account in the deployed application.')+'</p>'+
      (x.saved.auth==='pending'?'<p>'+t('授权链接已准备，等待回执。','Authorization link prepared; awaiting a receipt.')+'</p><p class="small cn-wrap">https://authorization.example.invalid/'+esc(x.saved.id)+'</p><div class="actions">'+B(t('复制授权链接','Copy authorization link'),'copy-auth')+B(t('取消授权','Cancel authorization'),'cancel-auth','text')+'</div>':'<div class="actions">'+B(t(x.saved.auth==='connected'?'更换账号 / 重新授权':'开始授权',x.saved.auth==='connected'?'Change account / reauthorize':'Authorize'),'authorize','primary')+B(t('刷新授权状态','Refresh authorization'),'refresh-auth','text')+(lark?B(t('重新检查部署环境','Recheck deployment'),'environment','text'):'')+'</div>')+
      D('auth-demo',t('预览授权回执','Preview authorization receipts'),'<p class="small">'+t('原型不连接真实账号。以下按钮模拟服务端回执。二维码在离线原型中不可用，可复制上方链接；不是有效授权链接。','This prototype does not connect a real account. Buttons simulate server receipts. Offline QR is unavailable; the link above is not a valid authorization URL.')+'</p>'+B(t('模拟授权成功','Simulate authorization success'),'auth-success')+B(t('模拟授权过期','Simulate expiry'),'auth-expired')+(lark?B(t('模拟 CLI 缺失','Simulate missing CLI'),'auth-missing','text'):'')+
      (lark?'<p>'+t('部署准备：由管理员安装并配置 Lark CLI，提供所需的文档/日历读取权限，再回来重新检查。网页不能代替部署安装。','Deployment preparation: the administrator installs and configures Lark CLI and read scopes; then recheck here.')+'</p>':''))+'</section>':'')+switcher(x);
  }
  function controls(x){return D('receiving',t('持续接收与连接管理','Continuous intake and connection management'),C('auto',t('后台定期同步','Sync in the background'),x.d.auto)+F('interval',t('同步间隔（分钟）','Sync interval (minutes)'),x.d.interval,'number')+'<div class="actions">'+B(t('保存并启用接收','Save and enable intake'),'enable','primary')+B(t('停止后续接收','Stop future intake'),'stop','text')+B(t('断开授权','Disconnect authorization'),'disconnect','text')+B(t('移除这条连接','Remove this connection'),'remove','text')+'</div><p class="small">'+t('暂停、停止、断开或移除连接都会保留此前归档；删除历史资料需到资料库另行确认。','Pause, stop, disconnect and removing a connection retain the archive. Deleting archived material requires separate confirmation in the library.')+'</p>');}
  function calendarScope(x){
    const d=x.d,lark=x.kind==='lark',list=x.saved.calendarsListed;
    return'<section class="focus-zone"><h2>'+t('选择只读日历','Choose read-only calendars')+'</h2><p>'+t('授权本身不会收集日程。这里只把所选日历归档；写入日程需要单独连接并确认。','Authorization alone does not collect events. This is read-only archiving; calendar writing requires a separate connection and confirmation.')+'</p>'+
      B(t('读取可选日历','List available calendars'),'list-calendars')+
      (list?'<div class="cn-check-list">'+[['work','工作日历','Work calendar'],['personal','个人日历','Personal calendar'],['unavailable','已不可用的旧日历','Unavailable old calendar']].map(([id,zh,en])=>'<label class="checkrow"><input type="checkbox" data-cn-select="'+id+'" '+(d.selection.includes(id)?'checked':'')+' '+(id==='unavailable'&&!d.selection.includes(id)?'disabled':'')+'><span>'+t(zh,en)+'</span></label>').join('')+'</div>':'')+
      (lark?D('calendar-window',t('时间范围与全天时区','Time window and all-day timezone'),F('past',t('过去天数','Past days'),d.past,'number')+F('future',t('未来天数','Future days'),d.future,'number')+F('timezone',t('全天事件时区','All-day timezone'),d.timezone)):'')+
      '<div class="actions">'+B(t('保存日历范围','Save calendar scope'),'save-calendars','primary')+B(t('同步所选日历','Sync selected calendars'),'sync-calendars')+'</div><p class="small">'+t('已保存范围：','Saved scope: ')+esc(x.saved.selection.join(', ')||t('未选择','None selected'))+'</p></section>';
  }
  function docsScope(x){
    const d=x.d;
    return'<section class="focus-zone"><h2>'+t('发现并归档文档','Discover and archive documents')+'</h2>'+
      '<p>'+t('活动记录用于发现候选文档；打开过不代表阅读或认同。明确选择的文档、文件夹和知识库会持续跟踪，排除项优先。','Activity discovers candidate documents. Opening is not evidence of reading or endorsement. Explicit documents, folders and wiki branches are tracked continuously; exclusions take precedence.')+'</p>'+
      D('doc-activity',t('从哪些活动发现文档','Discover from activity'),C('activityOpened',t('打开过','Opened'),d.activityOpened)+C('activityEdited',t('编辑过','Edited'),d.activityEdited)+C('activityCreated',t('创建过','Created'),d.activityCreated)+F('lookback',t('首次回看天数','Initial lookback days'),d.lookback,'number'))+
      D('doc-explicit',t('明确跟踪与排除的范围','Explicit tracking and exclusions'),T('documents',t('文档 ID / URL（每行一个）','Document IDs / URLs (one per line)'),d.documents)+T('folders',t('文件夹 ID（每行一个）','Folder IDs (one per line)'),d.folders)+T('wiki',t('知识库分支（每行一个）','Wiki branches (one per line)'),d.wiki)+T('exclusions',t('排除的文档 ID（优先）','Excluded document IDs (take precedence)'),d.exclusions))+
      '<div class="actions">'+B(t('保存发现范围','Save discovery scope'),'save-docs','primary')+B(t('预览发现结果','Preview discovered documents'),'preview-docs')+'</div>'+
      (x.saved.discovery?'<div class="cn-receipt"><h3>'+t('待归档的文档 · 尚未读取正文','Discovered documents · body not read')+'</h3>'+x.saved.discovery.map(v=>'<p>'+esc(v.id)+' · '+esc(v.title)+(v.excluded?' · '+t('已排除','Excluded'):'')+'</p>').join('')+B(t('确认归档未排除的文档','Archive the included documents'),'archive-docs','primary')+'</div>':'')+'</section>'+
      D('lark-calendars',t('日历读取范围','Calendar read scope'),calendarScope(x));
  }
  function recordingScope(x){
    const d=x.d,dirty=d.context!==x.saved.context;
    return'<section class="focus-zone"><h2>'+t('先说明这些录音是什么','Describe the recordings first')+'</h2>'+T('context',t('录音内容与说话人说明','Recording context and speakers'),d.context,t('例如谁在讲话、会议背景、哪些话属于你。','Describe speakers, meeting context and which speech is yours.'))+
      '<div class="actions">'+B(t('保存录音资料说明','Save recording context'),'save-context','primary')+'</div><p class="small" role="status">'+(x.saved.contextVersion?t('中央已确认 · 版本 ','Central acknowledged · version ')+x.saved.contextVersion:t('说明尚未确认','Context not yet acknowledged'))+(dirty?' · '+t('有未保存修改','Unsaved changes'):'')+'</p>'+
      (x.saved.contextVersion?'<p class="focus-pre">'+esc(x.saved.context||t('未填写说明','No description supplied'))+'</p>':'')+'</section>'+
      '<section class="focus-zone"><h2>'+t('选择首次接收的范围','Choose initial intake range')+'</h2><div class="cn-grid">'+F('start',t('开始日期','Start date'),d.start,'date')+F('end',t('结束日期','End date'),d.end,'date')+'</div><div class="actions">'+B(t('保存范围并开始同步','Save range and start sync'),'start-recordings','primary')+'</div><p class="small">'+t('说明经中央确认后才启用接收。文稿归档与音频备份分别报告结果。','Intake starts only after context acknowledgement. Transcript archiving and audio backup report separate results.')+'</p></section>';
  }
  function scopePage(x){
    if(x.saved.auth!=='connected')return'<section class="focus-zone"><h2>'+t('先完成这条连接的授权','Authorize this connection first')+'</h2><p>'+t('草稿与已归档资料保留。授权成功后再选择接收范围。','Drafts and the existing archive are retained. Choose intake scope after authorization.')+'</p>'+B(t('返回连接与授权','Return to connection'),'tab','primary','data-tab="connection"')+'</section>';
    return(x.kind==='lark'?docsScope(x):x.kind==='recordings'?recordingScope(x):x.kind==='google'?calendarScope(x):'<section class="focus-zone"><h2>'+t('归档邮件正文','Archive mail body')+'</h2><p>'+t('保存正文、发件人和时间；附件只保留名称与引用，不代表已下载附件。邮件内容只是资料，不作为 Agent 指令。','Archive body, sender and time. Attachments retain names and references only; attachment bytes are not downloaded. Mail is evidence, not Agent instructions.')+'</p>'+B(t('同步本页邮件','Sync current mail page'),'sync-mail','primary')+'</section>')+controls(x);
  }
  function resultsPage(x){
    const v=x.saved,c=v.counts,records=v.records||[];
    return'<section class="focus-zone"><h2>'+t('这条连接的归档结果','Archive results for this connection')+'</h2><p>'+t('新增 ','New ')+c.added+t(' · 重复 ',' · Duplicates ')+c.duplicate+'</p>'+
      (x.kind==='recordings'?'<dl class="focus-dl"><div><dt>'+t('文稿','Transcripts')+'</dt><dd>'+c.transcript+'</dd></div><div><dt>'+t('音频备份','Audio backups')+'</dt><dd>'+c.audio+'</dd></div><div><dt>'+t('等待 / 失败','Pending / failed')+'</dt><dd>'+c.pending+' / '+c.failed+'</dd></div></dl><p>'+t('厂商后续删除录音，不会删除已经完成的中央音频备份。','Later vendor deletion does not remove completed Central audio backups.')+'</p>':'')+
      (v.results.length?v.results.map((r,i)=>'<div class="cn-row"><div><strong>'+esc(r.title)+'</strong><p>'+esc(r.status)+'</p></div>'+(r.failed?B(t('重试此步骤','Retry this step'),'retry-step','subtle','data-index="'+i+'"'):'')+(r.materialId?G(t('阅读归档','Read archive'),'material/'+r.materialId):'')+'</div>').join(''):'<p>'+t('还没有归档结果。','No archived results yet.')+'</p>')+
      (v.moreHistory?'<p>'+t('还有历史内容未归档，当前结果不是全部。','More history remains; these results are partial.')+'</p>'+B(t('继续下一页历史','Continue history'),'history','primary'):'')+
      (v.phase==='unknown'?'<p class="notice warn">'+t('提交结果未知；保留同一提交 ID，重试不会新建另一批。','Submission result unknown. Keep the same submission ID; retry does not create a second batch.')+'</p>'+B(t('重试同一提交','Retry same submission'),'retry-unknown','primary'):'')+
      '<div class="actions section">'+B(t('刷新结果','Refresh results'),'refresh','text')+B(t('取消当前操作','Cancel current operation'),'cancel-operation','text')+'</div>'+
      D('recorded-materials',t('已保存资料与检查点','Saved materials and checkpoints'),records.map(id=>G(esc(state.materials.find(m=>m.id===id)?.title||id),'material/'+id)).join('')+'<p>'+t('检查点：','Checkpoint: ')+esc(v.checkpoint||t('尚无检查点','No checkpoint'))+'</p>')+'</section>'+
      D('result-demo',t('预览结果状态','Preview result states'),'<p class="small">'+t('合成状态用于核对恢复界面，不连接厂商。','Synthetic states exercise recovery UI without contacting a vendor.')+'</p>'+B(t('模拟空正文','Simulate empty text'),'empty')+B(t('模拟格式不支持','Simulate unsupported format'),'unsupported')+B(t('模拟提交结果未知','Simulate unknown submission'),'unknown')+B(t('模拟自动重试耗尽','Simulate retry exhausted'),'retry-exhausted'));
  }
  function referencePage(x){
    return heading(t(...names.nas),t('记录位置，便于以后从采集端提交可读正文。','Keep a location so a collector can later submit readable content.'),G(t('返回来源','Back to sources'),'sources'))+'<article class="reading focus-task">'+message(x)+'<section class="focus-zone">'+F('title',t('资料名称','Title'),x.d.title)+F('url',t('URI / 文件位置','URI / location'),x.d.url)+B(t('保存外部引用','Save external reference'),'save-reference','primary')+'</section>'+
      (x.saved.saved?'<section class="focus-zone"><h2>'+esc(x.saved.title)+'</h2><p class="cn-wrap">'+esc(x.saved.url)+'</p><p>'+t('记录时间：','Observed: ')+esc(x.saved.observed)+'</p><p>'+t('只保存名称、位置和记录时间，尚未读取远程正文。要分析正文，请在能访问原件的 Mac / Android 采集端选择文件。','Only title, location and observation time are stored. Remote body has not been read. To analyze it, choose the originals on a Mac or Android collector that can access them.')+'</p>'+G(t('到采集端设置','Set up a collector'),'setup/folder/new','primary')+'</section>':'')+'</article>';
  }
  function mcpPage(x){
    const d=x.d;
    return heading(t(...names.mcp),t('选择服务明确公开的资料，一次导入。','Import selected resources explicitly exposed by a service.'),G(t('返回来源','Back to sources'),'sources'))+'<article class="reading focus-task">'+message(x)+'<section class="focus-zone">'+F('title',t('来源名称','Source name'),d.title)+F('url',t('服务 URL','Service URL'),d.url,'url')+D('mcp-token',t('可选的访问凭据','Optional access credential'),F('token',t('Bearer 凭据（选填）','Bearer credential (optional)'),d.token,'password'))+
      '<div class="actions">'+B(t('列出可读资料','List readable resources'),'mcp-list','primary')+B(t('填入演示服务','Use demo service'),'mcp-demo','text')+'</div></section>'+
      (x.saved.listed?'<section class="focus-zone"><h2>'+t('选择要导入的资料','Choose resources to import')+'</h2>'+(x.saved.resources.length?x.saved.resources.map(r=>'<label class="checkrow"><input type="checkbox" data-cn-select="'+r.id+'" '+(d.selection.includes(r.id)?'checked':'')+'><span>'+esc(r.title)+'<small>'+esc(r.uri)+'</small></span></label>').join('')+'<div class="actions">'+B(t('导入所选资料','Import selected'),'mcp-import','primary')+'</div>':'<p>'+t('服务没有公开可读资源。只有工具的 MCP 服务无法在此直接导入。','No readable resources were exposed. A tools-only MCP service cannot be directly imported here.')+'</p>')+'<p class="small">'+t('不会迁移聊天机器人隐藏的记忆，也不会调用对外写入工具。','This does not migrate hidden chatbot memory or invoke external writing tools.')+'</p></section>':'')+
      (x.saved.saved?'<section class="focus-zone"><h2>'+t('本次结果','Import result')+'</h2><p>'+t('新增 ','New ')+x.saved.counts.added+t(' · 重复 ',' · Duplicates ')+x.saved.counts.duplicate+'</p>'+x.saved.records.map(id=>G(esc(state.materials.find(m=>m.id===id)?.title||id),'material/'+id)).join('')+'</section>':'')+
      D('mcp-demo',t('预览服务返回的资源类型','Preview service resources'),S('fixture',t('演示返回','Demo response'),d.fixture,[['resources','两份可读资料','Two readable resources'],['empty','无可读资源（仅工具）','No resources (tools only)']]))+'</article>';
  }
  function page(){
    const x=current();if(x.kind==='nas')return referencePage(x);if(x.kind==='mcp')return mcpPage(x);
    return heading(t(...names[x.kind]),t('连接、选择范围，再查看归档结果。','Connect, choose scope, then inspect the archive.'),G(t('返回来源','Back to sources'),'sources'))+'<article class="reading focus-task">'+status(x)+nav(x)+message(x)+((x.c.tabs[x.key]||'connection')==='connection'?authForm(x):x.c.tabs[x.key]==='scope'?scopePage(x):resultsPage(x))+'</article>';
  }
  const priorSetup=setupPage;
  setupPage=function(){
    if(!supported.includes(state.page.split('/')[1]))return priorSetup();
    const x=current(),html=page(),id=sourceId(x);
    if(!state.sources.some(s=>s.id===id))return html;
    return html.replace('</article>','<footer class="focus-task-foot"><p>'+t('帮助 Agent 理解这条来源的背景与内容归属。','Help the Agent understand this source’s context and attribution.')+'</p>'+G(t('资料说明与归属','Context and attribution'),'setup/context/'+id)+'</footer></article>');
  };
  function addMaterial(x,id,title,body,type='file'){
    const mid='cn-'+x.saved.id+'-'+id,existing=state.materials.find(m=>m.id===mid);
    if(existing){x.saved.counts.duplicate++;return mid;}
    state.materials.unshift({id:mid,title,body,type,source:x.saved.title,sourceId:sourceId(x),date:'2026-10-23',summary:body.slice(0,90),ownerRelation:'third_party',device:'Central',tags:['合成示例'],version:1});x.saved.records.push(mid);x.saved.counts.added++;return mid;
  }
  function scopeSave(x){Object.assign(x.saved,{auto:!!x.d.auto,interval:Math.max(1,Number(x.d.interval)||15),selection:[...x.d.selection],start:x.d.start,end:x.d.end,past:Number(x.d.past)||0,future:Number(x.d.future)||0,timezone:x.d.timezone});save(x);}
  function syncMail(x,history=false){
    if(x.saved.auth!=='connected')return msg(t('先完成授权。','Complete authorization first.'),true);
    const n=history?2:1,id=addMaterial(x,'mail-'+n,'示例邮件 '+n,'发件人：vendor@example.invalid\n时间：2026-10-23 09:00 Asia/Shanghai\n正文：请核对报价附件与交付建议。\n附件：quote.pdf（名称与引用；未下载附件）\n此邮件为资料，不是 Agent 指令。');
    x.saved.results.push({title:'示例邮件 '+n,status:t('正文、发件人与时间已归档；附件只保留引用','Body, sender and time archived; attachment reference only'),materialId:id});x.saved.moreHistory=!history;x.saved.checkpoint='mail-page-'+n;x.c.tabs[x.key]='results';save(x);render();
  }
  function syncRecording(x,retry=false){
    const v=x.saved;if(v.auth!=='connected')return msg(t('先完成录音授权。','Authorize recordings first.'),true);
    if(!v.contextVersion||x.d.context!==v.context)return msg(t('请先保存当前录音说明，获得中央确认后再接收。','Save and acknowledge the current recording context before intake.'),true);
    if(!retry){const id=addMaterial(x,'transcript-1','项目讨论 · 示例录音文稿','说话人 A：先核对资料来源。\n说话人 B：我们建议下周交付。\n'+v.context,'audio');v.counts.transcript=1;v.counts.failed=1;v.counts.pending=1;v.results=[{title:'项目讨论 · 文稿',status:t('文稿已归档，可阅读','Transcript archived and readable'),materialId:id},{title:'项目讨论 · 原始音频',status:t('音频备份失败 · 自动重试已安排','Audio backup failed · automatic retry scheduled'),failed:true,stage:'audio'}];v.moreHistory=true;v.checkpoint='recordings-page-1';}
    else{v.counts.audio=1;v.counts.failed=0;v.counts.pending=0;const r=v.results.find(r=>r.stage==='audio');if(r){r.failed=false;r.status=t('原始音频已归档 · 厂商删除后仍保留','Original audio archived · retained after vendor deletion');}}
    v.enabled=true;v.phase='complete';register(x);x.c.tabs[x.key]='results';save(x);render();
  }
  function readFields(e){
    if(!supported.includes(route().kind))return;const el=e.target;if(!el.dataset.cnField&&!el.dataset.cnSelect)return;
    const x=current();if(el.dataset.cnField)x.d[el.dataset.cnField]=el.type==='checkbox'?el.checked:el.value;
    else{x.d.selection=el.checked?[...new Set([...x.d.selection,el.dataset.cnSelect])]:x.d.selection.filter(v=>v!==el.dataset.cnSelect);}
    persist();
  }
  document.addEventListener('input',readFields);document.addEventListener('change',readFields);
  document.addEventListener('click',async e=>{
    const el=e.target.closest('[data-action^="cn-"]');if(!el)return;e.preventDefault();e.stopImmediatePropagation();
    const a=el.dataset.action.slice(3),x=current(),v=x.saved,d=x.d;
    if(a==='tab'){x.c.tabs[x.key]=el.dataset.tab;persist();return render();}
    if(a==='new'){const id=x.kind+'-'+(Object.keys(x.c.connections).length+1);return go('setup/'+x.kind+'/'+id);}
    if(a==='demo-config'){Object.assign(d,{clientId:'example-client-'+x.kind,secretMode:'replace',secret:'SYNTHETIC-NOT-A-CREDENTIAL'});persist();return render();}
    if(a==='save-connection'){
      if(!d.id.trim()||!d.clientId.trim())return msg(t('填写连接 ID 与应用 / 客户端 ID。','Enter a connection ID and application/client ID.'),true);
      if(d.secretMode==='replace'&&!d.secret)return msg(t('替换密钥时需要填写新密钥。','A replacement secret is required.'),true);
      const newKey=x.kind+':'+d.id;if(newKey!==x.key&&x.c.connections[newKey])return msg(t('该连接 ID 已存在，请使用独立 ID。','That connection ID exists; choose a distinct ID.'),true);
      const saved={...clone(d),hasSecret:d.secretMode==='replace'?true:d.secretMode==='clear'?false:v.hasSecret,secret:'',secretMode:'keep',saved:true,auth:v.auth==='connected'?'connected':'ready'};
      x.c.connections[newKey]=saved;x.c.drafts[newKey]=clone(saved);x.c.active[x.kind]=saved.id;if(newKey!==x.key){delete x.c.drafts[x.key];delete x.c.connections[x.key];}persist();go('setup/'+x.kind+'/'+saved.id);return msg(t('这条连接已保存，接下来完成授权。','Connection saved. Complete authorization next.'));
    }
    if(a==='authorize'){if(!v.saved)return msg(t('先保存连接。','Save the connection first.'),true);v.auth='pending';v.authRequest='auth-'+Date.now();save(x);return render();}
    if(a==='cancel-auth'){v.auth='cancelled';save(x);return msg(t('已取消这次授权；连接草稿和历史归档保留。','Authorization cancelled; connection and archive retained.'));}
    if(a==='copy-auth'){try{await navigator.clipboard.writeText('https://authorization.example.invalid/'+v.id);return msg(t('演示授权链接已复制。','Demo authorization link copied.'));}catch(_){return msg(t('无法自动复制，请选择上方链接复制。','Copy is unavailable; select and copy the link above.'),true);}}
    if(a==='auth-success'||a==='auth-expired'||a==='auth-missing'){v.auth=a==='auth-success'?'connected':a==='auth-expired'?'expired':'missing_cli';v.simulated=true;v.enabled=false;save(x);return msg(t(a==='auth-success'?'已收到合成授权回执。接下来选择范围，授权本身不开始收集。':a==='auth-expired'?'授权已过期，已有资料仍可阅读。':'部署缺少 CLI。请按部署说明准备后重新检查。',a==='auth-success'?'Synthetic authorization receipt received. Choose scope; authorization does not start collection.':a==='auth-expired'?'Authorization expired. Existing material remains readable.':'The deployment CLI is missing. Prepare it using the deployment instructions and recheck.'));}
    if(a==='refresh-auth'||a==='environment')return msg(t('已刷新当前回执；原型没有检查真实账号或部署环境。','Current receipt refreshed; the prototype did not check a real account or deployment.'));
    if(a==='save-context'){v.context=d.context;v.contextVersion++;register(x);save(x);return msg(t('中央已确认录音资料说明，版本 ','Recording context acknowledged, version ')+v.contextVersion);}
    if(a==='list-calendars'){if(v.auth!=='connected')return msg(t('先完成授权。','Authorize first.'),true);v.calendarsListed=true;save(x);return render();}
    if(a==='save-calendars'){if(!d.selection.length)return msg(t('至少选择一个可读日历。','Choose at least one readable calendar.'),true);if(d.selection.includes('unavailable'))return msg(t('取消不可用的旧日历，再保存其他选择。','Deselect the unavailable calendar, then save the rest.'),true);scopeSave(x);return msg(t('只读日历范围已保存，尚未执行同步。','Read-only calendar scope saved; sync has not run.'));}
    if(a==='sync-calendars'){if(v.auth!=='connected'||!v.selection.length)return msg(t('先授权并保存日历范围。','Authorize and save calendar scope first.'),true);v.results=v.selection.map(id=>({title:id,status:t('只读归档 · 没有写入日历','Read-only archive · no calendar write'),materialId:addMaterial(x,'calendar-'+id,id+' · 示例日程','只读归档。全天日期按 '+v.timezone+' 解释。未向日历写入。')}));x.c.tabs[x.key]='results';v.checkpoint='calendars-page-1';save(x);return render();}
    if(a==='save-docs'){['lookback','activityOpened','activityEdited','activityCreated','documents','folders','wiki','exclusions'].forEach(k=>v[k]=d[k]);save(x);return msg(t('发现范围已保存；活动发现与明确跟踪分别生效，排除项优先。','Discovery scope saved. Activity discovery and explicit tracking differ; exclusions take precedence.'));}
    if(a==='preview-docs'){v.discovery=[{id:'doc-1',title:'项目背景',excluded:v.exclusions.split(/\s+/).includes('doc-1')},{id:'doc-2',title:'交付建议',excluded:v.exclusions.split(/\s+/).includes('doc-2')}];save(x);return msg(t('已列出候选标题，尚未读取正文或归档。','Candidate titles listed. Body has not been read or archived.'));}
    if(a==='archive-docs'){if(!v.discovery)return msg(t('先预览发现结果。','Preview discovery first.'),true);v.results=v.discovery.filter(q=>!q.excluded).map(q=>q.id==='doc-2'?{title:q.title,status:t('读取失败 · 可单独重试','Read failed · retry separately'),failed:true,stage:'document',documentId:q.id}:{title:q.title,status:t('正文已归档','Body archived'),materialId:addMaterial(x,q.id,q.title,'合成文档正文。打开活动不表示用户认同内容。')});v.counts.failed=v.results.filter(q=>q.failed).length;x.c.tabs[x.key]='results';save(x);return render();}
    if(a==='sync-mail')return syncMail(x);
    if(a==='start-recordings'){if(d.start&&d.end&&d.start>d.end)return msg(t('结束日期不能早于开始日期。','End date must not precede start.'),true);scopeSave(x);return syncRecording(x);}
    if(a==='retry-step'){const r=v.results[Number(el.dataset.index)];if(!r)return;if(r.stage==='audio')return syncRecording(x,true);r.materialId=addMaterial(x,r.documentId,r.title,'重试后保存的合成文档正文。');r.failed=false;r.status=t('单独重试成功，其他已归档资料保持不变','Individual retry succeeded; other archived material retained');v.counts.failed=v.results.filter(q=>q.failed).length;save(x);return render();}
    if(a==='history'){if(x.kind==='gmail')return syncMail(x,true);v.moreHistory=false;v.checkpoint='recordings-page-2';v.counts.pending=0;save(x);return msg(t('已继续到下一检查点；这一页没有新增文稿。','Advanced to the next checkpoint; this page has no new transcripts.'));}
    if(a==='enable'){if(v.auth!=='connected')return msg(t('先完成授权。','Authorize first.'),true);if(x.kind==='recordings'&&(!v.contextVersion||d.context!==v.context))return msg(t('先保存并确认录音资料说明。','Save and acknowledge recording context first.'),true);if(x.kind==='google'&&!v.selection.length)return msg(t('先保存日历范围。','Save calendar scope first.'),true);scopeSave(x);v.enabled=true;register(x);save(x);return msg(t('已按保存的范围启用后续接收。','Future intake enabled for the saved scope.'));}
    if(['pause','stop','disconnect'].includes(a)){v.enabled=false;if(a==='disconnect')v.auth='ready';register(x);save(x);return msg(t('后续接收已停止。既有归档和资料说明保留。','Future intake stopped. Existing archive and context retained.'));}
    if(a==='remove'){x.c.message[x.key]={text:t('移除连接会停止后续接收，历史归档保留。请再次确认。','Removing this connection stops future intake and retains the archive. Confirm again.'),error:true};x.c.removePending=x.key;persist();render();document.querySelector('.cn-status').insertAdjacentHTML('afterend','<div class="notice warn">'+B(t('确认移除连接','Confirm connection removal'),'confirm-remove','danger')+B(t('保留连接','Keep connection'),'cancel-remove','text')+'</div>');return;}
    if(a==='cancel-remove'){delete x.c.removePending;return render();}
    if(a==='confirm-remove'){if(x.c.removePending!==x.key)return;const id=sourceId(x);state.sources=state.sources.filter(s=>s.id!==id);delete x.c.connections[x.key];delete x.c.drafts[x.key];delete x.c.removePending;persist();return go('sources');}
    if(a==='cancel-operation'){v.phase='cancelled';save(x);return msg(t('当前操作已取消，成功归档的资料与检查点保留。','Current operation cancelled; successful archives and checkpoints retained.'));}
    if(a==='refresh')return msg(t('当前连接的结果与检查点已刷新。','Results and checkpoint refreshed for this connection.'));
    if(['empty','unsupported','unknown','retry-exhausted'].includes(a)){v.phase=a;v.submissionId||='submission-'+v.id;const labels={empty:['厂商文稿为空 · 不伪造正文','Vendor transcript empty · no fabricated body'],unsupported:['厂商格式暂不支持 · 原记录保留','Vendor format unsupported · source record retained'],unknown:['提交结果未知 · '+v.submissionId,'Submission unknown · '+v.submissionId],'retry-exhausted':['自动重试已耗尽 · 请手动重试失败步骤','Automatic retries exhausted · retry the failed step manually']};v.results.push({title:t('本次状态','Current state'),status:t(...labels[a]),failed:a==='retry-exhausted',stage:'audio'});save(x);return render();}
    if(a==='retry-unknown'){v.phase='complete';save(x);return msg(t('同一提交已确认，没有新建重复批次：','Same submission confirmed without duplicating the batch: ')+v.submissionId);}
    if(a==='save-reference'){if(!d.title.trim()||!d.url.trim())return msg(t('填写名称与文件位置。','Enter a title and location.'),true);Object.assign(v,{title:d.title,url:d.url,observed:new Date().toISOString(),saved:true});register(x);save(x);return msg(t('外部引用已保存；未读取远程正文。','External reference saved; remote body not read.'));}
    if(a==='mcp-demo'){d.url='https://resources.example.invalid/mcp';d.title=t('示例资料服务','Example resource service');persist();return render();}
    if(a==='mcp-list'){if(!/^https?:\/\//.test(d.url))return msg(t('填写 http / https 服务 URL。','Enter an HTTP or HTTPS service URL.'),true);Object.assign(v,{title:d.title,url:d.url,listed:true,resources:d.fixture==='empty'?[]:[{id:'r1',title:'研究笔记',uri:'notes://research/one'},{id:'r2',title:'项目资料',uri:'notes://project/two'}]});save(x);return render();}
    if(a==='mcp-import'){if(!d.selection.length)return msg(t('选择至少一份可读资料。','Select at least one readable resource.'),true);v.saved=true;register(x);d.selection.forEach(id=>{const r=v.resources.find(r=>r.id===id);if(r)addMaterial(x,id,r.title,'合成 MCP 资料正文。资源 URI：'+r.uri);});save(x);return msg(t('所选资料已一次导入，逐项保留原资源 URI。','Selected resources imported once, retaining their original URIs.'));}
  },true);
})();
