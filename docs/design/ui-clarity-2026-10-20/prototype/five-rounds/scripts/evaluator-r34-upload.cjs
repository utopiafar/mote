// Independent R34 regression. Visible controls/DOM only; no candidate state or source inspection.
const fs=require('node:fs/promises');
const path=require('node:path');
const {openCandidate}=require('./browser-session.cjs');
const {saveEvidence}=require('./evaluator-evidence.cjs');
const [file,dir,platform]=process.argv.slice(2);
const prose='R34 '+platform+' 上传恢复。\n第三方研究摘录与 AI 回答各自保留身份；不是我的个人承诺。Asia/Shanghai。';
let s;const log={platform,scope:'Independent synthetic HTML UI observations',checks:[],steps:[],errors:[]};
function check(label,observed){log.checks.push({label,observed});}
async function step(name,fn){await fn?.();const d=await saveEvidence(s.page,dir,name);log.steps.push({name,url:d.url});return d;}
async function button(name){await s.page.getByRole('button',{name,exact:true}).first().click();}
async function summary(name){const e=s.page.locator('summary').filter({hasText:name}).first();if(!(await e.evaluate(x=>x.parentElement.open)))await e.click();}
(async()=>{try{
 s=await openCandidate(file,{url:'https://mote-prototype.invalid/#/library',viewport:platform==='android'?{width:412,height:915}:{width:1440,height:1000}});s.page.setDefaultTimeout(5000);
 await button('导入第一份资料');await s.page.locator('#focus-import-instruction').fill(prose);await button('选择文件');await button('读书笔记.md');await summary('预览上传恢复状态');await s.page.locator('#uq-demo-mode').selectOption({label:'排队等待'});await step('01-submit-draft');
 let d=await step('02-queued',()=>button('上传并查看预览'));check('queued item not archived',!d.text.includes('原件已归档'));
 await summary('文件、资料说明与更多操作');d=await step('03-identity-context');const id=d.text.match(/提交 ID：([^\n]+)/)?.[1];check('submission identity visible',!!id);check('exact queued explanation',d.text.includes(prose));
 await step('04-paused',()=>button('暂停上传'));await step('05-continued',()=>button('继续上传'));await summary('预览上传回执');
 await step('06-failed',()=>button('模拟上传失败'));d=await step('07-retried',()=>button('重试同一提交'));check('retry retains identity and context',d.text.includes(id)&&d.text.includes(prose));
 d=await step('08-after-browser-reload',()=>s.page.reload());check('reload requires original file',d.text.includes('本机文件已不可用')&&d.controls.some(c=>c.text==='重新选择文件'));check('missing bytes cannot advance',d.controls.find(c=>c.text==='收到下一段回执')?.disabled===true);check('stale uploading heading while file missing',d.text.includes('正在上传'));
 await step('09-reselect-dialog',()=>button('重新选择文件'));
 const wrong=path.join(dir,'wrong-file.txt');await fs.mkdir(dir,{recursive:true});await fs.writeFile(wrong,'Wrong R34 synthetic file.\n');await s.page.locator('#uq-reselect-input').setInputFiles(wrong);d=await step('10-wrong-file-rejected');check('wrong file rejected context retained',d.text.includes('文件名称、路径或大小与这次提交不一致')&&d.text.includes(prose)&&d.text.includes(id));
 await step('11-same-files-ready',()=>button('重新使用同一批示例文件'));await button('继续上传');await step('12-submitting',()=>button('收到下一段回执'));d=await step('13-received',()=>button('收到下一段回执'));check('received same identity',d.text.includes(id)&&d.text.includes('中央已接收'));
 d=await step('14-received-review',()=>button('核对已接收资料'));check('review same submission and exact prose',d.url.endsWith('/'+id)&&d.text.includes(prose));
 await button('返回导入记录');await button('本地上传队列');await step('15-remove-confirm',()=>button('移除本地队列项'));await step('16-removed',()=>button('确认移除本地项'));await button('返回导入记录');await s.page.getByText('读书笔记.md',{exact:true}).click();await summary('原件与文件解析情况');d=await step('17-original-retained');check('removal retains same received import',d.url.endsWith('/'+id)&&d.text.includes('2,400 B')&&d.text.includes(prose));
 d=await step('18-original-opened',()=>button('查看原件'));check('original metadata still opens',d.text.includes('已保留的原件')&&d.text.includes('读书笔记.md'));
}catch(e){log.errors.push(e.message);if(s)await step('error-observed').catch(()=>{});}finally{if(s){log.browserErrors=s.errors;await s.browser.close();}await fs.mkdir(dir,{recursive:true});await fs.writeFile(path.join(dir,'journey.json'),JSON.stringify(log,null,2)+'\n');console.log(JSON.stringify(log));}})();
