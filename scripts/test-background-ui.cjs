require('./fixture-background.cjs');
const { app, BrowserWindow, dialog, shell } = require('electron');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
if (process.argv.includes('--fail-on-start')) throw Error('Generated fixture startup failure');
const scratch = mkdtempSync(join(tmpdir(), 'mote-background-fixture-'));
app.setPath('userData', scratch);
app.on('window-all-closed', () => {});
const timeout = setTimeout(() => app.exit(1), 20000);
app.on('quit', () => { clearTimeout(timeout); rmSync(scratch, { recursive: true, force: true }); });

app.whenReady().then(async () => {
  assert.notEqual(process.env.MOTE_TEST_SHOW_UI, '1', 'This regression checks background mode only');
  let shows = 0, focuses = 0;
  app.on('browser-window-created', (_event, window) => {
    window.on('show', () => shows++); window.on('focus', () => focuses++);
  });
  // Cover implicit show, explicit show, and closing/recreating a window.
  for (const options of [{}, { show: true }, { show: false }]) {
    const window = new BrowserWindow({ width: 640, height: 480, ...options,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    window.show(); window.showInactive(); window.focus(); app.focus();
    await window.loadURL('data:text/html,' + encodeURIComponent(`<!doctype html><style>body{background:#def}main{height:3000px}</style>
      <input id="input"><button id="pointer" onclick="this.textContent='Clicked'">Generated pointer</button>
      <dialog><button>Generated close</button></dialog><main>Generated background fixture</main>`));
    const js = code => window.webContents.executeJavaScript(code);
    await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    await js('document.querySelector("input").focus()');
    window.webContents.focus();
    window.webContents.sendInputEvent({ type: 'char', keyCode: 'x' });
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(await js('document.querySelector("input").value'), 'x', 'Hidden renderer accepts real keyboard input');
    const point = await js(`(()=>{const r=document.querySelector('#pointer').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
    for (const type of ['mouseDown', 'mouseUp']) window.webContents.sendInputEvent({ type, button: 'left', clickCount: 1, ...point });
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(await js('document.querySelector("#pointer").textContent'), 'Clicked', 'Hidden renderer accepts real pointer input');
    await js('document.querySelector("dialog").showModal()');
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(await js('document.querySelector("dialog").open'), false, 'Native Chromium dialog lifecycle still runs');
    window.webContents.sendInputEvent({ type: 'mouseWheel', x: 300, y: 350, deltaY: -300, deltaX: 0, canScroll: true });
    // Wheel scrolling is applied asynchronously by the compositor; a loaded CI
    // runner can need longer than one fixed delay, so wait (bounded) for it.
    let scrolled = false;
    for (const deadline = Date.now() + 3000; !scrolled && Date.now() < deadline;) {
      await new Promise(resolve => setTimeout(resolve, 50));
      scrolled = await js('scrollY > 0');
    }
    assert(scrolled, 'Hidden renderer accepts real wheel input');
    assert.equal((await window.webContents.capturePage()).isEmpty(), false, 'Generated page can still be captured');
    assert.equal(window.isVisible(), false); assert.equal(window.isFocused(), false);
    await new Promise(resolve => { window.once('closed', resolve); window.close(); });
    assert.equal(window.isDestroyed(), true);
  }
  assert.equal(shows, 0); assert.equal(focuses, 0);
  assert.throws(() => dialog.showOpenDialog(), /Unexpected native dialog/);
  assert.throws(() => dialog.showMessageBox(), /Unexpected native dialog/);
  await assert.rejects(shell.openExternal('https://example.com'), /Unexpected external browser/);
  if (process.platform === 'darwin') assert.equal(app.dock.isVisible(), false);
  console.log(JSON.stringify({ ok: true, generatedFixtureOnly: true, windowsShown: shows, nativeWindowFocuses: focuses,
    windowRecreation: true, keyboardAndWheel: true, pointerInput: true, animationFrames: true, generatedPageCapture: true, unexpectedPromptsRejected: true }));
  app.quit();
}).catch(error => { console.error(error.stack); app.exit(1); });
