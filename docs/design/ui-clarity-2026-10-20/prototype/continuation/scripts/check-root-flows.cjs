const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { openCandidate, observe, saveEvidence } = require('./browser-session.cjs');

const input = path.resolve(process.argv[2] || path.join(__dirname, '../work/integration.html'));
const output = path.resolve(process.argv[3] || path.join(__dirname, '../evidence/root-focused'));
const scenarios = [];

async function scenario(name, url, run) {
  if (process.argv[4] && !name.includes(process.argv[4])) return;
  const session = await openCandidate(input, {url});
  const {page} = session;
  const record = {name, url, steps:[], status:'passed'};
  const step = async (description, action, expected) => {
    await action();
    const dom = await observe(page);
    if (expected) await expected(dom);
    record.steps.push({description, result:'passed', rendered:dom});
  };
  try { await run(page,step); assert.deepEqual(session.errors,[]); await saveEvidence(page,output,name); }
  catch(e) { record.status='failed'; record.error=e.message; await saveEvidence(page,output,name+'-failure'); }
  finally { await session.browser.close(); scenarios.push(record); }
}
const click = (page,action) => page.locator('[data-action="'+action+'"]').filter({visible:true}).first().click();
const go = (page,destination) => page.locator('[data-action="go"][data-page="'+destination+'"]').filter({visible:true}).first().click();

