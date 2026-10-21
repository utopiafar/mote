const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {openCandidate,observe}=require('../../../../../continuation/scripts/browser-session.cjs');
const out=__dirname,round=path.resolve(out,'../..'),records=[];
async function snap(s,name){await s.page.screenshot({path:path.join(out,name+'.png'),fullPage:false});await fs.writeFile(path.join(out,name+'.json'),JSON.stringify(await observe(s.page),null,2));}
async function sourceNav(s,surface){await s.page.locator(surface==='android'?'.bottom-nav [data-page="sources"]':'.sidebar nav [data-page="sources"]').click();}
async function draft(s){return {path:await s.page.locator('#folder-path').inputValue(),name:await s.page.locator('#source-name').inputValue(),continuous:await s.page.locator('#continuous').isChecked(),saveMode:await s.page.locator('#save-mode').inputValue(),helper:await s.page.locator('#nu-save-mode-help').innerText()};}
(async()=>{
 for(const surface of ['web','mac','android']){
  const file=path.join(round,surface+'.html'),sha256=crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
  const s=await openCandidate(file,{viewport:surface==='android'?{width:390,height:844}:{width:1280,height:900},url:'https://mote-prototype.invalid/?reset=1&state=empty#/library'});
  try{
   records.push({surface,sha256,step:'candidate'});
   await s.page.locator('.welcome-source').first().click();
   if(surface==='web')await s.page.getByRole('button',{name:'填入示例服务器目录',exact:true}).click();
   else{await s.page.locator('#folder-path').fill(surface==='mac'?'~/Documents/原始范围':'Documents/原始范围');await s.page.locator('#source-name').fill('原始来源');}
   await s.page.getByRole('button',{name:'连接并保存',exact:true}).click();
   if(surface==='web'){
    const layout=await s.page.evaluate(()=>{const current=document.querySelector('.native-current-source').getBoundingClientRect(),field=document.getElementById('folder-path').getBoundingClientRect(),buttons=[...document.querySelectorAll('.native-current-actions button')].map(el=>({label:el.innerText,top:el.getBoundingClientRect().top,bottom:el.getBoundingClientRect().bottom}));return {currentTop:current.top,currentBottom:current.bottom,pathTop:field.top,scrollY,buttons};});
    records.push({surface,step:'server status controls and saved scope precede edit form',layout,scope:await s.page.locator('.native-saved-folder').innerText(),target:await s.page.locator('.workspace-folder-target').innerText(),passed:layout.currentBottom<layout.pathTop&&(await s.page.locator('.native-saved-folder').innerText()).includes('工作台服务器')&&(await s.page.locator('.workspace-folder-target').innerText()).includes('目标：当前工作台服务器')&&await s.page.locator('[data-action="pause-source"]').count()===1});
    await s.page.keyboard.press('Control+Home');await snap(s,'web-server-current-top');
    await s.page.getByRole('button',{name:'暂停此来源',exact:true}).click();await snap(s,'web-server-paused');records.push({surface,step:'moved server pause works',status:await s.page.locator('[data-native-source-feedback]').innerText(),passed:(await s.page.locator('[data-native-source-feedback]').innerText()).includes('已暂停接收')});
    await sourceNav(s,surface);const row=await s.page.locator('.source-row').innerText();records.push({surface,step:'server ownership retained in source row',row,passed:row.includes('工作台服务器')&&!row.includes('Mac ·')});
    await s.page.locator('.source-row [data-page^="setup/folder/"]').click();await s.page.getByRole('button',{name:'连接 Mac 或 Android 设备',exact:true}).click();await s.page.getByRole('button',{name:'连接 Android 示例设备',exact:true}).click();await snap(s,'web-device-folder-handoff');records.push({surface,step:'native device handoff remains distinct',heading:await s.page.locator('main h1').innerText(),currentBlocks:await s.page.locator('.native-current-source').count(),passed:(await s.page.locator('main h1').innerText()).includes('设备上的文件夹')&&!await s.page.locator('.native-current-source').count()});
   }else{
    await s.page.locator('#source-name').fill('调整后的来源');await s.page.locator('#continuous').uncheck();await s.page.locator('#save-mode').selectOption({index:1});
    const before=await draft(s);await s.page.getByRole('button',{name:surface==='mac'?'在 Finder 中选择':'选择手机文件夹',exact:true}).click();await s.page.locator('[data-action="native-folder-selected"]').nth(1).click();const after=await draft(s),expectedPath=surface==='mac'?'~/Desktop/收集夹':'Download/收集夹';
    records.push({surface,step:'all draft controls survive picker',before,after,passed:after.path===expectedPath&&after.name==='调整后的来源'&&!after.continuous&&after.saveMode===before.saveMode&&after.helper.includes('本机副本和工作台归档')});
    const savedScope=await s.page.locator('.native-saved-folder').innerText(),savedState=await s.page.locator('[data-native-source-feedback]').innerText(),savedPolicy=await s.page.locator('#continuous').locator('..').innerText();
    records.push({surface,step:'saved scope and policy remain saved until Save',savedScope,savedState,savedPolicy,passed:savedScope.includes('原始来源')&&savedScope.includes('原始范围')&&savedState.includes('正在同步')&&savedPolicy.includes('已保存的策略：持续同步')});
    await s.page.locator('#continuous').scrollIntoViewIfNeeded();await snap(s,surface+'-folder-draft-preserved');
    await s.page.getByRole('button',{name:'保存设置',exact:true}).click();records.push({surface,step:'save commits exact draft policy and scope',savedScope:await s.page.locator('.native-saved-folder').innerText(),status:await s.page.locator('[data-native-source-feedback]').innerText(),passed:(await s.page.locator('.native-saved-folder').innerText()).includes(expectedPath)&&(await s.page.locator('.native-saved-folder').innerText()).includes('调整后的来源')&&(await s.page.locator('[data-native-source-feedback]').innerText()).includes('未持续接收')});
    await sourceNav(s,surface);await snap(s,surface+'-noncontinuous-overview');const summary=await s.page.locator('.native-source-card').last().innerText(),row=await s.page.locator('.source-row').innerText();records.push({surface,step:'overview and row agree continuous receiving is off',summary,row,passed:summary.includes('未持续接收')&&!summary.includes('1 个正在接收')&&row.includes('未持续接收')});
    await s.page.getByRole('button',{name:'管理此文件夹',exact:true}).click();await s.page.getByRole('button',{name:'暂停此来源',exact:true}).click();await s.page.getByRole('button',{name:'恢复此来源',exact:true}).click();records.push({surface,step:'pause and resume retain saved non-continuous policy',continuous:await s.page.locator('#continuous').isChecked(),status:await s.page.locator('[data-native-source-feedback]').innerText(),passed:!await s.page.locator('#continuous').isChecked()&&(await s.page.locator('[data-native-source-feedback]').innerText()).includes('未持续接收')});
   }
   records.push({surface,step:'browser-errors-and-width',errors:s.errors,width:await s.page.evaluate(()=>document.documentElement.scrollWidth),passed:!s.errors.length&&await s.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)});
  }finally{await s.browser.close();}
 }
 const result={round:29,scope:'Final changed-flow author checks: Web server layout/target; native complete folder drafts and receiving policy feedback',createdAt:new Date().toISOString(),records};await fs.writeFile(path.join(out,'result.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));if(records.some(r=>r.passed===false))process.exitCode=1;
})().catch(async e=>{await fs.writeFile(path.join(out,'failure.json'),JSON.stringify({message:e.message,stack:e.stack,records},null,2));console.error(e.stack);process.exitCode=1;});
