require('./fixture-background.cjs');
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
    const config = ${JSON.stringify({
      path: join(root, 'mote.yaml'), privateCredential: {token, tokenPath: 'generated-only'},
      initialDocument: {
        version: 1, revision: 0, storage: {dataDir: join(root, 'data'), maxExportBytes: 1000000},
        server: {host: '127.0.0.1', port, allowedOrigins: []}, execution: {insightIntervalHours: 0},
        models: {
          deployment: {model: '', apiKey: '', allowUnauthenticatedLocal: false, protocol: 'deepseek', reasoningEffort: 'high'},
          embedding: {model: '', baseUrl: '', apiKey: ''},
        },
        diagnostics: {level: 'silent'},
      },
    })};
    const {app} = await buildApp(config, {backgroundWorker:false, agent: {configured:true, close:async()=>{}, query:async input=>{
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
  async function field(selector, value) {
    await js(`(()=>{const field=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field),'value').set.call(field,${JSON.stringify(value)});field.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  }
  async function send(question) {
    await field('textarea[aria-label="向 Mote 提问"]', question);
    await click('发送');
  }
  async function screenshot(name) {await delay(350); await js('window.scrollTo(0,0);new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))'); assert.equal(await js('document.documentElement.scrollWidth<=window.innerWidth'), true, name + ' no overflow'); writeFileSync(join(output, name + '.png'), (await wc.capturePage()).toPNG());}
  const readyTurns = count => until(() => js(`document.querySelector('.chat-page[aria-busy="false"] textarea:not(:disabled)')&&document.querySelectorAll('.conversation-turn[data-state="completed"], .conversation-turn[data-state="failed"], .conversation-turn[data-state="cancelled"]').length===${count}`), count + ' saved turns');
  await window.loadURL(endpoint);
  await click('登录 Mote');
  await field('.connect-modal input[type=password]', token);
  await click('登录并继续');
  const waitForSession = () => until(() => js(`document.querySelector('[data-session="ready"]')`), 'authenticated session');
  await waitForSession();
  await click('聊天'); await readyTurns(0);
  await send('合成计划：周末去海边散步'); await readyTurns(1);
  const main = await request('/api/conversations/main');
  assert.equal(main.status, 200);
  const {id} = await main.json();
  async function readConversation() {
    const response = await request('/api/conversations/' + id);
    assert.equal(response.status, 200);
    const conversation = await response.json();
    assert.equal(conversation.id, id);
    return conversation;
  }
  const saved = await readConversation();
  assert.equal(saved.turnCount, 1);
  assert.equal(saved.turns[0].question, '合成计划：周末去海边散步');
  await send('那要准备什么？'); await readyTurns(2);
  assert.ok(await js(`document.querySelector('.conversation-turn:last-of-type').textContent.includes('已有 1 轮')`));
  await click('资料库'); await click('聊天'); await readyTurns(2);
  await send('fixture-failure');
  await until(() => js(`document.querySelector('.conversation-turn[data-state="failed"] [role=alert]')`), 'model failure');
  await until(() => js(`!document.querySelector('[aria-label="向 Mote 提问"]').disabled`), 'failed answer unlocks composer');
  const failedConversation = await readConversation();
  assert.equal(failedConversation.turnCount, 3, 'failure remains visible as a saved turn');
  assert.equal(failedConversation.turns.at(-1).status, 'failed', 'failed turn is marked failed');
  assert.equal(failedConversation.turns.at(-1).question, 'fixture-failure', 'failed question is retained');
  assert.equal(await js(`document.querySelector('.conversation-turn[data-state="failed"] .asked-question').textContent`), 'fixture-failure');
  await stopServer(); await startServer();
  await new Promise(resolve => {wc.once('did-finish-load', resolve); wc.reload();});
  await waitForSession(); await readyTurns(3);
  await send('继续刚才的计划'); await readyTurns(4);
  const rows = readFileSync(queries, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.at(-1).conversation.turns.length, 2, 'resumed server sends stored history to model');
  assert.equal(rows.at(-1).conversation.turns[0].question, '合成计划：周末去海边散步');
  await screenshot('conversations-desktop'); window.setSize(430, 1000); await screenshot('conversations-mobile'); window.setSize(1360, 1000);
  await send('fixture-delayed-navigation');
  await until(() => existsSync(queries) && readFileSync(queries, 'utf8').includes('fixture-delayed-navigation'), 'model request started');
  await click('资料库');
  await until(() => js('!document.querySelector(".chat-page")'), 'chat closes during pending answer');
  writeFileSync(released, 'generated-fixture-release');
  await until(async () => (await readConversation()).turns.some(turn => turn.question === 'fixture-delayed-navigation' && turn.status === 'completed' && turn.result?.answer), 'answer persists after leaving');
  await click('聊天'); await readyTurns(5);
  assert.equal(await js(`document.querySelector('.conversation-turn:last-of-type .asked-question').textContent`), 'fixture-delayed-navigation');
  await send('fixture-cancel');
  await until(() => js(`document.querySelector('.conversation-turn:last-of-type[data-state="running"] .asked-question')?.textContent === 'fixture-cancel'`), 'submitted question is running');
  await click('停止这条回答');
  await readyTurns(6);
  const cancelled = (await readConversation()).turns.at(-1);
  assert.equal(cancelled.question, 'fixture-cancel');
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.result, undefined, 'cancelled turn has no saved answer');
  assert.equal(await js(`document.querySelector('textarea[aria-label="向 Mote 提问"]').disabled`), false, 'cancel unlocks composer');
  await click('记录');await until(()=>js('Boolean(document.querySelector("#note-text"))'),'note composer');
  assert.equal(await js('Boolean(document.querySelector("#note-mood"))'),false);
  await js(`document.querySelector('.note-more > summary').click()`);
  await js(`(()=>{const input=document.querySelector('input[type=file][accept="image/*,audio/*"]');const transfer=new DataTransfer();transfer.items.add(new File([new Uint8Array([82,73,70,70,0,0,0,0,87,65,86,69])],'fixture.wav',{type:'audio/wav',lastModified:1700000000000}));input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await until(()=>js('document.body.innerText.includes("已添加 1 个附件")'),'audio archived');
  await field('#note-text', 'Generated attached note');
  await click('保存');
  await until(async()=> (await (await request('/api/notes')).json()).items.some(n=>n.ocrText==='Generated attached note'),'note attached');
  const note=(await (await request('/api/notes')).json()).items.find(n=>n.ocrText==='Generated attached note');assert.equal(note.metadata.attachments.length,1);
  const file=await request('/api/files/'+note.metadata.attachments[0]);assert.equal(file.status,200);assert.equal((await file.json()).sizeBytes,12);
  assert.deepEqual(errors, []);
  writeFileSync(join(output, 'result.json'), JSON.stringify({passed: true, generatedOnly: true, checks: ['durable main conversation history', 'navigation and browser reload', 'central restart', 'leaving during pending answer', 'stored follow-up model context', 'failed turn preserves history and question', 'cancelled turn has no saved answer', 'desktop/mobile layout']}, null, 2));
  console.log('PASS: generated main conversation history, continuation, restart, failure, cancellation and responsive UI.');
}
async function finish(code) {if (window && !window.isDestroyed()) window.destroy(); try {await stopServer();} finally {rmSync(root, {recursive: true, force: true}); app.exit(code);}}
run().then(() => finish(0), error => {console.error(error.stack); void finish(1);});
