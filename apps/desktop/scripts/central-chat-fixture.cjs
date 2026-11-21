const {app, BrowserWindow} = require('electron');
const child = require('node:child_process');
const {mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} = require('node:fs');
const {tmpdir} = require('node:os');
const {join} = require('node:path');
const assert = require('node:assert/strict');
const {pageHash} = require('@mote/shared');
const {defaultConfig} = require('../dist/config');

const conversationPath = id => ['', 'api', 'conversations', encodeURIComponent(id)].join('/');
const composer = '.ask-form textarea';
const turns = '.chat-thread .conversation-turn';
const older = '.chat-older:enabled';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function chatWindow(name) {
  return new BrowserWindow({width: 1280, height: 900, show: false, webPreferences: {
    partition: name, contextIsolation: true, sandbox: true, nodeIntegration: false,
  }});
}

function chatControls(window, until) {
  const js = async code => {
    try {
      return await window.webContents.executeJavaScript(code);
    } catch (error) {
      throw new Error('Web fixture script failed: ' + code, {cause: error});
    }
  };
  const field = value => js('(() => {const e = document.querySelector(' + JSON.stringify(composer) + ');' +
    'Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(e, ' + JSON.stringify(value) + ');' +
    'e.dispatchEvent(new Event("input", {bubbles:true}));})()');
  const click = selector => js('document.querySelector(' + JSON.stringify(selector) + ').click()');
  const draft = () => js('document.querySelector(' + JSON.stringify(composer) + ').value');
  const questions = () => js('Array.from(document.querySelectorAll(".chat-thread .asked-question"), node => node.textContent)');
  const ready = () => js('Boolean(document.querySelector(\'.chat-page[aria-busy="false"] .ask-form textarea:not(:disabled)\'))');
  const completed = question => until(() => js('Array.from(document.querySelectorAll(\'.chat-thread .conversation-turn[data-state="completed"] .asked-question\')).some(node => node.textContent === ' + JSON.stringify(question) + ')'), 'saved answer for ' + question);
  const refresh = () => until(() => js('(() => {const button = Array.from(document.querySelectorAll(".shell-mobile-menu button")).find(node => node.textContent === "刷新资料"); if (!button || button.disabled) return false; button.click(); return true;})()'), 'global refresh');
  return {js, field, click, draft, questions, ready, completed, refresh};
}

function runDesktopChat(name, timeoutMs, waitMs, run) {
  const fixture = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  const origin = new URL(fixture.url);
  assert.equal(origin.hostname, '127.0.0.1');
  assert.equal(origin.protocol, 'http:');
  assert.equal(origin.origin, fixture.url);
  assert.ok(origin.port && !['47832', '47842', '47852', '59599'].includes(origin.port));
  const profile = mkdtempSync(join(tmpdir(), 'mote-desktop-' + name + '-'));
  const profiles = profile + '-profiles';
  const directory = join(profiles, 'dev');
  app.setPath('userData', profile);
  process.env.MOTE_PROFILE = 'dev';
  process.env.MOTE_URL = fixture.url;
  delete process.env.MOTE_TOKEN;
  delete process.env.MOTE_ENV_FILE;
  mkdirSync(directory, {recursive: true, mode: 0o700});
  writeFileSync(join(directory, 'config.json'), JSON.stringify({
    version: 4, developmentToken: fixture.token,
    config: {...defaultConfig(), serverUrl: fixture.url, credentialScope: 'owner', metadataEnabled: false,
      deviceName: 'Generated ' + name + ' client'},
  }), {mode: 0o600});
  writeFileSync(join(directory, 'storage-format.json'), JSON.stringify({version: 4}), {mode: 0o600});

  const execFile = child.execFile;
  const launches = [];
  // Intercept the OS launch only. The Mac mints and the Web renderer exchanges the real ticket.
  child.execFile = function(file, args, ...rest) {
    if (file === '/usr/bin/open' && args[0] === '-a' && args[1] === 'Google Chrome') {
      launches.push(args[2]);
      queueMicrotask(() => rest.at(-1)(null, '', ''));
      return {};
    }
    return execFile.call(this, file, args, ...rest);
  };
  async function until(check, label) {
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      if (await check()) return;
      await delay(30);
    }
    throw new Error('Timed out: ' + label);
  }
  async function api(path, body, extraHeaders) {
    const response = await fetch(fixture.url + path, {
      headers: {authorization: 'Bearer ' + fixture.token, 'content-type': 'application/json', ...extraHeaders},
      ...(body === undefined ? {} : {method: 'POST', body: JSON.stringify(body)}),
    });
    assert.ok(response.ok, path + ' returned ' + response.status);
    return response.json();
  }

  const timer = setTimeout(() => {console.error(name + ' UI timed out'); app.exit(1);}, timeoutMs);
  app.once('browser-window-created', (_event, mac) => {
    mac.webContents.once('did-finish-load', async () => {
      const js = code => mac.webContents.executeJavaScript(code);
      try {
        await until(() => js('Boolean(document.querySelector("#settings-fields:enabled"))'), 'desktop ready');
        const {config, running} = await js('window.mote.status()');
        assert.equal(config.serverUrl, fixture.url);
        assert.equal(running, false);
        assert.equal(mac.isVisible(), false);
        async function handoff(window, evidence, conversationId) {
          const count = launches.length;
          await js('window.mote.openCentral(...' + JSON.stringify(
            evidence ? ['ask', evidence, conversationId] : ['ask'],
          ) + ')');
          assert.equal(launches.length, count + 1);
          const url = new URL(launches.at(-1));
          assert.equal(url.origin, fixture.url);
          assert.equal(url.hash.split('?')[0], pageHash('chat'));
          assert.equal(url.search, '');
          const params = new URLSearchParams(url.hash.split('?')[1]);
          assert.match(params.get('loginTicket'), /^[a-zA-Z0-9_-]{43}$/);
          assert.equal(params.get('token'), null);
          assert.equal(params.get('evidence'), evidence ?? null);
          assert.equal(params.get('conversation'), conversationId ?? null);
          await window.loadURL(url.href);
          assert.equal(window.isVisible(), false);
        }
        await run({fixture, until, api, handoff});
        clearTimeout(timer);
        app.exit(0);
      } catch (error) {
        clearTimeout(timer);
        console.error(error);
        app.exit(1);
      }
    });
  });
  app.on('quit', () => {
    rmSync(profile, {recursive: true, force: true});
    rmSync(profiles, {recursive: true, force: true});
  });
  require('../dist/main');
}

module.exports = {runDesktopChat, chatWindow, chatControls, conversationPath, turns, older};
