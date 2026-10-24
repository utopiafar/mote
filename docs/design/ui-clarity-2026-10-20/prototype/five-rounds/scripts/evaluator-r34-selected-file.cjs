// Independent focused native selected-file regression; visible inputs and rendered results only.
const fs=require('node:fs/promises');const path=require('node:path');
const {openCandidate}=require('./browser-session.cjs');const {saveEvidence}=require('./evaluator-evidence.cjs');
const [file,dir,platform]=process.argv.slice(2);let s;
const log={platform,steps:[],checks:[],errors:[],scope:'Synthetic native controls only; no OS/filesystem validation'};
const prose='R34 '+platform+' 选定文件说明：第三方研究摘录，不是我的个人承诺。';
const check=(label,observed)=>log.checks.push({label,observed});
async function button(name){await s.page.getByRole('button',{name,exact:true}).first().click();}
async function step(name,fn){await fn?.();const d=await saveEvidence(s.page,dir,name);log.steps.push({name,url:d.url});return d;}
(async()=>{try{
 s=await openCandidate(file,{viewport:platform==='android'?{width:412,height:915}:{width:1440,height:1000}});s.page.setDefaultTimeout(5000);
 await button('添加内容');await s.page.locator('button[data-page="setup/native-files"]:visible').click();let d=await step('01-selected-file-task');check('copy does not refer to selected directory',!d.text.includes('所选目录原文件'));
 await button('选择文件');await s.page.locator('input[type="'+(platform==='android'?'radio':'checkbox')+'"][value="reading"]:visible').check();await button('使用所选文件');await s.page.locator('#ns-files-new-retention:visible').selectOption('archive');if(platform==='android')await s.page.locator('#ns-files-new-description:visible').fill(prose);await button('返回');await step('02-dirty-back-guard');await button('继续编辑');d=await step('03-draft-preserved');check('named file and retention draft remain',d.text.includes('研究摘录.md')&&d.controls.find(c=>c.id==='ns-files-new-retention')?.value==='archive');if(platform==='android')check('exact description draft remains',d.controls.find(c=>c.id==='ns-files-new-description')?.value===prose);
 d=await step('04-file-confirmation',()=>button('核对本次导入'));check('confirmation names file and limits scope to listed files',d.text.includes('研究摘录.md')&&d.text.includes('只处理列出的文件'));check('confirmation no old directory retention copy',!d.text.includes('所选目录原文件'));
 d=await step('05-one-time-file-saved',()=>button('确认保存本机任务'));check('one-time saved state no future scan promise',!d.text.includes('下次扫描')&&!d.text.includes('下次检查'));if(platform==='android')check('context remains locally pending',d.text.includes('等待 Central')||d.text.includes('等待中央')||d.text.includes('等待Central'));
 await button('查看本机记录');d=await step('06-local-file-record');check('named original remains local',d.text.includes('研究摘录.md')&&d.text.includes('本机待发'));await button('打开记录');d=await step('07-local-record-detail');check('unconnected record retains local pending status',d.text.includes('本机待发'));
}catch(e){log.errors.push(e.message);if(s)await step('error-observed').catch(()=>{});}finally{if(s){log.browserErrors=s.errors;await s.browser.close();}await fs.mkdir(dir,{recursive:true});await fs.writeFile(path.join(dir,'journey.json'),JSON.stringify(log,null,2)+'\n');console.log(JSON.stringify(log));}})();
