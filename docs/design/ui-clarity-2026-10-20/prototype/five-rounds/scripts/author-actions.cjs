const fs=require('node:fs/promises'),path=require('node:path');
const {openCandidate,observe}=require('./browser-session.cjs');
(async()=>{
 const folder=process.argv[2]||'work/root-r33';
 for(const platform of ['web','mac','android']){
  const out=path.resolve('work/author-actions',platform);await fs.mkdir(out,{recursive:true});
  const root='https://mote-prototype.invalid/?reset=1&state=populated';
  const s=await openCandidate(path.resolve(folder,platform+'.html'),{viewport:platform==='android'?{width:390,height:844}:{width:1440,height:1000},url:root+'#/todos/schedule'});
  const p=s.page,steps=[];
  const click=a=>p.locator('[data-action="ax-'+a+'"]').filter({visible:true}).first().click();
  async function take(name){const dom=await observe(p);steps.push({name,...dom});await p.screenshot({path:path.join(out,name+'.png')});if(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth+2))throw Error('Horizontal overflow: '+name);}
  const text=()=>p.locator('main').innerText();
  async function nav(route){await p.goto(root+'#/'+route);await p.waitForTimeout(100);}
  try{
   await p.locator('main [data-page="todos/review/suggestion-1"]').click();
   await click('calendar-target');await click('connect-calendar');
   await p.getByRole('button',{name:'继续核对',exact:true}).click();
   await p.locator('#ax-title').fill('独立核对后的日程');
   await p.locator('#ax-allDay').check();
   await p.locator('#ax-start').fill('2026-10-26');await p.locator('#ax-end').fill('2026-10-28');
   await p.locator('#ax-timezone').fill('Asia/Shanghai');
   await p.locator('#ax-event-notes > summary').click();
   await p.locator('#ax-location').fill('会议室 A');await p.locator('#ax-notes').fill('第一行说明\n第二行保留');
   await p.locator('#ax-target').selectOption('mac:personal');
   await click('freeze-review');await take('01-fixed-review');
   if(!(await text()).includes('结束日不包含当天')||!(await text()).includes('第二行保留'))throw Error('Fixed review lost event details');
   await p.locator('#ax-stale-demo > summary').click();await click('change-evidence');
   if(await p.locator('[data-action="ax-approve"]').count())throw Error('Stale approval remains available');
   if(await p.locator('#ax-title').inputValue()!=='独立核对后的日程')throw Error('Stale evidence lost draft');
   await take('02-stale-review');
   await click('freeze-review');await click('approve');
   if(!(await text()).includes('等待目标设备'))throw Error('Approval incorrectly claims write');
   await p.locator('#ax-execution-demo > summary').click();
   await p.locator('[data-action="ax-receipt"][data-state="uncertain"]').click();await take('03-uncertain');
   await click('verify-event');await take('04-verified-existing');
   if(!(await text()).includes('没有新建事件')||!(await text()).includes('synthetic-event-suggestion-1'))throw Error('Uncertain verification did not retain identity');
   await nav('todos');await p.locator('#todo-text').fill('无需日历的下一步');await click('add-todo');
   if(!(await text()).includes('没有截止日期'))throw Error('Optional due date missing');
   const row=p.locator('.ax-todo').filter({hasText:'无需日历的下一步'});await row.locator('[data-action="ax-complete-todo"]').click();
   await p.locator('#todo-filter').selectOption('已完成');await p.locator('.ax-todo').filter({hasText:'无需日历的下一步'}).locator('[data-action="ax-reopen-todo"]').click();
   await p.locator('#todo-filter').selectOption('未完成');await take('05-todo-reopened');
   if(!(await text()).includes('无需日历的下一步'))throw Error('Todo reopen missing');
   await nav('todos/discovery');await p.locator('#ax-enabled').check();await p.locator('[data-ax-device="mac"]').check();await click('save-discovery');
   await p.locator('#ax-device-change > summary').click();await click('revoke-review-device');await click('save-discovery');
   if(!(await text()).includes('请先刷新设备授权'))throw Error('Stale device saved without refresh');
   await click('refresh-devices');await click('save-discovery');await take('06-discovery-refresh');
   if(s.errors.length)throw Error(s.errors.join(';'));
   console.log(JSON.stringify({platform,pass:true,steps:steps.length,errors:s.errors}));
  }catch(e){console.log(JSON.stringify({platform,errors:s.errors,text:await p.locator('body').innerText()}));throw e;}finally{await fs.writeFile(path.join(out,'observations.json'),JSON.stringify(steps,null,2));await s.browser.close();}
 }
})().catch(e=>{console.error(e);process.exit(1)});
