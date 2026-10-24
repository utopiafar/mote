const fs=require('node:fs/promises'),path=require('node:path');
const {openCandidate,observe}=require('./browser-session.cjs');
(async()=>{
  const folder=process.argv[2]||'work/root-r32';
  for(const platform of ['web','mac','android']){
    const revision=folder.match(/r(\d+)/)?.[1]||'32';
    const out=path.resolve('work/author-connections-r'+revision,platform);await fs.mkdir(out,{recursive:true});
    const s=await openCandidate(path.resolve(folder,platform+'.html'),{viewport:platform==='android'?{width:390,height:844}:{width:1440,height:1000},url:'https://mote-prototype.invalid/?reset=1&state=populated#/setup/mcp'});
    const p=s.page,log=[];
    async function take(name){log.push({name,...await observe(p)});await p.screenshot({path:path.join(out,name+'.png')});}
    const click=a=>p.locator('[data-action="cn-'+a+'"]').first().click();
    async function nav(route){await p.goto('https://mote-prototype.invalid/?reset=1&state=populated#/'+route);await p.waitForTimeout(120);}
    try{
      await click('mcp-demo');await click('mcp-list');
      await p.locator('[data-cn-select="r1"]').check();await click('mcp-import');await take('00-mcp-result');
      if(!(await p.locator('main').innerText()).includes('新增 1'))throw Error('MCP result missing');
      await click('mcp-import');if(!(await p.locator('main').innerText()).includes('重复 1')||!(await p.locator('main').innerText()).includes('新增 0'))throw Error('MCP per-attempt counts incorrect');
      await take('01-mcp-selected-and-duplicate');
      await nav('catalog');if(await p.locator('#cx-catalog-recordings').getAttribute('open')===null)await p.locator('#cx-catalog-recordings > summary').click();
      await p.locator('[data-page="setup/recordings/feishu-personal"]').click();
      if(await p.locator('#cn-vendor').inputValue()!=='lark')throw Error('Catalog did not reach Lark recording workflow');
      await click('demo-config');await click('save-connection');await click('authorize');
      await p.locator('#cn-auth-demo > summary').click();await click('auth-success');
      await p.locator('[data-action="cn-tab"][data-tab="scope"]').click();
      const context='这是项目讨论录音。\n甲方建议是引用，不是我的承诺。';
      await p.locator('#cn-context').fill(context);
      await click('start-recordings');
      if(!(await p.locator('main').innerText()).includes('请先保存当前录音说明'))throw Error('context ACK gate absent');
      await click('save-context');await click('start-recordings');await take('02-separate-transcript-audio');
      await click('retry-step');await take('03-audio-retry');
      await nav('catalog');if(await p.locator('#cx-catalog-recordings').getAttribute('open')===null)await p.locator('#cx-catalog-recordings > summary').click();
      await p.locator('[data-page="setup/recordings/dingtalk-personal"]').click();
      if(await p.locator('#cn-vendor').inputValue()!=='dingtalk')throw Error('DingTalk catalog vendor wrong');
      await take('03b-dingtalk-catalog-entry');
      await nav('setup/google');await click('demo-config');await click('save-connection');await click('authorize');
      await p.locator('#cn-auth-demo > summary').click();await click('auth-success');
      await p.locator('[data-action="cn-tab"][data-tab="scope"]').click();await click('list-calendars');
      await p.locator('[data-cn-select="work"]').check();await click('save-calendars');await click('sync-calendars');
      const syncText=await p.locator('main').innerText();
      if(syncText.includes('尚未选择接收范围')||syncText.includes('尚未执行同步')||!syncText.includes('已有归档结果'))throw Error('Google sync retains stale state');
      await take('03c-google-actual-result');
      await nav('setup/nas');await p.locator('#cn-title').fill('NAS 研究资料');await p.locator('#cn-url').fill('smb://nas.example.invalid/research');
      await click('save-reference');await take('04-reference-no-body');
      await nav('library');await take('05-library-focused');
      const overflow=await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth+2);
      if(overflow)throw Error('horizontal overflow');
      if(s.errors.length)throw Error(s.errors.join(';'));
      console.log(JSON.stringify({platform,pass:true,steps:log.length,errors:s.errors}));
    }catch(e){console.log(JSON.stringify({errors:s.errors,text:await p.locator('body').innerText()}));throw e;}finally{await fs.writeFile(path.join(out,'observations.json'),JSON.stringify(log,null,2));await s.browser.close();}
  }
})().catch(e=>{console.error(e);process.exit(1)});
