const fs=require('node:fs/promises');const path=require('node:path');const crypto=require('node:crypto');const assert=require('node:assert/strict');
const {openCandidate,observe,saveEvidence}=require('./browser-session.cjs');
const input=path.resolve(process.argv[2]||path.join(__dirname,'../work/memory-context-r18.html'));
const output=path.resolve(process.argv[3]||path.join(__dirname,'../evidence/memory-context-r18'));
const click=(p,a)=>p.locator('[data-action="'+a+'"]').filter({visible:true}).first().click();
const records=[];
async function scenario(id,route,run){const s=await openCandidate(input,{url:'https://mote-prototype.invalid/?reset=1#/'+route});const r={id,status:'passed',steps:[]};
const step=async(description,fn)=>{await fn(s.page);r.steps.push({description,rendered:await observe(s.page)});};
try{await run(s.page,step);assert.deepEqual(s.errors,[]);}catch(e){r.status='failed';r.error=e.message;}finally{await saveEvidence(s.page,output,id+(r.status==='failed'?'-failure':''));await s.browser.close();}records.push(r);console.log(JSON.stringify({id:r.id,status:r.status,steps:r.steps.length,error:r.error}));}
(async()=>{await fs.mkdir(output,{recursive:true});
await scenario('memory-search-effective-history','memories',async(p,step)=>{
 const seed=await p.locator('#memory-text').innerText();
 await step('Search a saved memory by content',async()=>{await p.locator('#memory-search').fill('复杂设置');assert.equal(await p.locator('[data-memory-id="original"]').count(),1);});
 await step('A nonmatching search has a clear recovery',async()=>{await p.locator('#memory-search').fill('不存在的火星资料');assert.equal(await p.locator('[data-memory-id="original"]').count(),0);assert.ok((await p.locator('main').innerText()).includes('没有匹配的记忆'));await click(p,'clear-memory-search');});
 await step('Read applicability and the current status',async()=>{const body=await p.locator('[data-memory-boundary="original"]').innerText();assert.ok(body.includes('不自动推广到其他人'));assert.ok(body.includes('当前有效'));});
 await click(p,'correct-memory');await p.locator('#memory-correction').fill('新的两句长期偏好。\n保留全部上下文。');
 await step('Save a complete correction',async()=>{await click(p,'save-correction');assert.ok((await p.locator('#memory-text').innerText()).includes('保留全部上下文。'));});
 await step('Look back before the correction and see the old effective version',async()=>{await p.locator('#memory-view').selectOption('asof');await p.locator('#memory-asof').fill('2026-10-20T12:00');await p.locator('#memory-asof').dispatchEvent('change');assert.equal(await p.locator('[data-memory-version]').count(),1);assert.ok((await p.locator('[data-memory-version]').innerText()).includes(seed));assert.ok(!(await p.locator('[data-memory-version]').innerText()).includes('新的两句长期偏好'));});
 await step('Inspect replacement relations and timestamps',async()=>{await p.locator('#memory-view').selectOption('history');assert.equal(await p.locator('[data-memory-version]').count(),2);const text=await p.locator('main').innerText();assert.ok(text.includes('人工纠正，替代版本 1'));assert.ok(text.includes('UTC+8'));});
 await step('Return to current memory without changing it',async()=>{await p.locator('#memory-view').selectOption('current');assert.ok((await p.locator('#memory-text').innerText()).includes('新的两句长期偏好'));});
 await step('Continue uses the current complete correction',async()=>{await click(p,'continue-memory');await p.locator('[data-action="go"][data-page="activity/memory-continuation"]').filter({visible:true}).first().click();assert.equal(await p.locator('.evidence-box p').innerText(),'新的两句长期偏好。 保留全部上下文。');});
});
await scenario('question-context-scope-and-return','settings/agent-scope',async(p,step)=>{
 await step('An empty question has an actionable error',async()=>{await click(p,'preview-question-context');assert.ok((await p.locator('.toast').innerText()).includes('请先填写一个问题'));});
 await p.locator('#context-question').fill('产品界面设计有哪些偏好？');
 await step('Preview matching material and memory without calling a model',async()=>{await click(p,'preview-question-context');const body=await p.locator('[data-context-result]').innerText();assert.ok(body.includes('未调用模型'));assert.ok(body.includes('产品界面设计有哪些偏好？'));assert.ok(await p.locator('[data-context-item]').count()>0);});
 const original=await p.locator('[data-context-result]').innerText();
 await step('Verify a source and return to the same context preview',async()=>{await p.locator('[data-context-item] [data-page^="material/"]').first().click();assert.ok((await p.locator('.detail-top').innerText()).includes('返回上下文预览'));await p.locator('.detail-top [data-action="go"]').click();assert.equal(await p.locator('[data-context-result]').innerText(),original);});
 await step('A nonmatching query keeps scope explicit',async()=>{await p.locator('#context-question').fill('zzzzunrelatedquery');await click(p,'preview-question-context');assert.equal(await p.locator('[data-context-item]').count(),0);assert.ok((await p.locator('[data-context-result]').innerText()).includes('当前范围没有匹配内容'));});
});
await scenario('memory-context-english','settings/appearance',async(p,step)=>{
 await p.locator('#language-choice').selectOption('en');
 await p.locator('[data-action="go"][data-page="library"]').filter({visible:true}).first().click();
 await p.locator('[data-action="filter"][data-filter="memory"]').filter({visible:true}).first().click();
 await step('New memory controls have English UI with stable option values',async()=>{assert.equal(await p.locator('#memory-view').inputValue(),'current');assert.ok((await p.locator('main').innerText()).includes('Search memories'));assert.ok((await p.locator('[data-memory-boundary]').innerText()).includes('Applicability'));await p.locator('#memory-view').selectOption('history');assert.ok((await p.locator('[data-memory-version]').innerText()).includes('Version relation'));});
 await p.locator('.sidebar [data-page="settings"]').click();
 await p.locator('main [data-page="settings/access"]').click();
 await p.locator('main [data-page="settings/agent-scope"]').click();
 await step('Question preview controls are in English',async()=>{assert.ok((await p.locator('[data-question-context]').innerText()).includes('Preview initial context for a question'));await p.locator('#context-question').fill('界面设计');await click(p,'preview-question-context');assert.ok((await p.locator('[data-context-result]').innerText()).includes('no model called'));});
});
const report={candidate:input,sha256:crypto.createHash('sha256').update(await fs.readFile(input)).digest('hex'),browser:'Chromium 133.0.6943.16',scope:'Generated HTML UI; visible DOM controls only; no backend or model calls',created_at:new Date().toISOString(),scenarios:records.map(({id,status,steps,error})=>({id,status,steps:steps.length,error})),all_passed:records.every(r=>r.status==='passed')};
await fs.writeFile(path.join(output,'journeys.json'),JSON.stringify(records,null,2)+'\n');await fs.writeFile(path.join(output,'index.json'),JSON.stringify(report,null,2)+'\n');if(!report.all_passed)process.exitCode=1;
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
