import {writeFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {dirname,resolve} from 'node:path';
import {capture} from '../../capture-dom.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const input=resolve(process.argv[2]||resolve(root,'work/source-r18.html'));
const output=resolve(process.argv[3]||resolve(root,'evidence/source-r18'));
await mkdir(output,{recursive:true});
const click=selector=>({type:'click',selector}),text=(selector,value)=>({type:'assertText',selector,text:value}),notText=(selector,value)=>({type:'assertNotText',selector,text:value}),fill=(selector,value)=>({type:'fill',selector,value}),select=(selector,value)=>({type:'select',selector,value}),count=(selector,value)=>({type:'assertCount',selector,count:value}),val=(selector,value)=>({type:'assertValue',selector,value});
const sidebar=page=>click('.sidebar [data-page="'+page+'"]');
const journeys=[
 {id:'source-task-count-and-recovery',url:'https://mote-prototype.invalid/?reset=1#/activity',actions:[
  text('[data-task-id="source-lark-sync"] [data-task-source-count]','0 份已保存资料'),
  click('[data-task-id="source-lark-sync"] [data-page="activity/details"]'),
  text('[data-task-source-count]','0 份已保存资料'),notText('main','12 份'),
  text('main','此来源尚无已保存资料'),click('[data-action="browse-source"]'),
  val('#source-filter','id:lark'),text('[data-source-scope]','飞书文档与日历'),
  text('[data-source-empty]','这个来源还没有已保存资料'),count('.material-row',0),
  click('[data-action="clear-source-scope"]'),count('.material-list .material-row',6),
  select('#source-filter','id:feishu-recording'),count('.material-list .material-row',1),
  text('.material-list','项目讨论录音'),sidebar('activity'),
  click('[data-action="authorize-task"]'),text('h1','飞书文档与日历'),
  click('[data-action="save-source"]'),click('[data-action="browse-source"]'),
  val('#source-filter','id:lark'),count('.material-row',0),
  sidebar('activity'),text('[data-task-id="source-lark-sync"]','授权已恢复'),
  text('[data-task-source-count]','0 份已保存资料'),
  click('[data-task-id="source-lark-sync"] [data-action="browse-source"]'),
  val('#source-filter','id:lark'),text('[data-source-empty]','这个来源还没有已保存资料'),
  click('[data-action="clear-source-scope"]'),count('.material-list .material-row',6)
 ]},
 {id:'source-relationship-save-reopen-scope',url:'https://mote-prototype.invalid/?reset=1#/sources',actions:[
  click('[data-source-id="folder"] [data-action="go"]'),
  text('[data-source-context-saved]','不声明'),select('#source-relation','third_party'),
  fill('#source-context-description','保存内容关系'),
  text('[data-source-context-status]','关系修改尚未保存'),
  text('[data-source-context-saved]','不声明'),sidebar('sources'),
  click('[data-source-id="folder"] [data-action="go"]'),
  val('#source-relation','third_party'),val('#source-context-description','保存内容关系'),
  click('[data-action="save-source-context"]'),text('[data-source-context-saved]','第三方内容'),
  text('[data-source-context-saved]','保存内容关系'),
  sidebar('sources'),click('[data-source-id="screen"] [data-action="go"]'),
  val('#source-relation',''),text('[data-source-receiving]','等待屏幕录制授权'),
  sidebar('sources'),click('[data-source-id="folder"] [data-action="go"]'),
  val('#source-relation','third_party'),val('#source-context-description','保存内容关系'),
  select('#source-relation','mixed'),click('[data-action="discard-source-context"]'),
  val('#source-relation','third_party'),
  click('[data-page="setup/folder/new"]'),text('label.checkrow','这是连接后的同步方式。'),
  notText('label.checkrow','这是恢复接收后的策略。')
 ]},
 {id:'device-filter-materials-and-raw',url:'https://mote-prototype.invalid/?reset=1#/library',actions:[
  count('.material-list .material-row',6),select('#device-filter','mac'),
  count('.material-list .material-row',3),notText('.material-list','产品评审 · 让第一步更清楚'),
  click('[data-action="open-material"][data-id="m2"]'),text('.reading-body','原始资料保留出处'),
  click('.detail-top [data-action="go"]'),val('#device-filter','mac'),count('.material-list .material-row',3),
  select('#device-filter','central'),count('.material-list .material-row',2),
  text('.material-list','项目讨论录音'),select('#device-filter','web'),count('.material-list .material-row',1),
  text('.material-list','产品评审'),click('[data-action="clear-filters"]'),count('.material-list .material-row',6),
  click('[data-action="filter"][data-filter="raw"]'),select('#device-filter','web'),
  count('[data-capture-id]',0),text('.empty','这个范围没有原始记录'),
  select('#device-filter','mac'),count('[data-capture-id]',1),
  text('[data-capture-id="m6"]','2026-10-18 11:08'),
  click('[data-action="original"][data-id="m6"]'),text('[role="dialog"]','文章摘录 · 渐进式披露'),
  text('[role="dialog"]','采集时间： 2026-10-18 11:08'),text('[role="dialog"]','设备： Mac'),
  click('[data-action="close-modal"]')
 ]},
 {id:'screenshot-group-date-device-evidence',url:'https://mote-prototype.invalid/?reset=1#/library/snippets',actions:[
  text('[data-snippet-count]','1 组 · 1 条片段'),val('#snippet-grouping','session'),
  text('[data-capture-group]','连续会话 1'),text('[data-capture-group]','2026-10-18'),
  text('[data-capture-group]','Mac'),select('#capture-date-filter','2026-10-18'),
  select('#device-filter','central'),text('[data-snippet-count]','0 组 · 0 条片段'),
  count('[data-capture-group]',0),select('#device-filter','mac'),count('[data-capture-group]',1),
  select('#date-filter','今天'),text('.empty','这个范围没有截图片段'),
  select('#date-filter','全部时间'),select('#snippet-grouping','application'),
  text('[data-capture-group]','应用相册'),text('[data-capture-group]','浏览器'),
  click('[data-capture-group] [data-action="original"]'),
  text('[role="dialog"]','文章摘录 · 渐进式披露'),
  text('[role="dialog"]','屏幕记录 / 浏览器'),text('[role="dialog"]','2026-10-18 11:08'),
  click('[data-action="close-modal"]'),click('[data-capture-group] [data-action="open-material"]'),
  text('.reading-body','界面可以首先呈现少量高频任务'),
  click('.detail-top [data-action="go"]'),val('#snippet-grouping','application'),
  val('#capture-date-filter','2026-10-18'),val('#device-filter','mac'),count('[data-capture-group]',1)
 ]},
 {id:'send-pause-independent-scopes',url:'https://mote-prototype.invalid/?reset=1#/settings/privacy',actions:[
  text('[data-send-status]','向中央发送已开启'),click('[data-action="pause-all"]'),
  text('[role="dialog"]','屏幕采集、单个来源接收、向中央发送分别控制'),
  click('[role="dialog"] [data-action="close-modal"]'),text('[data-send-status]','向中央发送已开启'),
  click('[data-action="pause-all"]'),click('[data-action="confirm-pause-all"]'),
  text('[data-send-status]','本机继续保留，向中央发送已暂停'),sidebar('sources'),
  text('[data-send-status]','向中央发送已暂停'),text('[data-source-id="folder"]','正在同步'),
  text('[data-source-id="screen"]','未在记录 · 等待授权'),
  click('[data-source-id="folder"] [data-action="go"]'),click('[data-action="pause-source"]'),
  text('[data-source-receiving]','已暂停接收新内容'),sidebar('sources'),
  click('[data-action="resume-all"]'),count('[data-send-status]',0),
  text('[data-source-id="folder"]','已暂停接收'),text('[data-source-id="screen"]','未在记录 · 等待授权'),
  click('[data-source-id="screen"] [data-action="go"]'),click('[data-action="allow-screen"]'),
  click('[data-action="save-source"]'),text('[data-source-receiving]','正在按已保存的应用范围记录'),
  sidebar('settings'),click('[data-page="settings/privacy"]'),
  click('[data-action="pause-all"]'),click('[data-action="confirm-pause-all"]'),
  sidebar('sources'),text('[data-source-id="screen"]','正在记录'),text('[data-source-id="folder"]','已暂停接收'),
  click('[data-page="devices"]'),text('[data-send-status]','向中央发送已暂停'),
  text('[data-device-id="mac"]','屏幕：正在记录'),text('[data-device-id="mac"]','向中央发送已暂停'),
  click('[data-page="setup/screen"]'),click('[data-action="pause-source"]'),
  text('[data-source-receiving]','屏幕记录已暂停'),sidebar('sources'),
  text('[data-send-status]','向中央发送已暂停'),click('[data-action="resume-all"]'),
  text('[data-source-id="screen"]','已暂停记录'),text('[data-source-id="folder"]','已暂停接收')
 ]},
 {id:'source-new-controls-english-content-preserved',url:'https://mote-prototype.invalid/?reset=1#/settings/appearance',actions:[
  select('#language-choice','en'),sidebar('activity'),
  text('[data-task-source-count]','0 saved materials'),
  click('[data-task-id="source-lark-sync"] [data-page="activity/details"]'),
  text('main','This source has no saved materials yet.'),
  sidebar('sources'),click('[data-source-id="folder"] [data-action="go"]'),
  text('[data-source-context-id]','How this content relates to you'),
  select('#source-relation','owner'),fill('#source-context-description','保存内容关系'),
  text('[data-source-context-status]','Relationship changes are not saved yet.'),
  click('[data-action="save-source-context"]'),text('[data-source-context-saved]','My expression or experience'),
  text('[data-source-context-saved]','保存内容关系'),val('#source-context-description','保存内容关系'),
  sidebar('library'),text('#device-filter','All devices'),
  click('[data-action="filter"][data-filter="snippets"]'),text('[data-snippet-count]','1 group · 1 snippet'),
  text('[data-capture-group]','Continuous session 1'),select('#snippet-grouping','application'),
  text('[data-capture-group]','App albums'),text('#capture-date-filter','All capture dates'),
  click('[data-capture-group] [data-action="original"]'),text('[role="dialog"]','Captured at:'),
  text('[role="dialog"]','文章摘录 · 渐进式披露'),click('[data-action="close-modal"]'),
  sidebar('settings'),click('[data-page="settings/privacy"]'),
  text('[data-send-status]','Sending to Central is enabled'),click('[data-action="pause-all"]'),
  text('[data-action="confirm-pause-all"]','Confirm pause for all sending'),
  click('[data-action="confirm-pause-all"]'),text('[data-send-status]','Content stays on the device; sending to Central is paused'),
  text('[data-action="resume-all"]','Resume all sending')
 ]}
];
const filter=process.argv[4];
const results=[];
for(const journey of journeys.filter(j=>!filter||j.id===filter)){
 const actions=resolve(output,journey.id+'.actions.json');await writeFile(actions,JSON.stringify(journey.actions,null,2)+'\n');
 const result=await capture({input,output:resolve(output,journey.id+'.html'),actions,url:journey.url});
 const row={id:journey.id,status:result.status,executed:result.steps.length,steps:journey.actions.length,failure:result.failure,errors:result.errors,candidate_sha256:result.candidate_sha256};results.push(row);console.log(JSON.stringify(row));
}
await writeFile(resolve(output,filter?filter+'.result.json':'index.json'),JSON.stringify({scope:'Focused HTML UI evidence only; synthetic materials; visible controls and visible DOM assertions; no app-state reads, network, OS permissions, live device, or backend claims.',journeys:results},null,2)+'\n');
if(results.some(result=>result.status!=='passed'))process.exitCode=1;
