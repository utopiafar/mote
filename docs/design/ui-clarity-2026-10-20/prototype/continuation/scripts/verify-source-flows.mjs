import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {dirname,resolve} from 'node:path';
import {capture} from '../../capture-dom.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const output=resolve(root,'evidence/source-flows');
await mkdir(output,{recursive:true});
const click=(selector)=>({type:'click',selector}), text=(selector,value)=>({type:'assertText',selector,text:value}), notText=(selector,value)=>({type:'assertNotText',selector,text:value}), check=(selector,checked)=>({type:'check',selector,checked}), fill=(selector,value)=>({type:'fill',selector,value}), count=(selector,value)=>({type:'assertCount',selector,count:value}), val=(selector,value)=>({type:'assertValue',selector,value});
const journeys=[
{id:'screen-range-permission-save-draft',url:'https://mote-prototype.invalid/?reset=1#/setup/screen',actions:[
 text('[data-source-receiving]','当前不会记录屏幕'),count('[data-screen-app]:checked',2),
 click('[data-action="allow-screen"]'),check('#screen-app-editor',false),count('[data-screen-app]:checked',1),
 text('[data-screen-draft-status]','有未保存'),click('[data-action="deny-screen"]'),
 count('[data-screen-app]:checked',1),text('[data-source-receiving]','当前不会记录屏幕'),
 notText('[data-source-receiving]','正在接收'),text('[data-saved-screen-range]','2 个应用'),
 click('[data-action="allow-screen"]'),count('[data-screen-app]:checked',1),
 click('[data-action="save-source"]'),text('[data-saved-screen-range]','浏览器 · 1 个应用'),
 count('[data-screen-app]:checked',1),click('[data-action="go"][data-page="sources"]'),
 text('[data-source-id="screen"]','已保存 1 个应用：浏览器'),notText('[data-source-id="screen"]','编辑器'),
 click('[data-source-id="screen"] [data-action="go"]'),count('[data-screen-app]:checked',1),
 click('[data-action="pause-source"]'),text('[data-source-receiving]','屏幕记录已暂停'),
 click('[data-action="pause-source"]'),text('[data-source-receiving]','正在按已保存的应用范围记录'),
 check('#screen-app-messaging',true),click('[data-action="go"][data-page="sources"]'),
 text('[data-source-id="screen"]','已保存 1 个应用：浏览器'),
 click('[data-source-id="screen"] [data-action="go"]'),count('[data-screen-app]:checked',2),
 text('[data-saved-screen-range]','浏览器 · 1 个应用'),click('[data-action="discard-screen-draft"]'),
 count('[data-screen-app]:checked',1),check('#screen-app-browser',false),click('[data-action="save-source"]'),
 text('.toast','请选择至少一个'),text('[data-saved-screen-range]','浏览器 · 1 个应用'),
 count('[data-screen-app]:checked',0),click('[data-action="discard-screen-draft"]'),
 click('[data-action="deny-screen"]'),click('[data-action="go"][data-page="sources"]'),
 text('[data-source-id="screen"]','未在记录 · 权限已拒绝'),notText('[data-source-id="screen"]','正在记录')
]},
{id:'folder-rename-pause-read-return',url:'https://mote-prototype.invalid/?reset=1#/sources',actions:[
 click('[data-source-id="folder"] [data-action="go"]'),
 fill('#source-name','范围核对项目'),fill('#folder-path','~/Documents/范围核对项目'),
 click('[data-action="save-source"]'),click('[data-action="pause-source"]'),
 text('[data-source-receiving]','已保存资料仍可阅读'),text('label.checkrow','恢复接收后的策略'),
 count('#continuous:checked',1),click('[data-action="browse-source"]'),
 text('[data-source-scope]','范围核对项目'),text('[data-source-scope]','已暂停接收新内容'),
 count('.material-list .material-row',1),text('.material-list','长期记忆系统调研笔记'),
 notText('.material-list','产品评审'),click('[data-action="open-material"]'),
 text('.reading-body','原始资料、记忆与洞察之间的关系'),
 click('.detail-top [data-action="go"]'),text('[data-source-scope]','范围核对项目'),
 count('.material-list .material-row',1),click('[data-action="clear-source-scope"]'),
 count('.material-list .material-row',6),text('.material-list','产品评审'),
 click('.sidebar [data-action="go"][data-page="sources"]'),
 text('[data-source-id="folder"]','范围核对项目'),text('[data-source-id="folder"]','1 份已保存资料'),
 click('[data-source-id="folder"] [data-action="go"]'),click('[data-action="pause-source"]'),
 text('[data-source-receiving]','正在接收选定内容'),check('#continuous',false),click('[data-action="save-source"]'),
 text('[data-source-receiving]','未开启持续同步'),click('[data-action="browse-source"]'),
 count('.material-list .material-row',1),text('.material-list','长期记忆系统调研笔记')
]},
{id:'new-folder-isolated-empty-and-same-name',url:'https://mote-prototype.invalid/?reset=1#/sources',actions:[
 click('[data-action="source-add"]'),click('[data-page="setup/folder/new"]'),
 text('h1','连接新的文件夹'),val('#source-name',''),val('#folder-path',''),count('[data-action="pause-source"]',0),
 fill('#source-name','新项目来源'),fill('#folder-path','~/Documents/新项目'),
 click('[data-action="save-source"]'),text('h1','管理文件夹来源'),
 val('#source-name','新项目来源'),click('[data-action="pause-source"]'),
 click('[data-action="browse-source"]'),text('[data-source-scope]','新项目来源'),
 text('[data-source-empty]','这个来源还没有已保存资料'),text('[data-source-empty]','当前已暂停接收'),
 count('.material-list .material-row',0),click('[data-action="clear-source-scope"]'),
 count('.material-list .material-row',6),click('.sidebar [data-page="sources"]'),
 count('[data-source-id]',4),text('[data-source-id="folder"]','研究资料'),
 text('[data-source-id="folder-1"]','新项目来源'),
 click('[data-action="source-add"]'),click('[data-page="setup/folder/new"]'),
 val('#source-name',''),fill('#source-name','研究资料'),fill('#folder-path','~/Documents/另一个同名来源'),
 click('[data-action="save-source"]'),click('[data-action="browse-source"]'),
 text('[data-source-scope]','研究资料'),text('[data-source-empty]','这个来源还没有已保存资料'),
 val('#source-filter','id:folder-2'),click('[data-action="clear-source-scope"]'),
 click('.sidebar [data-page="sources"]'),count('[data-source-id]',5),
 text('[data-source-id="folder"]','1 份已保存资料'),text('[data-source-id="folder-2"]','0 份已保存资料'),
 click('[data-source-id="folder"] [data-action="browse-source"]'),
 count('.material-list .material-row',1),text('.material-list','长期记忆系统调研笔记')
]}
];
const results=[];
for(const j of journeys){
 const actions=resolve(output,j.id+'.actions.json');await writeFile(actions,JSON.stringify(j.actions,null,2)+'\n');
 const r=await capture({input:resolve(root,'work/source-flows.html'),output:resolve(output,j.id+'.html'),actions,url:j.url});
 const item={id:j.id,status:r.status,executed:r.steps.length,actions:j.actions.length,failure:r.failure,errors:r.errors,candidate_sha256:r.candidate_sha256};results.push(item);console.log(JSON.stringify(item));
}
await writeFile(resolve(output,'index.json'),JSON.stringify({scope:'HTML UI source journeys; generated data; no network, native permission or backend validation; visible DOM controls only',journeys:results},null,2)+'\n');
if(results.some(r=>r.status!=='passed'))process.exitCode=1;
