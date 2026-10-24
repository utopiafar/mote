'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const assert=require('node:assert/strict');
const {openCandidate,observe}=require('../../continuation/scripts/browser-session.cjs');
const input=path.resolve(process.argv[2]);
const output=path.resolve(process.argv[3]);

async function main(){
 await fs.mkdir(output,{recursive:true});
 const session=await openCandidate(input,{viewport:{width:1440,height:1100}});
 const checks=[];
 const check=(name,data)=>checks.push({name,...data});
 const contentFrames=()=>session.page.frames().filter(f=>f!==session.page.mainFrame());
 async function readyFrames(expected){
  await session.page.waitForFunction(n=>document.querySelectorAll('iframe').length===n,expected);
  for(const frame of contentFrames()){
   await frame.locator('main').waitFor({state:'visible'});
   await frame.addStyleTag({content:'@font-face{font-family:MoteEvaluationCJK;src:url("https://mote-prototype.invalid/fonts/noto.otf")}body{font-family:MoteEvaluationCJK,sans-serif!important}button,input,select,textarea{font-family:inherit!important}'});
   await frame.evaluate(()=>document.fonts.ready);
  }
 }
 try{
  await readyFrames(3);
  check('three rendered surfaces',{count:contentFrames().length});
  const scales=await session.page.locator('.surface-card').evaluateAll(cards=>cards.map(card=>{const stage=card.querySelector('.frame-stage'),frame=card.querySelector('iframe');return{surface:card.dataset.surface,stage_width:stage.clientWidth,stage_height:stage.clientHeight,iframe_width:Number.parseInt(frame.style.width),iframe_height:Number.parseInt(frame.style.height),transform:getComputedStyle(frame).transform};}));
  assert.deepEqual(scales.map(s=>[s.surface,s.iframe_width,s.iframe_height]),[['web',1440,1000],['mac',1280,900],['android',390,844]]);
  check('reference viewport scaling',{surfaces:scales});
  const first=[];
  for(const frame of contentFrames()){
   first.push({title:await frame.title(),text:(await frame.locator('main').innerText()).slice(0,1400)});
  }
  check('initial visible UI',{frames:first});
  await session.page.screenshot({path:path.join(output,'three-platforms.png'),fullPage:false});
  await session.page.locator('[data-mode="android"]').click();
  await readyFrames(1);
  assert.equal(await session.page.locator('.surface-card').getAttribute('data-surface'),'android');
  check('single Android view',{frames:1,inner_width:await contentFrames()[0].evaluate(()=>innerWidth)});
  await session.page.locator('#theme').selectOption('dark');
  await readyFrames(1);
  await contentFrames()[0].waitForFunction(()=>document.body.classList.contains('dark'));
  check('theme control',{dark:true});
  await session.page.locator('#state').selectOption('populated');
  await readyFrames(1);
  const body=await contentFrames()[0].locator('body').innerText();
  assert.ok(body.length>200);
  check('populated reload',{visible_text:body.slice(0,1600)});
  const options=await session.page.locator('#round option').evaluateAll(elements=>elements.map(e=>e.value));
  if(options.length>1){
   await session.page.locator('#round').selectOption(options[0]);
   await readyFrames(1);
   assert.ok((await session.page.locator('#roundTitle').innerText()).includes('R'+options[0]));
   check('round change',{round:Number(options[0])});
  }
  await session.page.locator('[data-mode="web"]').click();
  await readyFrames(1);
  assert.equal(await session.page.locator('.surface-card').getAttribute('data-surface'),'web');
  check('single Web view',{frames:1,inner_width:await contentFrames()[0].evaluate(()=>innerWidth)});
  await session.page.locator('[data-mode="mac"]').click();
  await readyFrames(1);
  assert.equal(await session.page.locator('.surface-card').getAttribute('data-surface'),'mac');
  check('single Mac view',{frames:1,inner_width:await contentFrames()[0].evaluate(()=>innerWidth)});
  const final=await observe(session.page);
  await fs.writeFile(path.join(output,'visible-dom.json'),JSON.stringify(final,null,2)+'\n');
  assert.equal(session.errors.length,0,'Viewer or embedded candidate page error');
  check('browser errors',{errors:session.errors});
 }finally{await session.browser.close();}
 const report={candidate:input,sha256:crypto.createHash('sha256').update(await fs.readFile(input)).digest('hex'),at:new Date().toISOString(),scope:'Viewer controls and embedded iframe loading; prototype behavior is independently assessed in round reports.',checks,errors:session.errors};
 await fs.writeFile(path.join(output,'gallery-check.json'),JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify({checks:checks.length,errors:session.errors,output}));
}
main().catch(error=>{console.error(error.stack);process.exitCode=1});
