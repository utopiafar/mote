// Independent native simulation journeys; all state comes from rendered controls.
const fs=require('node:fs/promises');
const path=require('node:path');
const {openCandidate}=require('./browser-session.cjs');
const {saveEvidence}=require('./evaluator-evidence.cjs');
const [candidate,dir,platform]=process.argv.slice(2);let s;
const log={platform,scope:'Generated native UI fixtures only; no operating-system or live upload validation',steps:[],checks:[],errors:[]};
const check=(label,observed)=>log.checks.push({label,observed});
async function button(name){await s.page.getByRole('button',{name,exact:true}).first().click();}
async function link(page){await s.page.locator('button[data-page='+JSON.stringify(page)+']:visible').first().click();}
async function summary(text){const l=s.page.locator('summary').filter({hasText:text}).first();if(!(await l.evaluate(e=>e.parentElement.open)))await l.click();}
async function step(name,fn){await fn?.();const d=await saveEvidence(s.page,dir,name);log.steps.push({name,url:d.url,evidence:[name+'.json',name+'.png']});return d;}
async function home(){await button('来源');await button('本机设置');}
(async()=>{try{
 s=await openCandidate(candidate,{viewport:platform==='android'?{width:390,height:844}:{width:1440,height:1000}});s.page.setDefaultTimeout(5000);
 await s.page.getByLabel('预览数据',{exact:true}).selectOption('populated');await button('来源');await step('01-source-state');
 await button('发送与本机队列');await step('02-upload-initial');await button('立即发送');await step('03-initial-send');
 await link('activity/native-queue');let d=await step('04-queue-before');check('queue has generated record rather than empty-only fixture',!d.text.includes('当前筛选没有记录'));
 if(platform==='mac'){
  await home();await link('settings/native-capture');await s.page.locator('#ns-capture-interval').fill('45');await button('保存设置');
  await button('预览范围并开始');await step('05-capture-preview');await button('按此范围开始');
  if(await s.page.getByRole('button',{name:'打开系统设置示例',exact:true}).count()){
   await step('06-required-permission');await button('打开系统设置示例');await button('模拟允许并返回');await button('返回原任务');
   await button('预览范围并开始');await button('按此范围开始');
  }
  d=await step('07-capture-running');check('capture starts after explicit permission flow',d.text.includes('正在记录'));check('saved interval retained',await s.page.locator('#ns-capture-interval').inputValue()==='45');
  await button('应用隐私与记录范围');await s.page.getByLabel('Safari 的记录级别',{exact:true}).selectOption({label:'仅应用活动'});await button('保存设置');await step('08-privacy-saved');
  await link('settings/native-gate');await button('查看待复核记录');await step('09-held-before');await button('返回');
  await s.page.locator('#ns-gate-enabled').setChecked(true);await s.page.locator('#ns-gate-literals').fill('生成样例禁止文字\n第三方测试字符串');await s.page.locator('#ns-gate-failure').selectOption({label:'允许上传'});await button('保存设置');
  await button('查看待复核记录');d=await step('10-held-after-policy');check('changing failure policy does not release held record',d.text.includes('查看并决定'));
  await button('查看并决定');await step('11-held-review');await button('明确放行此条');await step('12-held-released');
  await button('来源');await button('发送与本机队列');await s.page.locator('#ns-upload-mode').selectOption({label:'仅手动'});await button('保存设置');await button('暂停全部发送');await step('13-sending-paused');
  await home();await link('settings/native-capture');d=await step('14-capture-during-send-pause');check('capture continues while sending paused',d.text.includes('正在记录'));
  await button('暂停记录');await step('15-capture-paused');await button('来源');await button('发送与本机队列');d=await step('16-send-still-paused');check('capture pause preserves send pause',d.text.includes('恢复全部发送'));
 }else{
  await button('返回');await summary('网络与电源条件');await s.page.locator('#ns-upload-wifi').setChecked(true);await s.page.locator('#ns-upload-charging').setChecked(true);await s.page.locator('#ns-upload-battery').setChecked(true);await button('保存设置');await summary('演示连接条件');await button('模拟未充电');
  await home();await link('settings/native-connection');await button('扫描示例二维码');await button('本机预览邀请');await step('05-invitation-preview');await s.page.locator('#ns-bind-queue').setChecked(true);await button('确认连接');await step('06-connected');
  await button('来源');await button('发送与本机队列');await button('立即发送');d=await step('07-charge-block');check('manual send obeys charging condition',d.text.includes('等待充电'));
  await link('activity/native-reconcile');await button('核对并全量补传');await step('08-resend-review');await button('确认全量补传');d=await step('09-resend-block');check('full resend obeys saved conditions',d.text.includes('等待充电')||d.text.includes('当前发送条件未满足，未开始补传'));
  await button('返回');await summary('演示连接条件');await button('模拟充电');await button('切为计费网络');await button('立即发送');d=await step('10-wifi-block');check('manual send obeys unmetered condition',d.text.includes('等待非计费 Wi-Fi'));
  await button('切为非计费 Wi-Fi');await button('模拟低电量');await button('立即发送');d=await step('11-low-battery-block');check('manual send obeys low-battery condition',d.text.includes('系统低电量'));
  await button('恢复电量');await button('立即发送');await step('12-send-result');await link('activity/native-queue');d=await step('13-queue-after');
  check('nonempty queue outcome available',!d.text.includes('当前筛选没有记录'));
 }
 }catch(e){log.errors.push(e.message);if(s)await step('error-observed').catch(()=>{});}finally{if(s){log.browserErrors=s.errors;await s.browser.close();}await fs.mkdir(dir,{recursive:true});await fs.writeFile(path.join(dir,'journey.json'),JSON.stringify(log,null,2)+'\n');console.log(JSON.stringify(log));}
})();
