const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const assert=require('node:assert/strict');
const {openCandidate,observe,saveEvidence}=require('./browser-session.cjs');
const input=path.resolve(process.argv[2]);
const output=path.resolve(process.argv[3]);
const prototype=path.resolve(__dirname,'../..');
const mode=process.argv[4]||'all';

async function coverage(){
 const manifest=JSON.parse(await fs.readFile(path.resolve(prototype,'../feature-manifest.json'),'utf8'));
 const units=manifest.guide_groups.flatMap(g=>g.units.map(u=>({...u,group:g.title})));
 assert.equal(units.length,78);assert.equal(new Set(units.map(u=>u.id)).size,78);
 const s=await openCandidate(input,{url:'https://mote-prototype.invalid/?reset=1#/guide'});
 const results=[];
 try{
  for(const unit of units){
   await s.page.goto('https://mote-prototype.invalid/?reset=1#/guide');
   const record={id:unit.id,title:unit.title,purpose:unit.purpose,priority:unit.authored_priority,group:unit.group,condition:unit.condition,source_primary_target:unit.primary_target,scope:'Directory reachability and visible destination only; not all feature operations.'};
   try{
    const button=s.page.locator('button[data-action="open-feature"][data-id="'+unit.id+'"]');
    const ancestors=await button.locator('xpath=ancestor::details').all();
    for(const ancestor of ancestors.reverse())if(await ancestor.getAttribute('open')===null)await ancestor.locator(':scope > summary').click();
    record.entry=await s.page.locator('[data-feature-id="'+unit.id+'"]').innerText();
    record.entry_action=await button.innerText();
    await button.click();
    record.target=await observe(s.page);
    record.target.main=await s.page.locator('main').innerText();
    record.reachable=record.target.url.split('#')[1]!=='/guide';
    assert.ok(record.reachable,'No destination was observed');
   }catch(e){record.reachable=false;record.error=e.message;}
   results.push(record);
   if(results.length%20===0)console.log(JSON.stringify({coverage:results.length,of:units.length}));
  }
 }finally{await s.browser.close();}
 const report={...metadata,executor:'Chrome rendered DOM',network:'Every request intercepted locally',internal_state_read:false,total:78,reachable:results.filter(x=>x.reachable).length,errors:s.errors,units:results};
 await fs.writeFile(path.join(output,'feature-coverage.json'),JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify({coverage:report.reachable,total:78,errors:s.errors}));
 if(report.reachable!==78||s.errors.length)process.exitCode=1;
}

async function visuals(){
 const cases=[
  {name:'desktop-library-light',query:'theme=light',route:'library',viewport:{width:1440,height:1000}},
  {name:'desktop-empty-light',query:'theme=light&state=empty',route:'library',viewport:{width:1440,height:1000}},
  {name:'desktop-library-dark',query:'theme=dark',route:'library',viewport:{width:1440,height:1000}},
  {name:'mobile-library-light',query:'theme=light&surface=android',route:'library',viewport:{width:390,height:844}},
  {name:'mobile-empty-dark',query:'theme=dark&state=empty&surface=android',route:'library',viewport:{width:390,height:844}},
  {name:'tablet-library-light',query:'theme=light',route:'library',viewport:{width:768,height:1024}},
  {name:'desktop-library-english',query:'theme=light&lang=en',route:'library',viewport:{width:1440,height:1000}},
  {name:'mobile-empty-english',query:'theme=light&lang=en&state=empty&surface=android',route:'library',viewport:{width:390,height:844}},
  {name:'desktop-sources',query:'theme=light',route:'sources',viewport:{width:1440,height:1000}},
  {name:'desktop-memory',query:'theme=light',route:'memories',viewport:{width:1440,height:1000}},
  {name:'mobile-screen-settings',query:'theme=light&surface=android',route:'setup/screen',viewport:{width:390,height:844}},
  {name:'desktop-settings-english',query:'theme=light&lang=en',route:'settings',viewport:{width:1440,height:1000}}
 ];
 const results=[];
 for(const c of cases){
  const english=c.query.includes('lang=en');
  const s=await openCandidate(input,{url:'https://mote-prototype.invalid/?reset=1&'+c.query+'#/'+(english?'settings/appearance':c.route),viewport:c.viewport});
  try{
   if(english){await s.page.locator('#language-choice').selectOption('en');await s.page.locator('button[data-action="go"][data-page="'+c.route+'"]').filter({visible:true}).first().click();}
   const dom=await saveEvidence(s.page,path.join(output,'visuals'),c.name);
   await s.page.screenshot({path:path.join(output,'visuals',c.name+'-viewport.png'),fullPage:false});
   results.push({name:c.name,viewport:c.viewport,pageWidth:dom.pageWidth,horizontal_overflow:dom.pageWidth>c.viewport.width,errors:s.errors,headings:dom.headings});
  }finally{await s.browser.close();}
 }
 await fs.writeFile(path.join(output,'visuals','index.json'),JSON.stringify({...metadata,scope:'Real isolated headless Chrome screenshots; generated fixture data; system UI and real devices not tested.',cases:results},null,2)+'\n');
 console.log(JSON.stringify({visuals:results.length,overflow:results.filter(r=>r.horizontal_overflow),errors:results.flatMap(r=>r.errors)}));
 if(results.some(r=>r.horizontal_overflow||r.errors.length))process.exitCode=1;
}

let metadata;
(async()=>{
 await fs.mkdir(output,{recursive:true});
 metadata={candidate:input,sha256:crypto.createHash('sha256').update(await fs.readFile(input)).digest('hex'),created_at:new Date().toISOString(),browser:'Chromium 133.0.6943.16'};
 if(mode==='all'||mode==='coverage')await coverage();
 if(mode==='all'||mode==='visuals')await visuals();
})().catch(e=>{console.error(e.stack);process.exitCode=1});
