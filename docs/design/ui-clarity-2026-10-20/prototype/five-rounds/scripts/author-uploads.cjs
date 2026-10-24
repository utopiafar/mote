const fs=require('node:fs/promises'),path=require('node:path');
const {openCandidate,observe}=require('./browser-session.cjs');
(async()=>{
 const folder=process.argv[2]||'work/r34';
 for(const platform of ['web','mac','android']){
  const out=path.resolve('work/author-uploads-r34',platform);await fs.mkdir(out,{recursive:true});
  const s=await openCandidate(path.resolve(folder,platform+'.html'),{viewport:platform==='android'?{width:390,height:844}:{width:1440,height:1000},url:'https://mote-prototype.invalid/?reset=1&state=empty#/import'}),p=s.page,log=[];
  async function snap(name){log.push({name,...await observe(p)});await p.screenshot({path:path.join(out,name+'.png')});}
  const click=a=>p.locator('[data-action="uq-'+a+'"]').first().click();
  const open=async id=>{const d=p.locator('#'+id);if(await d.getAttribute('open')===null)await d.locator(':scope > summary').click();};
  try{
   await p.locator('[data-action="focus-choose-files"]').click();await p.locator('[data-action="focus-sample-file"][data-index="0"]').click();
   const context='这是我的研究笔记。\n引用属于受访者；时间是北京时间。';await p.locator('#focus-import-instruction').fill(context);
   await p.locator('#uq-conditions > summary').click();await p.locator('#uq-demo-mode').selectOption('uploading');await p.locator('[data-action="focus-submit-import"]').click();
   const q=p.locator('[data-queue-id]').first(),id=await q.getAttribute('data-queue-id');await snap('01-upload-progress');
   if(!((await q.innerText()).includes('840 B / 2,400 B')))throw Error('Per-item bytes missing');
   await click('pause');if(await q.getAttribute('data-phase')!=='paused')throw Error('Pause not retained');
   await click('continue');await open('uq-states-'+id);await click('fail');
   await click('continue');if(await q.getAttribute('data-queue-id')!==id)throw Error('Retry created another submission');
   await open('uq-states-'+id);await click('lose');await click('reselect');
   if(!(await p.locator('[role="dialog"]').innerText()).includes(context))throw Error('Reselect lost context');
   await p.locator('#uq-reselect-input').setInputFiles({name:'wrong.md',mimeType:'text/markdown',buffer:Buffer.from('x')});
   if(!(await p.locator('#uq-reselect-error').innerText()).includes('不一致'))throw Error('Wrong file accepted');await snap('02-wrong-file-retains-context');
   await click('sample-reselect');await click('continue');await open('uq-states-'+id);await click('advance');
   if(await q.getAttribute('data-phase')!=='submitting')throw Error('Submitting receipt state missing');await snap('03-waiting-central-receipt');
   await open('uq-states-'+id);await click('advance');
   if(await q.getAttribute('data-phase')!=='submitted')throw Error('Central receipt missing');
   await open('uq-details-'+id);await click('remove');await click('confirm-remove');
   if(await p.locator('[data-queue-id]').count())throw Error('Local queue item remains');
   await p.locator('main [data-page="imports"]').first().click();await p.locator('[data-page="import/details/'+id+'"]').click();
   if(!(await p.locator('main').innerText()).includes(context))throw Error('Removing local queue deleted context/archive');await snap('04-received-import-retained');
   if(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth+2))throw Error('Horizontal overflow');
   if(s.errors.length)throw Error(s.errors.join(';'));console.log(JSON.stringify({platform,pass:true,steps:log.length,submission:id,errors:s.errors}));
  }catch(e){console.log(JSON.stringify({platform,errors:s.errors,dom:await observe(p)}));throw e;}finally{await fs.writeFile(path.join(out,'observations.json'),JSON.stringify(log,null,2));await s.browser.close();}
 }
})().catch(e=>{console.error(e);process.exit(1)});
