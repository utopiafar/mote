const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {openCandidate,observe}=require('../../continuation/scripts/browser-session.cjs');
const root=path.resolve(__dirname,'..'),round=Number(process.argv[2]);
(async()=>{
 const file=path.join(root,'rounds','r'+round,'web.html'),out=path.join(root,'rounds','r'+round,'author','web-folder-target');
 await fs.mkdir(out,{recursive:true});
 const sha256=crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
 const s=await openCandidate(file,{viewport:{width:1440,height:1000},url:'https://mote-prototype.invalid/?reset=1&state=empty#/library'}),steps=[];
 async function snap(name){const dom=await observe(s.page);await fs.writeFile(path.join(out,name+'.json'),JSON.stringify(dom,null,2)+'\n');await s.page.screenshot({path:path.join(out,name+'.png'),fullPage:false});steps.push({name,url:s.page.url(),headings:dom.headings});return dom;}
 try{
  await s.page.getByRole('button',{name:/同步文件夹/}).first().click();await snap('01-server-target');
  await s.page.getByRole('button',{name:'填入示例服务器目录',exact:true}).click();
  await s.page.locator('#source-name').fill('R'+round+' 工作台目录');
  await s.page.locator('[data-action="save-source"]').click();
  if(!(await s.page.locator('main').innerText()).includes('管理工作台服务器文件夹'))throw Error('Saved server management target missing');
  await snap('02-server-saved');
  await s.page.locator('[data-action="pause-source"]').click();await snap('03-server-paused');
  await s.page.locator('[data-action="go"][data-page="sources"]:visible').first().click();
  const row=s.page.locator('.source-row').filter({hasText:'R'+round+' 工作台目录'});
  const rowText=await row.innerText();if(!rowText.includes('工作台服务器')||rowText.includes('Mac ·'))throw Error('Incorrect server source identity: '+rowText);
  await snap('04-server-overview');
  await row.getByRole('button',{name:'管理',exact:true}).click();
  await s.page.getByRole('button',{name:'连接 Mac 或 Android 设备',exact:true}).click();
  await s.page.getByRole('button',{name:'连接 Android 示例设备',exact:true}).click();
  const handoff=await s.page.locator('main').innerText();if(!handoff.includes('Android 示例设备')||!handoff.includes('文件夹同步'))throw Error('Named Android handoff missing');
  await snap('05-device-handoff');
  await s.page.getByRole('button',{name:'返回来源',exact:true}).click();
  await s.page.locator('.source-row').filter({hasText:'R'+round+' 工作台目录'}).getByRole('button',{name:'管理',exact:true}).click();
  if(!(await s.page.locator('main').innerText()).includes('管理工作台服务器文件夹'))throw Error('Device handoff leaked into existing server source');
  await snap('06-server-reopened');
  const result={round,sha256,scope:'Author bounded Web source identity and device-handoff UI check.',passed:true,steps,source_overview_text:rowText,errors:s.errors};
  await fs.writeFile(path.join(out,'result.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
 }finally{await s.browser.close();}
})().catch(e=>{console.error(e.stack);process.exitCode=1});
