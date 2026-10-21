import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createOfflineDom,settle} from '../../capture-dom.mjs';
const input=process.argv[2]||new URL('../work/interface-states.html',import.meta.url).pathname;
const output=process.argv[3]||new URL('../reports/english-boundaries.json',import.meta.url).pathname;
const source=await readFile(input,'utf8'),directory=JSON.parse(source.match(/^const DIRECTORY = (.*);$/m)[1]),routes=[...new Set(['settings/appearance',...directory.map(x=>x.route),'setup/screen','setup/folder'])];
const errors=[],dom=createOfflineDom(source,'https://mote-prototype.invalid/#/settings/appearance',errors),w=dom.window,d=w.document,checks=[],residual=[];
const assert=(name,ok,actual)=>{checks.push({name,passed:!!ok,...(actual===undefined?{}:{actual})});};
async function go(route){w.location.hash='#/'+route;await settle(w);await settle(w);}
async function select(id,value){const el=d.getElementById(id);if(!el)throw Error('Missing '+id);el.value=value;el.dispatchEvent(new w.Event('change',{bubbles:true}));await settle(w);}
async function click(selector){const el=d.querySelector(selector);if(!el)throw Error('Missing '+selector);el.click();await settle(w);await settle(w);}
async function fill(id,value){const el=d.getElementById(id);if(!el)throw Error('Missing '+id);el.value=value;el.dispatchEvent(new w.Event('input',{bubbles:true}));await settle(w);}
async function language(value){await go('settings/appearance');await select('language-choice',value);}
function options(){return [...d.querySelectorAll('select')].map(el=>({id:el.id,values:[...el.options].map(o=>o.value)}));}
function collect(label){const root=d.querySelector('#prototype'),walker=d.createTreeWalker(root,w.NodeFilter.SHOW_TEXT);let n;const list=[];while(n=walker.nextNode()){if(n.parentElement.closest('script,style,textarea,pre,[data-user-content],.material-title,.material-preview,.reading-body,.message.user'))continue;const text=n.textContent.trim();if(/[\u3400-\u9fff]/.test(text))list.push(text);}residual.push({label,texts:[...new Set(list)]});}
try{
 await settle(w);
 const zh=new Map();for(const route of routes){await go(route);zh.set(route,options());}
 await language('en');for(const route of routes){await go(route);assert('Stable option values: '+route,JSON.stringify(options())===JSON.stringify(zh.get(route)));}
 await go('notes');const original='保存设置\n这是一条原始中文笔记；路径 /资料/不能改变.md';await fill('note-text',original);await click('[data-action="save-note"]');const link=d.querySelector('[data-page^="material/note-"]');if(!link)throw Error('Saved note link missing');const materialRoute=link.dataset.page;await go(materialRoute);assert('User title is retained in English',d.querySelector('.reading>h1')?.textContent==='保存设置');assert('User body is retained in English',d.querySelector('.reading-body')?.textContent.includes(original.replace('\n','')));
 await language('zh');await go(materialRoute);assert('User title retained after English to Chinese',d.querySelector('.reading>h1')?.textContent==='保存设置');await language('en');await go('library/notes');assert('User title retained after Chinese to English',[...d.querySelectorAll('.material-title')].some(n=>n.textContent==='保存设置'));
 await go('ask');assert('Example prompts translate',[...d.querySelectorAll('.prompt-chip')].every(n=>!/[\u3400-\u9fff]/.test(n.textContent)));assert('History questions keep original text',[...d.querySelectorAll('.chat-history [data-action="open-chat"]')].some(n=>n.textContent==='这周有哪些值得跟进的事？'));
 await fill('ask-input','原始问题保留');await click('[data-action="send-ask"]');if(d.querySelector('[data-action="configure-from-ask"]')){await click('[data-action="configure-from-ask"]');const save=d.querySelector('[data-action="save-config"]');if(save)await click('[data-action="save-config"]');}
 assert('Answer interface note translates',d.querySelector('.message.answer > p.small')?.textContent==='Example answer · Check the scope, citations and return path');
 assert('Original example answer remains unchanged',d.querySelector('.message.answer > p[data-user-content]')?.textContent.startsWith('1. 核对移动端'));
 // Check language for offline and sign-in states using the visible controls.
 await go('notes');await fill('note-text','用户名\n离线原文');await click('[data-action="toggle-note-network"]');await click('[data-action="save-note"]');collect('Offline saved note');await click('[data-action="retry-note"]');collect('Offline sync retry');await click('[data-action="open-queued-note"]');assert('Queued original content retained',d.querySelector('[role="dialog"] [data-user-content]')?.textContent==='用户名');collect('Queued note preview');await click('[data-action="close-modal"]');await click('[data-action="discard-queued-note"]');collect('Discard confirmation');await click('[data-action="close-modal"]');
 await go('settings/account');await click('[data-action="logout-demo"]');collect('Sign-out confirmation');await click('[data-action="confirm-logout"]');collect('Sign-in page');await click('[data-action="demo-login"]');collect('Missing username');await fill('demo-username','用户名');await fill('demo-password','incorrect');await click('[data-action="demo-login"]');collect('Incorrect password');await fill('demo-password','mote-demo');await click('[data-action="demo-login"]');await go('settings/account');assert('Username matching an interface key is preserved',d.querySelector('h2[data-user-content]')?.textContent==='用户名');
}catch(e){checks.push({name:'Verification completed',passed:false,error:e.message});}
finally{dom.window.close();}
const report={input,sha256:createHash('sha256').update(source).digest('hex'),scope:'HTML DOM language boundaries; no product backend or layout assertions',routes:routes.length,checks,residual,errors,status:checks.some(c=>!c.passed)||errors.length?'failed':'passed'};await writeFile(output,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({output,status:report.status,checks:checks.length,residual:residual.length,failed:checks.filter(x=>!x.passed)}));
