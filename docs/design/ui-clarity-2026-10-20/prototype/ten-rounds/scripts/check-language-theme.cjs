const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const {openCandidate,observe}=require('../../continuation/scripts/browser-session.cjs');
const root=path.resolve(__dirname,'..'),round=Number(process.argv[2]);
const views={web:{width:1280,height:800},mac:{width:1152,height:768},android:{width:360,height:740}};
(async()=>{
 const out=path.join(root,'rounds','r'+round,'author','language-theme');await fs.mkdir(out,{recursive:true});
 const results=[];
 for(const [surface,viewport] of Object.entries(views)){
  const input=path.join(root,'rounds','r'+round,surface+'.html');
  const sha256=crypto.createHash('sha256').update(await fs.readFile(input)).digest('hex');
  const s=await openCandidate(input,{viewport,url:'https://mote-prototype.invalid/?reset=1&state=empty&theme=dark#/settings/appearance'});
  try{
   await s.page.locator('#language-choice').selectOption('en');
   await s.page.locator('[data-action="go"][data-page="library"]:visible').first().click();
   for(const scene of ['first','import','folder']){
    if(scene==='import')await s.page.getByRole('button',{name:'Import a file',exact:true}).click();
    if(scene==='folder')await s.page.getByRole('button',{name:'Connect a folder instead',exact:true}).click();
    const dom=await observe(s.page),name=surface+'-'+scene;
    await s.page.screenshot({path:path.join(out,name+'.png'),fullPage:false});
    await fs.writeFile(path.join(out,name+'.json'),JSON.stringify(dom,null,2)+'\n');
    results.push({surface,scene,viewport,sha256,pageWidth:dom.pageWidth,overflow:dom.pageWidth>viewport.width,errors:[...s.errors],headings:dom.headings,screenshot:name+'.png'});
   }
  }finally{await s.browser.close();}
 }
 const report={round,scope:'Author targeted English/dark/smaller viewport layout check using visible settings and UI navigation.',created_at:new Date().toISOString(),results};
 await fs.writeFile(path.join(out,'result.json'),JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify({round,views:results.length,overflow:results.filter(r=>r.overflow),errors:results.flatMap(r=>r.errors),directory:out}));
 if(results.some(r=>r.overflow||r.errors.length))process.exitCode=1;
})().catch(e=>{console.error(e.stack);process.exitCode=1});
