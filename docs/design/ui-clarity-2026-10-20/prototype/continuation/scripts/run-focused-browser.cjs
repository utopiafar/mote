const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const assert=require('node:assert/strict');
const {openCandidate,observe,saveEvidence}=require('./browser-session.cjs');
const input=path.resolve(process.argv[2]);
const output=path.resolve(process.argv[3]);
const root=path.resolve(__dirname,'..');
const normalize=x=>String(x).replace(/\s+/g,' ').trim();
const only=process.argv[4];
async function runScenario(scenario){
 const s=await openCandidate(input,{url:scenario.url});
 s.page.setDefaultTimeout(6000);
 const record={id:scenario.id,goal:scenario.goal,url:scenario.url,steps:[],status:'passed'};
 try{
  for(const a of scenario.actions){
   const loc=s.page.locator(a.selector);
   const target=loc.filter({visible:true}).first();
   let actual;
   if(a.type==='click'){actual=await target.innerText();await target.click();}
   else if(a.type==='fill'){await target.fill(a.value);actual=await target.inputValue();}
   else if(a.type==='check'){await target.setChecked(a.checked);actual=await target.isChecked();}
   else if(a.type==='select'){await target.selectOption(a.value);actual=await target.inputValue();}
   else if(a.type==='assertText'){actual=normalize(await target.innerText());assert.ok(actual.includes(normalize(a.text)),`Expected ${a.text} in ${a.selector}; observed: ${actual}`);}
   else if(a.type==='assertNotText'){actual=normalize(await target.innerText());assert.ok(!actual.includes(normalize(a.text)),`Unexpected ${a.text} in ${a.selector}`);}
   else if(a.type==='assertCount'){actual=await loc.count();assert.equal(actual,a.count);}
   else if(a.type==='assertValue'){actual=await target.inputValue();assert.equal(actual,a.value);}
   else if(a.type==='assertVisible'){actual=await target.isVisible();assert.ok(actual);}
   else throw Error('Unimplemented action type '+a.type);
   record.steps.push({step:record.steps.length+1,...a,actual,result:'passed',rendered:await observe(s.page)});
  }
  assert.deepEqual(s.errors,[]);
 }catch(e){record.status='failed';record.error=e.message;record.failed_action=scenario.actions[record.steps.length];}
 finally{record.final=await saveEvidence(s.page,output,scenario.id+(record.status==='failed'?'-failure':''));await s.browser.close();}
 await fs.writeFile(path.join(output,scenario.id+'.journey.json'),JSON.stringify(record,null,2)+'\n');
 return record;
}
(async()=>{
 await fs.mkdir(output,{recursive:true});
 const definitions=[];
 const sourceCases=[['screen-range-permission-save-draft','屏幕选项、权限、保存与未保存草稿保持一致','setup/screen'],['folder-rename-pause-read-return','既有来源改名、暂停、阅读与返回保留具体范围','sources'],['new-folder-isolated-empty-and-same-name','新建来源与既有来源分离，同名来源不串资料','sources']];
 for(const [id,goal,route] of sourceCases)definitions.push({id,goal,url:'https://mote-prototype.invalid/?reset=1#/'+route,actions:JSON.parse(await fs.readFile(path.join(root,'evidence/source-flows',id+'.actions.json'),'utf8'))});
 const legacy=JSON.parse(await fs.readFile(path.join(root,'../journey-fixtures.json'),'utf8'));
 const selected=['ask-recovery','activity-recovery','source-versions'];
 for(const f of legacy.filter(f=>selected.includes(f.id))){
  let actions=f.id==='ask-recovery'?[{type:'click',selector:'details:has([data-action="mock-missing"]) > summary'},...f.actions]:f.actions;
  if(f.id==='activity-recovery')actions=[...f.actions.slice(0,5),{type:'assertNotText',selector:'main',text:'需要重新授权'},{type:'assertText',selector:'main',text:'等待你的说明'},...f.actions.slice(7)];
  definitions.push({...f,actions,url:'https://mote-prototype.invalid/'+f.url});
 }
 const results=[];
 for(const scenario of definitions.filter(s=>!only||s.id.includes(only))){const r=await runScenario(scenario);results.push({id:r.id,goal:r.goal,status:r.status,steps:r.steps.length,operations:r.steps.filter(s=>!s.type.startsWith('assert')).length,assertions:r.steps.filter(s=>s.type.startsWith('assert')).length,error:r.error,failed_action:r.failed_action});console.log(JSON.stringify(results.at(-1)));}
 const report={candidate:input,sha256:crypto.createHash('sha256').update(await fs.readFile(input)).digest('hex'),created_at:new Date().toISOString(),browser:'Chromium 133.0.6943.16',scope:'Generated HTML mock UI, rendered controls, all requests locally intercepted; no native OS, network services or app-internal state.',scenarios:results,all_passed:results.every(r=>r.status==='passed')};
 await fs.writeFile(path.join(output,'index.json'),JSON.stringify(report,null,2)+'\n');
 if(!report.all_passed)process.exitCode=1;
})().catch(e=>{console.error(e.stack);process.exitCode=1});
