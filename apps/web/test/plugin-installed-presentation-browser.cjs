require('../../../scripts/fixture-background.cjs');
const {app,BrowserWindow}=require('electron');
const {spawn,execFileSync}=require('node:child_process');
const {mkdtempSync,mkdirSync,rmSync,writeFileSync}=require('node:fs');
const {tmpdir}=require('node:os');
const {join,resolve}=require('node:path');
const assert=require('node:assert/strict');
const repository=resolve(__dirname,'../../..'),profile=mkdtempSync(join(tmpdir(),'mote-installed-page-browser-'));
const output=join(repository,'.mote/validation/plugin-page-browser');mkdirSync(output,{recursive:true});
app.setPath('userData',profile);
// Keep cleanup under this runner so destroying the hidden window cannot turn
// a failed assertion into Electron's ordinary successful quit.
app.on('window-all-closed',()=>{});
const node=process.env.MOTE_NODE_EXECUTABLE||execFileSync('which',['node'],{encoding:'utf8'}).trim();
const child=spawn(node,['--import','tsx','apps/web/test/plugin-installed-presentation-server.ts',join(repository,'apps/web/dist')],{cwd:repository,stdio:['ignore','pipe','pipe']});
let serverLog='',window;
child.stderr.on('data',value=>{serverLog+=value.toString();});
const fixture=new Promise((resolve,reject)=>{
  let stdout='';const timeout=setTimeout(()=>reject(Error('Fixture startup timed out: '+serverLog)),30000);
  child.once('exit',code=>{clearTimeout(timeout);reject(Error('Fixture exited before startup: '+code+' '+serverLog));});
  child.stdout.on('data',value=>{stdout+=value.toString();for(const line of stdout.split('\n')){try{const result=JSON.parse(line);if(result.origin){clearTimeout(timeout);resolve(result);return;}}catch{}}});
});
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function run(){
  const f=await fixture;await app.whenReady();
  window=new BrowserWindow({show:false,width:1280,height:900,webPreferences:{sandbox:true,nodeIntegration:false,contextIsolation:true}});
  const errors=[];window.webContents.on('console-message',event=>{if(event.level==='error'&&!event.message.includes('Failed to load resource'))errors.push(event.message);});
  const js=source=>window.webContents.executeJavaScript(source);
  const until=async(predicate,label)=>{const deadline=Date.now()+20000;while(!await predicate()){assert.ok(Date.now()<deadline,label+' '+await js('document.body.innerText.slice(0,1200)'));await pause(50);}};
  const http=async(path,method='GET',body)=>{const response=await fetch(f.origin+path,{method,headers:{authorization:'Bearer '+f.token,...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});assert.ok(response.ok,await response.clone().text());return response.json();};
  const command=async(id,action)=>{const view=await http('/api/plugins'),instance=view.instances.find(value=>value.id===id);return http('/api/plugin-instances/'+id+'/'+action,'POST',{expectedRevision:instance.revision,operationId:crypto.randomUUID()});};
  await window.loadURL(f.origin+'/');
  await js(`sessionStorage.setItem('mote.connection',JSON.stringify({token:${JSON.stringify(f.token)},viewScope:crypto.randomUUID()}));localStorage.setItem('mote.language','zh-CN')`);
  const route='#/plugin/'+encodeURIComponent(f.templateInstance)+'/'+encodeURIComponent(f.pageId);
  await window.loadURL(f.origin+'/'+route);
  await until(()=>js(`!!document.querySelector('iframe.plugin-custom-page')`),'the actual bootstrap resolves an installed deep link');
  const frame=()=>window.webContents.mainFrame.frames.find(value=>value.url.includes('/plugin-pages/'));
  await until(async()=>!!frame()&&await frame().executeJavaScript(`document.getElementById('content')?.classList.contains('hidden')===false`),'the installed document receives its real declared bridge');
  const security=await frame().executeJavaScript(`(()=>{let storage;try{localStorage.getItem('mote.connection');storage='readable';}catch{storage='blocked';}return {storage,hostApi:typeof window.mote,origin:window.origin,tokenInHtml:document.documentElement.innerHTML.includes(${JSON.stringify(f.token)})};})()`);
  assert.deepEqual(security,{storage:'blocked',hostApi:'undefined',origin:'null',tokenInHtml:false});
  await frame().executeJavaScript(`document.getElementById('text').value='Generated actual installed page';document.getElementById('submit').click();`);
  try{await until(()=>frame().executeJavaScript(`document.getElementById('items').textContent.includes('Generated actual installed page')`),'the page writes and refreshes actual domain state');}
  catch(error){console.error(JSON.stringify({browserErrors:errors,frame:await frame().executeJavaScript(`({text:document.body.innerText,pending:pending.size,sequence})`)}));throw error;}
  await js(`location.hash='#/preferences'`);
  await until(()=>js(`!!document.querySelector('.settings-directory-advanced')`),'settings navigation renders');
  await js(`document.querySelector('.settings-directory-advanced').open=true;[...document.querySelectorAll('.settings-directory-advanced button')].find(value=>value.textContent.includes(${JSON.stringify(f.pageTitle)})).click();`);
  await until(()=>js(`!!document.querySelector('iframe.plugin-custom-page')`),'the real contributed navigation opens the page');
  assert.equal(await js('location.hash'),route);
  await js(`location.hash='#/preferences'`);await until(()=>js(`!!document.querySelector('.settings-directory-advanced')`),'appearance selector renders');
  await js(`document.querySelector('.settings-directory-advanced').open=true;for(const label of ['外观 · 插件中心','展示方式 · 插件中心']){const select=document.querySelector('select[aria-label="'+label+'"]');if(!select)throw Error('Missing installed presentation selector');select.value=select.options[1].value;select.dispatchEvent(new Event('change',{bubbles:true}));}`);
  await until(()=>js(`document.documentElement.style.getPropertyValue('--mote-accent')==='#aabbcc'&&document.querySelector('.app-shell').dataset.detail==='stack'&&document.documentElement.dataset.uiLayout.endsWith('generated.browser.layout')`),'actual theme roles and compiled layout render');
  assert.equal(await js(`document.querySelector('.app-shell').dataset.detail`),'stack');
  const geometry=await js(`(()=>{const nav=document.querySelector('.sidebar').getBoundingClientRect(),main=document.querySelector('.main').getBoundingClientRect();return {navBottom:nav.bottom,navWidth:nav.width,mainTop:main.top,mainLeft:main.left,mainWidth:main.width,width:document.documentElement.clientWidth};})()`);
  assert.ok(geometry.mainLeft>=geometry.navWidth-1&&geometry.mainLeft>0,'sidebar rail stays at the left edge with content beside it: '+JSON.stringify(geometry));
  writeFileSync(join(output,'installed-theme-layout.png'),await window.webContents.capturePage().then(value=>value.toPNG()));
  await new Promise(resolve=>{window.webContents.once('did-finish-load',resolve);window.reload();});
  await until(()=>js(`document.documentElement.style.getPropertyValue('--mote-accent')==='#aabbcc'&&document.querySelector('.app-shell').dataset.detail==='stack'&&document.documentElement.dataset.uiLayout.endsWith('generated.browser.layout')`),'the real startup restores the saved presentation selection');
  await js(`location.hash=${JSON.stringify(route)}`);await until(()=>js(`!!document.querySelector('iframe.plugin-custom-page')`),'page reopens after startup');
  await command(f.templateInstance,'disable');await until(()=>js(`!document.querySelector('iframe.plugin-custom-page')&&document.documentElement.dataset.uiTheme==='mote.linear'&&document.documentElement.dataset.uiLayout==='mote.desktop'`),'polling withdraws the disabled page and restores the built-in presentation');
  const old=await fetch(f.origin+`/api/plugin-instances/${f.templateInstance}/pages/${f.pageId}/invoke`,{method:'POST',headers:{authorization:'Bearer '+f.token,'content-type':'application/json'},body:JSON.stringify({activationId:f.activationId,method:'state'})});assert.equal(old.status,409);
  await command(f.templateInstance,'enable');
  await until(()=>js(`!!document.querySelector('iframe.plugin-custom-page')`),'re-enabling mounts a fresh scope at the same deep link');
  await until(async()=>!!frame()&&await frame().executeJavaScript(`document.getElementById('items')?.textContent.includes('Generated actual installed page')`),'the fresh bridge reads retained domain state');
  await command(f.templateInstance,'disable');const view=await http('/api/plugins');await http('/api/plugins/'+encodeURIComponent(f.templatePackage)+'/uninstall','POST',{expectedRevision:view.revision,operationId:crypto.randomUUID()});
  await until(()=>js(`!document.querySelector('iframe.plugin-custom-page')`),'uninstall leaves no executable page');
  assert.deepEqual(errors,[]);
  return {passed:true,security,scope:'generated fixed release → production owner APIs → built Web bootstrap/registry → navigation/isolated document/typed bridge → real theme/layout → disable/re-enable/uninstall'};
}
run().then(async result=>{
  console.log(JSON.stringify(result));window?.destroy();child.kill('SIGTERM');await new Promise(resolve=>child.once('exit',resolve));rmSync(profile,{recursive:true,force:true});app.exit(0);
}).catch(async error=>{console.error(error);if(serverLog)console.error(serverLog);window?.destroy();child.kill('SIGTERM');await Promise.race([new Promise(resolve=>child.once('exit',resolve)),pause(5000)]);rmSync(profile,{recursive:true,force:true});app.exit(1);});