(async()=>{
 await fs.mkdir(output,{recursive:true});
 await scenario('memory-full-content','https://mote-prototype.invalid/#/memories',async(page,step)=>{
  const original=await page.locator('#memory-text').innerText();
  assert.equal(original,'偏好入口简洁、按任务组织的界面。复杂设置放在相关上下文里。');
  await step('Continue the visible two-sentence memory',()=>click(page,'continue-memory'));
  await step('Open the result and compare the complete adopted content',()=>go(page,'activity/memory-continuation'),async()=>assert.equal(await page.locator('.evidence-box p').innerText(),original));
  await step('Return to the memory',()=>go(page,'memories'));
  await step('Read original history',()=>click(page,'memory-history'),async()=>assert.ok((await page.locator('[data-history-memory="original"]').innerText()).includes(original)));
  await click(page,'close-modal');
  await click(page,'correct-memory');
  await step('Draft a two-line correction',()=>page.locator('#memory-correction').fill('入口需要明确说明用途。\n资料与记忆分别管理。'));
  await step('Close without saving: current memory remains unchanged',()=>click(page,'close-modal'),async()=>assert.equal(await page.locator('#memory-text').innerText(),original));
  await step('Reopen the correction draft',()=>click(page,'correct-memory'),async()=>assert.equal(await page.locator('#memory-correction').inputValue(),'入口需要明确说明用途。\n资料与记忆分别管理。'));
  await step('Save the correction',()=>click(page,'save-correction'),async()=>assert.equal(await page.locator('#memory-text').innerText(),'入口需要明确说明用途。 资料与记忆分别管理。'));
  await click(page,'continue-memory');
  await step('Continue from the complete saved correction',()=>go(page,'activity/memory-continuation'),async()=>assert.equal(await page.locator('.evidence-box p').innerText(),'入口需要明确说明用途。 资料与记忆分别管理。'));
 });
 await scenario('note-offline-sync','https://mote-prototype.invalid/?state=empty#/notes',async(page,step)=>{
  const text='离线评审笔记\n第二行必须保留。';
  await step('Write a two-line note',()=>page.locator('#note-text').fill(text));
  await click(page,'attach');
  await page.getByRole('button',{name:'产品草图.png',exact:true}).click();
  await page.getByText('演示网络状态',{exact:true}).click();
  await click(page,'toggle-note-network');
  await step('Save offline with an attachment',()=>click(page,'save-note'),async()=>assert.equal(await page.locator('[data-queued-note]').count(),1));
  await go(page,'library');
  await step('Return to notes and find the same local copy',()=>go(page,'notes'),async()=>assert.equal(await page.locator('[data-queued-note]').count(),1));
  await step('Open the pending copy',()=>click(page,'open-queued-note'),async()=>{const body=await page.locator('[role=dialog]').innerText();assert.ok(body.includes('第二行必须保留。'));assert.ok(body.includes('产品草图.png'));});
  await click(page,'close-modal');
  await step('Retry while offline: content is retained with actionable feedback',()=>click(page,'retry-note'),async()=>{assert.equal(await page.locator('[data-queued-note]').count(),1);assert.ok((await page.locator('[role=status]').last().innerText()).includes('仍处于离线状态'));});
  await page.getByText('演示网络状态',{exact:true}).click();
  await click(page,'toggle-note-network');
  await step('Retry when online: one saved note replaces the pending copy',()=>click(page,'retry-note'),async()=>assert.equal(await page.locator('[data-queued-note]').count(),0));
  await step('Read the synchronized note and attachment',()=>page.getByRole('button',{name:'打开这条笔记',exact:true}).click(),async()=>{const body=await page.locator('.reading-body').innerText();assert.ok(body.includes('第二行必须保留。'));assert.ok(body.includes('产品草图.png'));});
  await click(page,'edit-note');
  await page.locator('#note-text').fill('待丢弃的本机编辑\n不覆盖已保存版本');
  await page.getByText('演示网络状态',{exact:true}).click();
  await click(page,'toggle-note-network');
  await click(page,'save-note');
  await step('Open discard confirmation',()=>click(page,'discard-queued-note'));
  await step('Cancel discard: pending content remains',()=>page.getByRole('button',{name:'取消',exact:true}).click(),async()=>assert.equal(await page.locator('[data-queued-note]').count(),1));
  await click(page,'discard-queued-note');
  await step('Discard only the pending edit',()=>click(page,'confirm-discard-note'),async()=>assert.equal(await page.locator('[data-queued-note]').count(),0));
  await step('Read the original saved note after discarding the local edit',()=>page.getByRole('button',{name:'打开这条笔记',exact:true}).click(),async()=>assert.ok((await page.locator('.reading-body').innerText()).includes('第二行必须保留。')));
 });
 await scenario('account-workspace-return','https://mote-prototype.invalid/?state=empty#/notes',async(page,step)=>{
  await page.locator('#note-text').fill('林同学的待同步笔记\n切换账号后应恢复。');
  await page.getByText('演示网络状态',{exact:true}).click();
  await click(page,'toggle-note-network');
  await click(page,'save-note');
  await go(page,'settings');await go(page,'settings/account');
  await step('Start logout',()=>click(page,'logout-demo'));
  await step('Confirm logout and reach a real login state',()=>click(page,'confirm-logout'),dom=>assert.ok(dom.text.includes('进入你的工作台')));
  await page.locator('#demo-username').fill('评审账号乙');await page.locator('#demo-password').fill('wrong');
  await step('Wrong demo credentials keep the user on the login form',()=>click(page,'demo-login'),async()=>{assert.ok(await page.getByRole('alert').isVisible());assert.equal(await page.locator('#demo-username').inputValue(),'评审账号乙');});
  await page.locator('#demo-password').fill('mote-demo');
  await step('Enter a new mock account with an empty workspace',()=>click(page,'demo-login'),async()=>{assert.ok((await page.locator('.account').innerText()).includes('评审账号乙'));assert.ok((await page.locator('main').innerText()).includes('从一份资料开始'));});
  await go(page,'notes');
  await step('The new account does not show the other account pending notes',async()=>{},async()=>{assert.equal(await page.locator('[data-queued-note]').count(),0);assert.equal(await page.locator('#note-text').inputValue(),'');});
  await go(page,'settings');await go(page,'settings/account');await click(page,'logout-demo');await click(page,'confirm-logout');
  await page.locator('#demo-username').fill('林同学');await page.locator('#demo-password').fill('mote-demo');
  await step('Re-enter the original mock account',()=>click(page,'demo-login'),async()=>assert.ok((await page.locator('.account').innerText()).includes('林同学')));
  await step('Find the original draft and pending note',()=>go(page,'notes'),async()=>{assert.equal(await page.locator('[data-queued-note]').count(),1);assert.equal(await page.locator('#note-text').inputValue(),'林同学的待同步笔记\n切换账号后应恢复。');});
 });
 const bytes=await fs.readFile(input);
 const index={scope:'Generated HTML mock UI only; rendered controls, no internal app state; no live services',candidate:path.basename(input),sha256:crypto.createHash('sha256').update(bytes).digest('hex'),browser:'Chromium 133.0.6943.16',created_at:new Date().toISOString(),scenarios:scenarios.map(({name,status,error,steps})=>({name,status,error,steps:steps.length})),all_passed:scenarios.every(s=>s.status==='passed')};
 await fs.writeFile(path.join(output,'journeys.json'),JSON.stringify(scenarios,null,2)+'\n');
 await fs.writeFile(path.join(output,'index.json'),JSON.stringify(index,null,2)+'\n');
 console.log(JSON.stringify(index));if(!index.all_passed)process.exitCode=1;
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
