// Generated-only renderer fixture. Runs no collector, server, network or model.
const { app, BrowserWindow, session } = require('electron');
const { build } = require('esbuild');
const { mkdir, writeFile, readFile, chmod } = require('node:fs/promises');
const { resolve, join } = require('node:path');
const assert = require('node:assert/strict');
const output = process.env.MOTE_ASK_FIXTURE_OUTPUT;
if (!output || !require('node:path').isAbsolute(output)) throw Error('Set private absolute MOTE_ASK_FIXTURE_OUTPUT');
app.setPath('userData', join(output, 'profile'));
const id = '11111111-2222-4333-8444-555555555555';
const excerpt = '【生成随手记】实际发生于9月18日，9月27日补记。预算480元是旧估价，最终上限320元。活动日期、场地回复与完成结果均未知。\n'.repeat(8) + '原文末尾：蓝色夹子只是临时固定纸样。';
const answer = '**事件日期与补记日期不同。** [' + id + ']\n\n' + ['- **更正：**预算改为320元。','- **明确：**先做小样。','- **未知：**没有完成记录。'].map(x=>x+' ['+id+']').join('\n') + '\n\n' + '生成回答中的限定需要完整呈现。'.repeat(16);
let window;
const deadline = setTimeout(() => { app.exit(1); }, 30000);
app.whenReady().then(async () => {
  await mkdir(output, { recursive: true, mode: 0o700 }); await chmod(output, 0o700);
  const root = resolve(__dirname, '..');
  const entry = `import { renderAskAnswer, renderAskCitation } from ${JSON.stringify(join(root, 'src/ask-presentation.ts'))};\nwindow.fixtureRender = () => {const box=document.querySelector('#ask-messages');box.replaceChildren(); const article=document.createElement('article');const c=${JSON.stringify({id,appName:'生成随手记',capturedAt:'2026-09-27',excerpt})};const open=id=>window.fixtureOpened=id;article.append(renderAskAnswer(document,${JSON.stringify(answer)},[c],open),renderAskCitation(document,c,open));box.append(article);};`;
  await build({ stdin: { contents: entry, resolveDir: root, loader: 'ts' }, bundle: true, platform: 'browser', outfile: join(output, 'renderer.js') });
  const css = (await readFile(join(root,'src/design-tokens.css'),'utf8')) + '\n' + (await readFile(join(root,'src/styles.css'),'utf8'));
  await writeFile(join(output,'fixture.html'), `<!doctype html><meta charset="UTF-8"><style>${css}</style><main style="margin:0;padding:24px;width:100%"><h1>生成 Ask 布局回归</h1><div class="ask-layout"><aside class="panel">生成对话历史</aside><section class="panel"><div id="ask-messages"></div><p>回答已完成</p><textarea aria-label="你的问题"></textarea></section></div></main><script src="renderer.js"></script>`, {mode:0o600});
  session.defaultSession.webRequest.onBeforeRequest((details, done) => done({cancel:!details.url.startsWith('file:')}));
  window = new BrowserWindow({width:1140,height:833,show:false,webPreferences:{nodeIntegration:false,contextIsolation:true,backgroundThrottling:false}});
  await window.loadFile(join(output,'fixture.html'));
  const js = value => window.webContents.executeJavaScript(value);
  const legacy = await js(`(() => {const box=document.querySelector('#ask-messages');box.style.maxHeight='55vh';box.style.overflowY='auto';const article=document.createElement('article'),answer=document.createElement('p'),details=document.createElement('details'),summary=document.createElement('summary'),quote=document.createElement('p');answer.textContent=${JSON.stringify(answer)};summary.textContent='生成引用';quote.textContent=${JSON.stringify(excerpt)};details.append(summary,quote);article.append(answer,details);box.append(article);details.open=true;return {textLength:quote.textContent.length,boxBottom:box.getBoundingClientRect().bottom,quoteBottom:quote.getBoundingClientRect().bottom,scrollHeight:box.scrollHeight,clientHeight:box.clientHeight};})()`);
  assert(legacy.scrollHeight > legacy.clientHeight && legacy.quoteBottom > legacy.boxBottom, 'Legacy max-height clips expanded excerpt until inner scroll');
  await writeFile(join(output,'legacy.png'), (await window.webContents.capturePage()).toPNG());
  await js(`document.querySelector('#ask-messages').removeAttribute('style');window.fixtureRender();`);
  const results = [];
  for (const width of [1140,760]) {
    window.setSize(width,833);
    const visible = await js(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>{const details=document.querySelector('.ask-evidence details');details.open=true;const quote=document.querySelector('.ask-excerpt');const range=document.createRange();range.selectNodeContents(quote);range.collapse(false);quote.scrollIntoView({block:'end'});const box=document.querySelector('#ask-messages'),rect=quote.getBoundingClientRect();resolve({text:quote.textContent,overflow:getComputedStyle(box).overflowY,clientHeight:box.clientHeight,scrollHeight:box.scrollHeight,bottom:rect.bottom,viewport:innerHeight,buttons:document.querySelectorAll('.ask-inline-citation').length,strong:document.querySelectorAll('.ask-answer strong').length,lists:document.querySelectorAll('.ask-answer li').length});})))`);
    assert.equal(visible.text, excerpt); assert.equal(visible.overflow,'visible'); assert(visible.bottom <= visible.viewport+1 && visible.bottom > 0); assert.equal(visible.buttons,4); assert.equal(visible.lists,3);
    await js(`document.querySelector('.ask-inline-citation').click()`); assert.equal(await js('window.fixtureOpened'),id);
    await js(`window.fixtureOpened='';document.querySelector('.ask-evidence button').click()`); assert.equal(await js('window.fixtureOpened'),id);
    await writeFile(join(output,`current-${width}.png`), (await window.webContents.capturePage()).toPNG());
    results.push({width,...visible,text:undefined});
  }
  await writeFile(join(output,'report.json'),JSON.stringify({generated:true,modelCalls:0,collectorStarted:false,legacy,results},null,2),{mode:0o600});
  clearTimeout(deadline); window.destroy(); app.exit(0);
}).catch(async error => { await writeFile(join(output,'failure.txt'),String(error.stack),{mode:0o600}).catch(()=>{});clearTimeout(deadline); if(window)window.destroy();app.exit(1); });
