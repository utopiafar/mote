// Independent evaluator: rendered DOM, visible inputs, and ordinary user actions only.
const fs=require('node:fs/promises');
const path=require('node:path');
const {openCandidate,observe}=require('./browser-session.cjs');
const {saveEvidence}=require('./evaluator-evidence.cjs');
const [file,dir,platform,mode='normal']=process.argv.slice(2);
const context='格式：聊天导出与我的笔记混合，标题为“北岸研究”。\n作者：我、供应商和 AI。供应商说“我承诺周五交付”，这不是我的承诺；AI 的建议也不是我的观点。\n时间：2026-10-19 09:30，Asia/Shanghai。\n背景：比较三份方案，保留原作者与引用关系。';
const revised=context+'\n更正：录音里的“我”指供应商，不是账户持有人。';
const log={platform,mode,scope:'UI simulation; rendered DOM and ordinary actions only',steps:[],checks:[],errors:[]};
let s;
async function step(name,action){await action?.();const dom=await saveEvidence(s.page,dir,name);log.steps.push({name,url:dom.url,evidence:[name+'.json',name+'.png']});return dom;}
function check(label,value){log.checks.push({label,observed:value});}
async function button(name){await s.page.getByRole('button',{name,exact:true}).click();}
async function summary(name){const el=s.page.locator('summary').filter({hasText:name}).first();if(!(await el.evaluate(e=>e.parentElement.open)))await el.click();}
(async()=>{try{
 s=await openCandidate(file,{viewport:platform==='android'?{width:412,height:915}:{width:1440,height:1000}});s.page.setDefaultTimeout(5000);
 await step('01-home');
 for(const [id,label] of [['ask','问一问'],['sources','来源'],['activity','活动'],['library','资料库']])await step('02-nav-'+id,()=>s.page.getByRole('button',{name:label,exact:true}).first().click());
 await s.page.locator('#preview-state').selectOption('empty');
 await step('03-empty-home');
 await step('04-import-form',()=>button('导入第一份资料'));
 check('optional context maxLength',await s.page.locator('#focus-import-instruction').getAttribute('maxlength'));
 await s.page.locator('#focus-import-instruction').fill(context);
 await step('05-file-picker',()=>button('选择文件'));
 await step('06-selected',()=>button('全部示例文件'));
 await step('07-removed',()=>button('移除 访谈录音.wav'));
 check('context survives file picker',await s.page.locator('#focus-import-instruction').inputValue()===context);
 await summary('名称、解析与图片处理');
 await s.page.locator('#focus-import-name').fill('北岸研究 · '+platform);
 await s.page.locator('#focus-import-parser').selectOption({label:'聊天导出 · 1.0.0'});
 await s.page.locator('#focus-import-image').selectOption({label:'仅保存原件'});
 await step('08-options');
 let d=await step('09-preview',()=>button('上传并查看预览'));
 const taskUrl=d.url; check('context exact in preview',d.text.includes(context));
 await summary('补充说明，重新理解资料');
 await s.page.locator('#focus-revised-instruction').fill(revised);
 await step('10-revised-draft');
 check('confirmation disabled while explanation is dirty',!(await s.page.getByRole('button',{name:'确认并保存记录',exact:true}).isEnabled()));
 if(mode==='dirty-confirm'){
   const enabled=await s.page.getByRole('button',{name:'确认并保存记录',exact:true}).isEnabled();
   check('confirmation enabled with dirty explanation',enabled);
   if(enabled){
     d=await step('11-confirm-with-dirty-draft',()=>button('确认并保存记录'));
     check('dirty confirmation outcome',d.text);
     check('revised prose present after direct confirm',d.text.includes(revised));
   }else{
     d=await step('11-dirty-confirmation-blocked');
     check('revised draft remains present',await s.page.locator('#focus-revised-instruction').inputValue()===revised);
   }
 }else{
   await button('来源');await s.page.goBack();
   await step('11-return-to-draft');
   check('unsaved draft survives navigation',await s.page.locator('#focus-revised-instruction').inputValue()===revised);
   d=await step('12-reprepared',()=>button('重新生成预览'));
   check('same import after reprepare',d.url===taskUrl);check('revised prose exact in new preview',d.text.includes(revised));
   await summary('核对文件与处理方式');await step('13-file-options');
   d=await step('14-saved',()=>button('确认并保存记录'));
   check('revised prose exact in saved detail',d.text.includes(revised));
   for(const label of ['原件与文件解析情况','解析、图片与处理进度','更多操作','预览不同处理状态'])await summary(label);
   await step('15-detail-expanded');
   await button('阅读导入结果');await summary('本次导入说明');
   d=await step('16-material-context');check('revised prose exact in material',d.text.includes(revised));
   await button('返回导入资料');await summary('预览不同处理状态');
   await s.page.locator('#focus-import-phase').selectOption({label:'等待配置模型'});
   await step('17-model-required');await button('配置模型后继续');
   await step('18-model-settings');
   check('recovery selects import module',await s.page.locator('#cs-model-module-module').inputValue()==='import');
   await s.page.locator('#cs-model-module-provider').selectOption({label:'个人示例连接'});
   await s.page.locator('#cs-model-module-model').fill('review-fixed-import');await button('保存模块设置');
   d=await step('19-model-saved');check('saved model visible value',d.controls.find(c=>c.id==='cs-model-module-model')?.value);
   d=await step('20-return-same-import',()=>button('返回这次导入'));
   check('same task after model return',d.url.replace('/details/','/review/')===taskUrl||d.url===taskUrl);check('revised prose after model return',d.text.includes(revised));
 }
}catch(e){log.errors.push(e.message);if(s)await step('error-observed').catch(()=>{});}finally{if(s){log.browserErrors=s.errors;await s.browser.close();}await fs.mkdir(dir,{recursive:true});await fs.writeFile(path.join(dir,'journey.json'),JSON.stringify(log,null,2)+'\n');console.log(JSON.stringify(log));}})();
