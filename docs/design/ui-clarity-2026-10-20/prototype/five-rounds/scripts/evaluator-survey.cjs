const fs = require('node:fs/promises');
const path = require('node:path');
const { openCandidate, observe } = require('./browser-session.cjs');
const { saveEvidence } = require('./evaluator-evidence.cjs');

// Independent navigation/disclosure inventory only. This survey never establishes
// feature completeness; stateful journey checks supply that separate evidence.
async function goGuide(page) {
  const close=page.getByRole('button',{name:'关闭对话框',exact:true});
  if(await close.count()&&await close.first().isVisible())await close.first().click();
  const guide = page.getByRole('button', { name: /^全部功能/ });
  if (await guide.count() && await guide.first().isVisible()) await guide.first().click();
  else {
    await page.getByRole('button', { name: '更多页面与设置', exact: true }).click();
    await page.getByRole('button', { name: /^全部功能/ }).click();
  }
}
async function disclose(page) {
  const names = [];
  for (let i=0;i<await page.locator('summary').count();i++) {
    const summary = page.locator('summary').nth(i);
    if (await summary.isVisible()) {
      const name = (await summary.innerText()).trim();
      if (!(await summary.evaluate(el=>el.parentElement.open))) await summary.click();
      names.push(name);
    }
  }
  return names;
}
async function main() {
  const [candidate,evidenceDirectory,platform] = process.argv.slice(2);
  const session = await openCandidate(candidate, {viewport:platform==='android'?{width:390,height:844}:{width:1440,height:1000}});
  session.page.setDefaultTimeout(5000);
  const page=session.page;
  const results=[];
  try {
    await page.getByLabel('预览数据',{exact:true}).selectOption({label:'已有资料'});
    await saveEvidence(page,evidenceDirectory,'populated-home');
    await goGuide(page);
    await disclose(page);
    const directory=await saveEvidence(page,evidenceDirectory,'directory-open');
    const features=await page.locator('button[data-action="open-feature"]').evaluateAll(els=>els.filter(el=>el.getClientRects().length).map(el=>({feature:el.dataset.id,label:el.getAttribute('aria-label')||el.innerText,group:el.closest('details')?.querySelector('summary')?.innerText})));
    const pages=[...new Map(directory.controls.filter(c=>c.tag==='button'&&c.page).map(c=>[c.page,{page:c.page,label:c.label}])).values(),...features];
    for (let i=0;i<pages.length;i++) {
      const item=pages[i];
      try {
        await goGuide(page);
        if(item.feature){
          const summary=page.getByText(item.group,{exact:true});
          if(!(await summary.evaluate(el=>el.parentElement.open)))await summary.click();
          await page.getByRole('button',{name:item.label,exact:true}).click();
        }else await page.locator('button[data-page='+JSON.stringify(item.page)+']:visible').first().click();
        const identity=item.feature||item.page;
        const name=String(i+1).padStart(2,'0')+'-'+identity.replace(/[^a-zA-Z0-9_-]/g,'_');
        const collapsed=await saveEvidence(page,evidenceDirectory,name);
        const disclosures=await disclose(page);
        const expanded=disclosures.length?await saveEvidence(page,evidenceDirectory,name+'-open'):collapsed;
        results.push({page:item.page,feature:item.feature,label:item.label,status:'observed',disclosures,evidence:[name+'.json',name+'.png',...(disclosures.length?[name+'-open.json',name+'-open.png']:[])],headings:expanded.headings,visible_controls:expanded.controls.map(c=>({label:c.label,tag:c.tag,value:c.value,page:c.page})),text:expanded.text});
      } catch(e) {results.push({page:item.page,feature:item.feature,label:item.label,status:'failed_to_observe',reason:e.message});}
      console.log(JSON.stringify({platform,page:item.page,feature:item.feature,status:results.at(-1).status}));
    }
    await fs.mkdir(evidenceDirectory,{recursive:true});
    const report={platform,candidate,scope:'Visible navigation and disclosure survey; not a semantic completion claim',pages:results,browserErrors:session.errors};
    await fs.writeFile(path.join(evidenceDirectory,'survey.json'),JSON.stringify(report,null,2)+'\n');
    console.log(JSON.stringify({done:true,platform,observed:results.filter(x=>x.status==='observed').length,total:results.length,browserErrors:session.errors}));
  } finally {await session.browser.close();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
