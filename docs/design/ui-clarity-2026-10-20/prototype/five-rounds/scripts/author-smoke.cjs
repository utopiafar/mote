const fs=require('node:fs/promises');
const path=require('node:path');
const {openCandidate,observe}=require('./browser-session.cjs');
(async()=>{
 const round=process.argv[2]||'30',folder=process.argv[3]||'work';
 for(const platform of ['web','mac','android']){
  const out=path.resolve('work/author-r'+round,platform);await fs.mkdir(out,{recursive:true});
  const s=await openCandidate(path.resolve(folder,'r'+round,platform+'.html'),{viewport:platform==='android'?{width:412,height:915}:{width:1440,height:1000}});
  const p=s.page,steps=[];
  async function save(name){steps.push({name,...await observe(p)});await p.screenshot({path:path.join(out,name+'.png')});}
  try{
   await save('01-home');
   await p.locator('main [data-page="import"]').first().click();
   await save('02-import');
   await p.locator('[data-action="focus-choose-files"]').click();
   await p.locator('[data-action="focus-sample-file"][data-index="0"]').click();
   const context='这份资料是我的读书笔记。\n作者：林同学；引文属于原作者，AI 回复属于 AI。\n时间：北京时间；只将我的段落作为我的表达。';
   await p.locator('#focus-import-instruction').fill(context);
   await p.locator('#focus-import-options > summary').click();
   await p.locator('#focus-import-name').fill('理解说明保留检查');
   await p.locator('#focus-import-parser').selectOption('chat@1.0.0');
   await p.locator('[data-action="focus-submit-import"]').click();
   await save('03-review');
   if(!(await p.locator('main').innerText()).includes(context))throw Error('Instruction missing in review');
   await p.locator('[data-action="focus-confirm-import"]').click();
   await save('04-detail');
   if(!(await p.locator('main').innerText()).includes(context))throw Error('Instruction missing in detail');
   await p.locator('main [data-page^="material/"]').first().click();
   await p.locator('#focus-material-import-context > summary').click();
   await save('05-material-context');
   await p.locator('.sidebar [data-page="sources"],.bottom-nav [data-page="sources"]').filter({visible:true}).first().click();
   await save('06-sources');
   // Navigate via an actual visible link: no internal state injection.
   const folderLink=p.locator('main [data-page^="setup/folder"]').filter({visible:true}).first();
   if(await folderLink.count()){await folderLink.click();await save('07-folder');}
   if(platform==='web'&&await p.locator('#folder-path').count())throw Error('Web has central folder path');
   if(s.errors.length)throw Error(s.errors.join(';'));
   console.log(JSON.stringify({platform,pass:true,steps:steps.length,errors:s.errors}));
  }finally{await fs.writeFile(path.join(out,'observations.json'),JSON.stringify(steps,null,2));await s.browser.close();}
 }
})().catch(e=>{console.error(e);process.exit(1)});
