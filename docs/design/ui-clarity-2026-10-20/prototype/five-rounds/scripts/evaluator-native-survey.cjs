// Independent native surface survey. Discover links only from rendered controls.
const fs=require('node:fs/promises');
const path=require('node:path');
const {openCandidate}=require('./browser-session.cjs');
const {saveEvidence}=require('./evaluator-evidence.cjs');
const [candidate,dir,platform]=process.argv.slice(2);
async function disclose(page){for(let i=0;i<await page.locator('summary').count();i++){const e=page.locator('summary').nth(i);if(await e.isVisible()&&!(await e.evaluate(e=>e.parentElement.open)))await e.click();}}
(async()=>{
 const s=await openCandidate(candidate,{viewport:platform==='android'?{width:390,height:844}:{width:1440,height:1000}});s.page.setDefaultTimeout(4000);
 const pages=[],queue=[{route:'settings/native',path:[]}],seen=new Set();
 try{
 await s.page.getByLabel('预览数据',{exact:true}).selectOption('populated');
 while(queue.length&&pages.length<30){const item=queue.shift();if(seen.has(item.route))continue;seen.add(item.route);
 try{
  await s.page.getByRole('button',{name:'来源',exact:true}).first().click();
  await s.page.getByRole('button',{name:'本机设置',exact:true}).click();
  for(const next of item.path){await disclose(s.page);await s.page.locator('button[data-page='+JSON.stringify(next)+']:visible').first().click();}
  const name=String(pages.length+1).padStart(2,'0')+'-'+item.route.replaceAll('/','_');
  const closed=await saveEvidence(s.page,dir,name);await disclose(s.page);const dom=await saveEvidence(s.page,dir,name+'-open');
  pages.push({route:item.route,status:'observed',evidence:[name+'.json',name+'.png',name+'-open.json',name+'-open.png'],text:dom.text,controls:dom.controls});
  for(const c of dom.controls){if(c.tag==='button'&&c.page&&/native/.test(c.page)&&!seen.has(c.page))queue.push({route:c.page,path:[...item.path,c.page]});}
 }catch(e){pages.push({route:item.route,status:'failed_to_observe',reason:e.message});}
 }
 }finally{await fs.mkdir(dir,{recursive:true});await fs.writeFile(path.join(dir,'survey.json'),JSON.stringify({platform,scope:'Visible controls and disclosures, not complete feature verification',pages,browserErrors:s.errors},null,2));await s.browser.close();}
 console.log(JSON.stringify({platform,pages:pages.map(p=>({route:p.route,status:p.status})),browserErrors:s.errors}));
})().catch(e=>{console.error(e);process.exitCode=1});
