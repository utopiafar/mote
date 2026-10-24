const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const {openCandidate,observe}=require('../../continuation/scripts/browser-session.cjs');
const root=path.resolve(__dirname,'..');
const round=Number(process.argv[2]);
const directory=path.join(root,'rounds','r'+round);
const scenes=process.argv[3]==='first-only'?['first']:['first','sources'];
const views={web:{width:1440,height:1000},mac:{width:1280,height:900},android:{width:390,height:844}};
(async()=>{
 const attempts=path.join(directory,'author');await fs.mkdir(attempts,{recursive:true});
 const out=path.join(attempts,'capture-'+new Date().toISOString().replace(/[:.]/g,'-'));await fs.mkdir(out);
 const results=[];
 for(const surface of ['web','mac','android']){
  const input=path.join(directory,surface+'.html');
  const sha256=crypto.createHash('sha256').update(await fs.readFile(input)).digest('hex');
  for(const scene of scenes){
   const s=await openCandidate(input,{viewport:views[surface],url:'https://mote-prototype.invalid/?reset=1&state=empty#/'+(scene==='first'?'library':'sources')});
   try{
    await s.page.screenshot({path:path.join(out,surface+'-'+scene+'.png'),fullPage:false});
    const dom=await observe(s.page);await fs.writeFile(path.join(out,surface+'-'+scene+'.json'),JSON.stringify(dom,null,2)+'\n');
    results.push({round,surface,scene,sha256,viewport:views[surface],pageWidth:dom.pageWidth,overflow:dom.pageWidth>views[surface].width,errors:s.errors,headings:dom.headings,screenshot:path.relative(root,path.join(out,surface+'-'+scene+'.png'))});
   }finally{await s.browser.close();}
  }
 }
 const summary={scope:'Author browser render captures; UI rendering only.',created_at:new Date().toISOString(),round,results};
 await fs.writeFile(path.join(out,'index.json'),JSON.stringify(summary,null,2)+'\n');
 console.log(JSON.stringify({round,output:out,views:results.length,overflow:results.filter(r=>r.overflow),errors:results.flatMap(r=>r.errors)}));
 if(results.some(r=>r.overflow||r.errors.length))process.exitCode=1;
})().catch(e=>{console.error(e.stack);process.exitCode=1});
