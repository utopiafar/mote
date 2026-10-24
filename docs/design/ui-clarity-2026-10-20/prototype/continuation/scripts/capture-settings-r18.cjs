const path=require('node:path');
const fs=require('node:fs/promises');
const {createHash}=require('node:crypto');
const {openCandidate,saveEvidence}=require('./browser-session.cjs');
(async()=>{
 const root=path.resolve(__dirname,'..'),file=process.argv[2]?path.resolve(process.argv[2]):path.join(root,'work/settings-r18.html'),out=process.argv[3]?path.resolve(process.argv[3]):path.join(root,'reports/settings-r18-browser');
 const sha256=createHash('sha256').update(await fs.readFile(file)).digest('hex');await fs.mkdir(out,{recursive:true});
 const session=await openCandidate(file,{viewport:{width:390,height:900},url:'https://mote-prototype.invalid/?reset=1&surface=android#/settings/appearance'}),records=[];
 const page=session.page;
 const capture=async name=>{const observation=await saveEvidence(page,out,name);records.push({name,page:observation.page_title,viewport:observation.viewport,pageWidth:observation.pageWidth,headings:observation.headings});};
 try{
  await page.selectOption('#language-choice','en');await page.locator('[data-action="dismiss-toast"]').click();
  await page.evaluate(()=>location.hash='#/settings/account');await page.waitForSelector('#account-retention');await capture('account-en-390');
  await page.evaluate(()=>location.hash='#/import');await page.waitForSelector('#import-image-scheme');await page.click('[data-action="choose-file"]');await page.click('[data-action="selected-file"][data-file="产品草图.png"]');await page.fill('#import-name','保留我的标题');await page.selectOption('#import-parser','聊天导出');await page.selectOption('#import-image-scheme','archive');await capture('import-en-android-390');
  await page.click('[data-action="submit-import"]');await page.click('[data-page^="import/details/"]');await page.waitForSelector('#detail-image-scheme');await capture('import-details-en-390');
  await page.evaluate(()=>location.hash='#/application');await page.waitForSelector('[data-app-sample]');await capture('app-activity-en-390');
 }finally{await session.browser.close();}
 const report={input:file,sha256,scope:'New C01/A02/A13 views only, English Android preview at 390px',records,errors:session.errors,status:session.errors.length||records.some(r=>r.pageWidth>r.viewport.width)?'needs-review':'captured'};
 await fs.writeFile(path.join(out,'capture-summary.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
})().catch(e=>{console.error(e.message);process.exitCode=1;});
