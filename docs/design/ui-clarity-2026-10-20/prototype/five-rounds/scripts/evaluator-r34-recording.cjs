// Independent R34 recording observations. Ordinary controls and standard rendered media properties only.
const fs=require('node:fs/promises');const path=require('node:path');
const {openCandidate}=require('./browser-session.cjs');const {saveEvidence}=require('./evaluator-evidence.cjs');
const [file,dir,platform,vendor='feishu-personal']=process.argv.slice(2);
let s;const log={platform,vendor,checks:[],steps:[],errors:[],scope:'Isolated synthetic HTML; no vendor access'};
const prose='R34 '+platform+' 录音：主持人与其他说话人各自保留身份，不推断为账户持有人的承诺。';
const check=(label,observed)=>log.checks.push({label,observed});
async function button(name){await s.page.getByRole('button',{name,exact:true}).first().click();}
async function summary(name){const e=s.page.locator('summary').filter({hasText:name}).first();if(!(await e.evaluate(x=>x.parentElement.open)))await e.click();}
async function step(name,fn){await fn?.();const d=await saveEvidence(s.page,dir,name);log.steps.push({name,url:d.url});return d;}
(async()=>{try{
 s=await openCandidate(file,{viewport:platform==='android'?{width:412,height:915}:{width:1440,height:1000}});s.page.setDefaultTimeout(5000);
 await s.page.locator('#preview-state').selectOption('populated');await button('来源');await button('连接来源');await summary('录音与转写');await s.page.locator('button[data-page="setup/recordings/'+vendor+'"]:visible').click();let d=await step('01-ordinary-catalog-entry');check('canonical vendor connection',d.url.endsWith(vendor));
 await button('填入演示连接');await button('保存连接');await button('开始授权');await summary('预览授权回执');await button('模拟授权成功');await button('选择范围');await s.page.locator('#cn-context').fill(prose);await button('保存录音资料说明');d=await step('02-context-ack');check('exact acknowledged explanation',d.text.includes(prose)&&d.text.includes('中央已确认'));
 d=await step('03-independent-transcript-audio',()=>button('保存范围并开始同步'));check('transcript readable while backup failed',d.text.includes('文稿已归档')&&d.text.includes('重试此步骤'));
 await button('阅读归档');d=await step('04-actual-transcript');const transcriptUrl=d.url;check('real transcript contains context',d.text.includes(prose));await s.page.goBack();d=await step('05-audio-retried',()=>button('重试此步骤'));
 d=await step('06-audio-detail',()=>button('打开音频原件示例'));const audioUrl=d.url;check('independent audio identity',audioUrl!==transcriptUrl&&audioUrl.includes('audio-1'));check('honest one-second test-tone explanation',d.text.includes('1 秒测试音')&&d.text.includes('不是厂商录音'));
 const audio=s.page.locator('audio:visible');const box=await audio.boundingBox();await audio.click({position:{x:26,y:box.height/2}});await s.page.waitForTimeout(180);const media=await audio.evaluate(el=>({duration:el.duration,currentTime:el.currentTime,paused:el.paused,controls:el.controls,readyState:el.readyState}));log.media=media;check('ordinary play control advances test audio',media.currentTime>0&&!media.paused&&media.duration===1);await step('07-playback');
 const downloadPromise=s.page.waitForEvent('download');await s.page.getByRole('link',{name:'下载合成 WAV 文件',exact:true}).click();const download=await downloadPromise;await download.saveAs(path.join(dir,'audio-example.wav'));check('download exists',(await fs.stat(path.join(dir,'audio-example.wav'))).size===16044);
 await button('阅读对应文稿');d=await step('08-corresponding-transcript');check('exact same transcript identity',d.url===transcriptUrl);await s.page.goBack();await summary('来源与文件信息');d=await step('09-source-audio-identity');check('audio provenance visible',d.text.includes('归档 ID')&&d.text.includes('audio/wav · 16044 bytes'));
 await button('返回录音归档结果');await button('选择范围');await summary('持续接收与连接管理');await button('断开授权');await button('查看结果');await button('打开音频原件示例');d=await step('10-audio-after-disconnect');check('same saved audio after disconnection',d.url===audioUrl);
}catch(e){log.errors.push(e.message);if(s)await step('error-observed').catch(()=>{});}finally{if(s){log.browserErrors=s.errors;await s.browser.close();}await fs.mkdir(dir,{recursive:true});await fs.writeFile(path.join(dir,'journey.json'),JSON.stringify(log,null,2)+'\n');console.log(JSON.stringify(log));}})();
