const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const {openCandidate,saveEvidence}=require('./browser-session.cjs');
const root=path.resolve(__dirname,'..');
const candidates=[{label:'pine',file:path.resolve(root,'dist/r17.html')},{label:'reed',file:path.resolve(root,'../../prototype/dist/rounds/r15.html')},{label:'stone',file:path.resolve(root,'dist/r18.html')}];
const output=path.resolve(root,'evidence/neutral-comparison');
const mapping=[];
(async()=>{
 for(const c of candidates){
  const bytes=await fs.readFile(c.file);const record={label:c.label,file:path.relative(root,c.file),sha256:crypto.createHash('sha256').update(bytes).digest('hex'),scenes:[]};
  for(const scene of ['library','source-task','memory-result']){
   const route=scene==='source-task'?'activity':scene==='memory-result'?'memories':'library';
   const s=await openCandidate(c.file,{url:'https://mote-prototype.invalid/?reset=1&theme=light#/'+route});
   try{
    const actions=[];
    if(scene==='source-task'){const button=s.page.locator('[data-action="go"][data-page="activity/details"]').filter({visible:true}).first();actions.push(await button.innerText());await button.click();}
    if(scene==='memory-result'){const start=s.page.locator('[data-action="continue-memory"]').filter({visible:true}).first();actions.push(await start.innerText());await start.click();const result=s.page.locator('[data-action="go"][data-page="activity/memory-continuation"]').filter({visible:true}).first();actions.push(await result.innerText());await result.click();}
    await saveEvidence(s.page,path.join(output,c.label),scene);
    record.scenes.push({scene,actions,errors:s.errors});
   }finally{await s.browser.close();}
  }
  mapping.push(record);
 }
 await fs.writeFile(path.join(root,'reports/neutral-comparison-mapping.json'),JSON.stringify({scope:'Three frozen candidates, same generated fixture, same rendered states. Labels conceal revision, not familiarity after initial final-candidate exposure. No ranking supplied to evaluators.',mapping},null,2)+'\n');
 console.log(JSON.stringify(mapping.map(c=>({label:c.label,scenes:c.scenes.length,errors:c.scenes.flatMap(s=>s.errors)}))));
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
