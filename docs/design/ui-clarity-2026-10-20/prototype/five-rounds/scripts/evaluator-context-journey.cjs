// Independent context/attribution regression, driven only by visible controls.
const fs=require('node:fs/promises');
const path=require('node:path');
const {openCandidate}=require('./browser-session.cjs');
const {saveEvidence}=require('./evaluator-evidence.cjs');
const [candidate,dir,platform]=process.argv.slice(2);
const original='来源为第三方会议记录，不代表我的承诺。\n作者保留各自身份；Asia/Shanghai，2026-10-23。';
const draft=original+'\n未保存更正：引文中的“我”属于供应商。';
let s;const log={platform,scope:'Rendered UI only; generated fixture',steps:[],checks:[],errors:[]};
const check=(label,observed)=>log.checks.push({label,observed});
async function button(name){await s.page.getByRole('button',{name,exact:true}).first().click();}
async function summary(text){const l=s.page.locator('summary').filter({hasText:text}).first();if(!(await l.evaluate(e=>e.parentElement.open)))await l.click();}
async function step(name,fn){await fn?.();const d=await saveEvidence(s.page,dir,name);log.steps.push({name,url:d.url,evidence:[name+'.json',name+'.png']});return d;}
(async()=>{try{
 s=await openCandidate(candidate,{viewport:platform==='android'?{width:390,height:844}:{width:1440,height:1000}});s.page.setDefaultTimeout(5000);
 await s.page.getByLabel('预览数据',{exact:true}).selectOption('populated');await button('来源');await step('01-sources');
 await s.page.locator('button[data-page="setup/folder"]:visible').first().click();await summary('内容关系与背景');await step('02-source-context');
 await s.page.locator('#source-context-description').fill(original);await s.page.locator('#source-relation').selectOption({label:'第三方内容'});
 let d=await step('03-source-saved',()=>button('保存资料说明与归属'));check('saved exact source prose',d.text.includes(original));
 await s.page.locator('#source-context-description').fill(draft);await summary('预览说明版本冲突');
 d=await step('04-source-conflict',()=>button('模拟另一端更新了说明'));check('conflict retains local draft',await s.page.locator('#source-context-description').inputValue()===draft);
 d=await step('05-conflicted-save',()=>button('保存资料说明与归属'));check('save does not silently discard conflict draft',await s.page.locator('#source-context-description').inputValue()===draft);
 await button('来源');await s.page.goBack();d=await step('06-source-return');check('conflict draft survives navigation',await s.page.locator('#source-context-description').inputValue()===draft);
 if(platform==='android'){
   d=await step('07-conflict-resolved',()=>button('保留本机说明并保存'));check('explicit keep-local saves exact prose',d.text.includes(draft));
 }else{
   d=await step('07-conflict-resolved',()=>button('放弃修改并重新加载'));check('explicit reload replaces draft',await s.page.locator('#source-context-description').inputValue()!==draft);
 }
 await button('资料库');await s.page.locator('button[data-action="open-material"][data-id="m2"]:visible').click();await summary('作者与内容归属');d=await step('08-material-inherited');
 check('source relation visible on material',d.text.includes('第三方内容'));
 await s.page.locator('#cx-material-relation').selectOption({label:'我的表达或经历'});d=await step('09-material-override',()=>button('保存归属修正'));check('override basis shown',d.text.includes('来自这份资料的单独修正'));
 await button('查看来源');await s.page.goBack();d=await step('10-material-return');check('override survives source roundtrip',await s.page.locator('#cx-material-relation').inputValue()==='owner');
 await s.page.locator('#cx-material-relation').selectOption({label:'跟随来源'});d=await step('11-material-inherit-restored',()=>button('保存归属修正'));check('follow source restores effective third-party',d.text.includes('当前生效：第三方内容'));
 }catch(e){log.errors.push(e.message);if(s)await step('error-observed').catch(()=>{});}finally{if(s){log.browserErrors=s.errors;await s.browser.close();}await fs.mkdir(dir,{recursive:true});await fs.writeFile(path.join(dir,'journey.json'),JSON.stringify(log,null,2)+'\n');console.log(JSON.stringify(log));}
})();
