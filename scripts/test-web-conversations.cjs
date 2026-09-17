require('./fixture-language.cjs');
/** Real renderer + durable central SQLite; all messages and model answers are generated fixtures. */
const {app, BrowserWindow} = require('electron');
const {mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync} = require('node:fs');
const {tmpdir} = require('node:os');
const {join, resolve} = require('node:path');
const {pathToFileURL} = require('node:url');
const {spawn} = require('node:child_process');
const {randomBytes} = require('node:crypto');
const net = require('node:net');
const assert = require('node:assert/strict');
const root = mkdtempSync(join(tmpdir(), 'mote-conversations-')), repo = resolve(__dirname, '..');
const output = join(repo, '.mote/web-conversations');
mkdirSync(output, {recursive: true}); app.setPath('userData', join(root, 'browser'));
app.on('window-all-closed', () => {});
let server, window;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) {const end = Date.now() + 20000; while (Date.now() < end) {if (await fn()) return; await delay(80);} throw Error('Timed out: ' + label);}
async function freePort() {return new Promise((resolve, reject) => {const socket = net.createServer(); socket.on('error', reject); socket.listen(0, '127.0.0.1', () => {const port = socket.address().port; socket.close(() => resolve(port));});});}
async function stopServer() {if (server && server.exitCode === null) {server.kill('SIGTERM'); await Promise.race([new Promise(resolve => server.once('close', resolve)), delay(5000).then(() => {throw Error('Fixture server did not stop');})]);}}
async function run() {
  await app.whenReady();
  const port = await freePort(), endpoint = 'http://127.0.0.1:' + port, token = randomBytes(32).toString('hex');
  const runner = join(root, 'server.mjs'), queries = join(root, 'queries.jsonl'), released = join(root, 'release-answer');
  writeFileSync(runner, `import {buildApp} from ${JSON.stringify(pathToFileURL(join(repo, 'apps/server/dist/app.js')).href)};
    import {appendFileSync,existsSync} from 'node:fs'; import {randomUUID} from 'node:crypto';
    const config = ${JSON.stringify({dataDir: join(root, 'data'), token, tokenPath: 'fixture-only', host: '127.0.0.1', port,
      maxStorageBytes: 10000000, maxExportBytes: 1000000, retentionDays: 0, insightIntervalHours: 0, allowedOrigins: [],
      model: 'generated-fixture', modelBaseUrl: 'https://model.example.invalid/v1', apiKey: 'generated-fixture-key',
      modelProvider: 'custom', modelProtocol: 'openai-completions', modelReasoningEffort: 'auto', allowUnauthenticatedLocal: false,
      embeddingModel: '', embeddingBaseUrl: '', embeddingApiKey: '', diagnosticsEnabled: false})};
    const {app} = await buildApp(config, {agent: {configured:true, close:async()=>{}, query:async input=>{
      appendFileSync(${JSON.stringify(queries)}, JSON.stringify(input)+'\\n');
      if(input.question==='fixture-cancel') await new Promise(resolve=>{if(input.signal?.aborted)resolve();else input.signal?.addEventListener('abort',resolve,{once:true});});
      if(input.question==='fixture-failure') throw Error('Generated model failure');
      if(input.question==='fixture-delayed-navigation') while(!existsSync(${JSON.stringify(released)})) await new Promise(resolve=>setTimeout(resolve,50));
      await new Promise(resolve=>setTimeout(resolve, 100));
      return {answer:'合成回答：已有 '+(input.conversation?.turns.length??0)+' 轮。最初问题：'+(input.conversation?.turns[0]?.question??input.question),citations:[],trace:[],runId:randomUUID()};
    }}});
    await app.listen({host:'127.0.0.1',port:${port}});
    process.once('SIGTERM',()=>{void app.close().then(()=>process.exit(0));});`, {mode: 0o600});
  async function startServer() {
    const env = {...process.env}; for (const name of Object.keys(env)) if (name.startsWith('MOTE_')) delete env[name];
    server = spawn('node', [runner], {cwd: repo, env, stdio: ['ignore', 'ignore', 'pipe']});
    let errors = ''; server.stderr.on('data', chunk => {errors += chunk;});
    await until(async () => {if (server.exitCode !== null) throw Error('Fixture server exited: ' + errors); try {return (await fetch(endpoint + '/api/health')).ok;} catch {return false;}}, 'central node');
  }
  await startServer();
  const request = (path, method = 'GET', body) => fetch(endpoint + path, {method, headers: {Authorization: 'Bearer ' + token, 'Content-Type': 'application/json'}, ...(body ? {body: JSON.stringify(body)} : {})});
  assert.equal((await request('/api/devices/heartbeat', 'POST', {deviceId: 'fixture-phone', deviceName: '合成手机', platform: 'android', status: 'paused', queueDepth: 0})).status, 200);
  window = new BrowserWindow({width: 1360, height: 1000, show: false, webPreferences: {contextIsolation: true, sandbox: true, nodeIntegration: false}});
  const wc = window.webContents, js = code => wc.executeJavaScript(code), errors = [];
  wc.on('render-process-gone', (_event, details) => errors.push(details.reason));
  const click = async label => until(() => js(`(()=>{const b=Array.from(document.querySelectorAll('button')).find(b=>b.getClientRects().length&&(b.textContent.replace(/✦/g,'').trim()===${JSON.stringify(label)}||b.getAttribute('aria-label')===${JSON.stringify(label)}));if(!b||b.disabled)return false;b.click();return true;})()`), 'button: ' + label);
  async function input(text) {await js(`(()=>{const field=document.querySelector('[aria-label="向 Mote 提问"]');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(field,${JSON.stringify(text)});field.dispatchEvent(new Event('input',{bubbles:true}));})()`);}
  async function screenshot(name) {await delay(350); await js('window.scrollTo(0,0);new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))'); assert.equal(await js('document.documentElement.scrollWidth<=window.innerWidth'), true, name + ' no overflow'); writeFileSync(join(output, name + '.png'), (await wc.capturePage()).toPNG());}
  // After send, an empty composer intentionally disables Send; readiness is the textarea instead.
  const readyTurns = count => until(() => js(`document.querySelectorAll('.conversation-turn').length===${count}&&!document.querySelector('[aria-label="向 Mote 提问"]').disabled`), count + ' saved turns');
  await window.loadURL(endpoint);
  await js(`sessionStorage.setItem('mote.connection',${JSON.stringify(JSON.stringify({token}))});location.reload()`);
  await until(() => js(`document.body.innerText.includes('已登录 ·')`), 'login');
  await click('问一问'); await until(() => js(`document.querySelector('[aria-label="向 Mote 提问"]')`), 'conversation composer');
  await input('合成计划：周末去海边散步'); await click('发送问题'); await readyTurns(1);
  const saved = await (await request('/api/conversations')).json(); assert.equal(saved.items.length, 1);
  const id = saved.items[0].id;
  await input('那要准备什么？'); await click('发送问题'); await readyTurns(2);
  assert.ok(await js(`document.querySelector('.conversation-turn:last-of-type').textContent.includes('已有 1 轮')`));
  await click('新对话'); assert.equal(await js(`document.querySelectorAll('.conversation-turn').length`), 0);
  await input('另一段独立的合成对话'); await click('发送问题'); await readyTurns(1);
  let rows = readFileSync(queries, 'utf8').trim().split('\n').map(JSON.parse); assert.equal(rows[2].conversation, undefined, 'new conversation has no prior context');
  await click('总览'); await click('问一问'); await until(() => js(`document.querySelectorAll('.conversation-item').length===2`), 'history after navigation');
  await js(`Array.from(document.querySelectorAll('.conversation-item')).find(b=>b.textContent.includes('合成计划')).click()`); await readyTurns(2);
  await input('fixture-failure'); await click('发送问题'); await until(() => js(`document.querySelector('.conversation-content [role=alert]')`), 'model failure');
  assert.equal((await (await request('/api/conversations/' + id)).json()).turnCount, 2, 'failure preserves previous turns');
  assert.equal(await js(`document.querySelector('[aria-label="向 Mote 提问"]').value`), 'fixture-failure', 'failed question stays editable');
  await stopServer(); await startServer();
  await new Promise(resolve => {wc.once('did-finish-load', resolve); wc.reload();}); await until(() => js(`document.body.innerText.includes('已登录 ·')`), 'reload login'); await click('问一问');
  await until(() => js(`document.querySelectorAll('.conversation-item').length===2`), 'history after server restart');
  await js(`Array.from(document.querySelectorAll('.conversation-item')).find(b=>b.textContent.includes('合成计划')).click()`); await readyTurns(2);
  await input('继续刚才的计划'); await click('发送问题'); await readyTurns(3);
  rows = readFileSync(queries, 'utf8').trim().split('\n').map(JSON.parse); assert.equal(rows.at(-1).conversation.turns.length, 2, 'resumed server sends stored history to model');
  assert.equal(rows.at(-1).conversation.turns[0].question, '合成计划：周末去海边散步');
  await screenshot('conversations-desktop'); window.setSize(430, 1000); await screenshot('conversations-mobile'); window.setSize(1360, 1000);
  await click('删除此对话'); await click('确认删除对话'); await until(async () => (await request('/api/conversations/' + id)).status === 404, 'delete saved conversation');
  await click('刷新对话历史'); await until(() => js(`document.querySelectorAll('.conversation-item').length===1`), 'deleted history removed');
  await input('fixture-delayed-navigation'); await click('发送问题');
  await until(() => existsSync(queries) && readFileSync(queries, 'utf8').includes('fixture-delayed-navigation'), 'model request started');
  await click('总览'); writeFileSync(released, 'generated-fixture-release');
  await until(async () => (await (await request('/api/conversations')).json()).items.some(item => item.title === 'fixture-delayed-navigation'), 'answer persists after leaving');
  await click('问一问'); await until(() => js(`Array.from(document.querySelectorAll('.conversation-item')).some(b=>b.textContent.includes('fixture-delayed-navigation'))`), 'recover completed background answer');
  await js(`Array.from(document.querySelectorAll('.conversation-item')).find(b=>b.textContent.includes('fixture-delayed-navigation')).click()`); await readyTurns(1);
  await click('新对话');await input('fixture-cancel');await click('发送问题');
  await until(()=>js(`Array.from(document.querySelectorAll('button')).some(b=>b.textContent.includes('停止生成'))`),'stop button');
  await click('停止生成');await until(async()=> (await (await request('/api/query-runs')).json()).items.some(r=>r.status==='cancelled'),'cancel acknowledged');
  await until(()=>js(`!document.querySelector('textarea[aria-label="向 Mote 提问"]').disabled`),'cancel unlocks composer');
  assert(!(await (await request('/api/conversations')).json()).items.some(c=>c.title==='fixture-cancel'));
  await click('随手记');await until(()=>js('Boolean(document.querySelector("#note-text"))'),'note composer');
  assert.equal(await js('Boolean(document.querySelector("#note-mood"))'),false);
  await js(`(()=>{const input=document.querySelector('input[type=file][accept="image/*,audio/*"]');const transfer=new DataTransfer();transfer.items.add(new File([new Uint8Array([82,73,70,70,0,0,0,0,87,65,86,69])],'fixture.wav',{type:'audio/wav',lastModified:1700000000000}));input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await until(()=>js('document.body.innerText.includes("已添加 1 个附件")'),'audio archived');
  await js(`(()=>{const input=document.querySelector('#note-text');const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;setter.call(input,'Generated attached note');input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await click('保存并同步');
  await until(async()=> (await (await request('/api/notes')).json()).items.some(n=>n.ocrText==='Generated attached note'),'note attached');
  const note=(await (await request('/api/notes')).json()).items.find(n=>n.ocrText==='Generated attached note');assert.equal(note.metadata.attachments.length,1);
  const file=await request('/api/files/'+note.metadata.attachments[0]);assert.equal(file.status,200);assert.equal((await file.json()).sizeBytes,12);
  assert.deepEqual(errors, []);
  writeFileSync(join(output, 'result.json'), JSON.stringify({passed: true, generatedOnly: true, checks: ['durable multi-turn history', 'independent new conversations', 'navigation and browser reload', 'central restart', 'leaving during pending answer', 'stored follow-up model context', 'failed turn preserves history and question', 'delete history', 'desktop/mobile layout']}, null, 2));
  console.log('PASS: generated conversation history, continuation, restart, failure, deletion and responsive UI. No live model or personal content.');
}
async function finish(code) {if (window && !window.isDestroyed()) window.destroy(); try {await stopServer();} finally {rmSync(root, {recursive: true, force: true}); app.exit(code);}}
run().then(() => finish(0), error => {console.error(error.stack); void finish(1);});
