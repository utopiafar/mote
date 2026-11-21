require('../../../scripts/fixture-background.cjs');
require('../../../scripts/fixture-language.cjs');
const {mkdirSync, writeFileSync} = require('node:fs');
const {join, resolve} = require('node:path');
const assert = require('node:assert/strict');
const {pageHash} = require('@mote/shared');
const {runDesktopChat, chatWindow, chatControls, conversationPath, turns, older} = require('./central-chat-fixture.cjs');

runDesktopChat('scope', 120000, 20000, async ({fixture, until, api, handoff}) => {
  const first = chatWindow('generated-scope-mac-browser');
  const second = chatWindow('generated-scope-web-browser');
  const chat = chatControls(first, until);
  const other = chatControls(second, until);
  const pending = 'Generated retained draft';
  const scopeNav = '.chat-composer-area nav:is([aria-label="参考记录"], [aria-label="查询范围"])';
  const selectorFor = kind => scopeNav + '[aria-label="' + (kind === 'strict' ? '查询范围' : '参考记录') + '"]';
  const hasScope = (client, kind) => client.js('Boolean(document.querySelector(' + JSON.stringify(selectorFor(kind)) + '))');
  const hasNoScope = client => client.js('!document.querySelector(' + JSON.stringify(scopeNav) + ')');
  const read = kind => api(conversationPath(fixture.ids[kind]));
  const out = resolve(__dirname, '../.mote/scope-ui');
  mkdirSync(out, {recursive: true});

  assert.equal(new Set(Object.values(fixture.ids)).size, 3);
  async function setMain(kind) {
    const id = fixture.ids[kind];
    assert.equal((await api('/fixture/main', {kind})).id, id);
    assert.equal((await api(conversationPath('main'))).id, id);
  }
  async function send(client, question, duplicate = false) {
    await client.field(question);
    if (duplicate) await client.js('(() => {const form = document.querySelector(".ask-form"); form.requestSubmit(); form.requestSubmit();})()');
    else await client.click('.ask-form .send-button:enabled');
    await client.completed(question);
  }

  await second.loadURL(fixture.url + '/' + pageHash('chat'));
  await until(() => other.js('(() => {const button = Array.from(document.querySelectorAll("button")).find(node => node.textContent.trim() === "登录 Mote"); if (!button) return false; button.click(); return true;})()'), 'separate Web sign-in');
  await until(() => other.js('Boolean(document.querySelector(".connect-modal input[type=password]"))'), 'Web login form');
  await second.webContents.executeJavaScript('(() => {const input = document.querySelector(".connect-modal input[type=password]");' +
    'Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, ' + JSON.stringify(fixture.token) + ');' +
    'input.dispatchEvent(new Event("input", {bubbles:true}));})()');
  await other.click('.connect-modal button[type=submit], .connect-modal form button.primary');
  await until(() => other.ready(), 'independent Web session');

  for (const [kind, index] of [['anchor', 0], ['strict', 1]]) {
    await setMain(kind);
    const evidenceId = fixture.evidenceIds[index];
    const initial = await read(kind);
    assert.equal(initial.id, fixture.ids[kind]);
    assert.deepEqual(initial.scope[kind === 'anchor' ? 'anchorEvidenceIds' : 'evidenceIds'], [evidenceId]);
    await handoff(first, 'capture:' + evidenceId, initial.id);
    await until(() => chat.js('document.querySelector(".evidence-reader")?.textContent.includes(' +
      JSON.stringify('Generated scope original ' + index) + ')'), 'authorized original for ' + kind);
    await chat.click('.evidence-reader .evidence-back');
    await until(() => chat.ready(), 'main chat after original');
    await until(() => hasScope(chat, kind), 'stored ' + kind + ' scope');

    await chat.field(pending);
    if (kind === 'anchor') {
      assert.equal((await chat.questions()).length, 20);
      await chat.click(older);
      await until(async () => (await chat.questions()).length === 21, '21 anchor turns');
      assert.ok(await hasScope(chat, kind));
    }
    await chat.click(selectorFor(kind) + ' button:first-of-type');
    await until(() => chat.js('document.querySelector(".evidence-reader")?.textContent.includes(' +
      JSON.stringify('Generated scope original ' + index) + ')'), 'exact original from the pinned scope');
    await chat.click('.evidence-reader .evidence-back');
    await until(() => chat.ready(), 'return to the same main chat');
    assert.equal(await chat.draft(), pending);

    const firstQuestion = 'Mac browser ' + kind + ' continuation';
    await send(chat, firstQuestion, true);
    assert.equal((await read(kind)).turnCount, initial.turnCount + 1);

    await other.refresh();
    await other.completed(firstQuestion);
    assert.ok(await hasScope(other, kind));
    await chat.field(pending);
    const secondQuestion = 'Web ' + kind + ' continuation';
    await send(other, secondQuestion);
    const saved = await read(kind);
    assert.equal(saved.turnCount, initial.turnCount + 2);
    assert.equal(saved.turns.at(-1).question, secondQuestion);
    await chat.refresh();
    await chat.completed(secondQuestion);
    assert.ok(await hasScope(chat, kind));
    assert.equal(await chat.draft(), pending);

    const reloaded = new Promise(resolve => second.webContents.once('did-finish-load', resolve));
    second.webContents.reload();
    await reloaded;
    await other.completed(secondQuestion);
    assert.ok(await hasScope(other, kind), 'Web reload restores the same scope');
    writeFileSync(join(out, kind + '-mac-handoff.png'), (await first.webContents.capturePage()).toPNG());
    writeFileSync(join(out, kind + '-web.png'), (await second.webContents.capturePage()).toPNG());
  }

  const seen = await api('/fixture/seen');
  for (const origin of ['Mac browser', 'Web']) {
    for (const [kind, index] of [['anchor', 0], ['strict', 1]]) {
      const calls = seen.filter(call => call.question === origin + ' ' + kind + ' continuation');
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0][kind === 'anchor' ? 'anchorEvidenceIds' : 'evidenceIds'], [fixture.evidenceIds[index]]);
      assert.equal(calls[0][kind === 'anchor' ? 'evidenceIds' : 'anchorEvidenceIds'], undefined);
    }
  }

  const changed = 'Other client changes scope';
  await api('/api/query', {conversationId: fixture.ids.strict, question: changed, anchorEvidenceIds: [fixture.evidenceIds[0]]});
  await chat.refresh();
  await chat.completed(changed);
  assert.ok(await hasScope(chat, 'anchor'));
  assert.equal(await chat.draft(), pending);

  const failures = [];
  const currentPath = conversationPath(fixture.ids.strict);
  first.webContents.session.webRequest.onCompleted({urls: [fixture.url + currentPath + '*']}, response => {
    if (response.statusCode >= 400) failures.push(response.statusCode);
  });
  const retry = '.chat-error[role=alert] button';
  await api('/fixture/fail', {}, {'x-fixture-status': '503'});
  await chat.refresh();
  await until(() => chat.js('Boolean(document.querySelector(".chat-error[role=alert] button"))'), 'transient read error');
  assert.deepEqual(failures, [503]);
  assert.ok(await hasScope(chat, 'anchor'), 'the last authorized scope is still visible during the transient failure');
  assert.equal(await chat.draft(), pending);
  await chat.click(retry);
  await until(() => chat.js('!document.querySelector(".chat-error[role=alert]")'), 'transient read retry');
  assert.ok(await hasScope(chat, 'anchor'));

  await api('/fixture/fail', {}, {'x-fixture-status': '403'});
  await chat.refresh();
  await until(() => chat.js('Boolean(document.querySelector(".chat-error[role=alert] button")) && !document.querySelector(' +
    JSON.stringify(turns) + ')'), 'forbidden read withdraws previous turns');
  assert.deepEqual(failures, [503, 403]);
  assert.ok(await hasNoScope(chat));
  assert.equal(await chat.draft(), pending);
  await handoff(first);
  await chat.completed(changed);
  assert.ok(await hasScope(chat, 'anchor'), 'a fresh Mac ticket restores the same main conversation');

  await chat.click(selectorFor('anchor') + ' button:last-of-type');
  assert.ok(await hasNoScope(chat), 'clearing the next-question scope leaves the conversation open');
  assert.ok((await chat.questions()).includes(changed));

  await setMain('plain');
  await handoff(first);
  await chat.completed('Generated plain');
  assert.ok(await hasNoScope(chat));
  assert.equal((await read('plain')).id, fixture.ids.plain);

  await setMain('strict');
  await handoff(first);
  await chat.completed(changed);
  assert.ok(await hasScope(chat, 'anchor'));
  await chat.js('location.hash = "#/preferences/session"');
  const logout = 'Array.from(document.querySelectorAll(".web-preferences button")).find(button => button.textContent === "退出登录")';
  await until(() => chat.js('Boolean(' + logout + ')'), 'web sign-out control');
  await chat.js(logout + '.click()');
  await chat.click('.modal[role=dialog] .primary');
  await chat.js('location.hash = ' + JSON.stringify(pageHash('chat')));
  await until(() => chat.js('Boolean(document.querySelector("[data-session=signed-out]"))'), 'signed-out chat');
  assert.ok(await hasNoScope(chat));
  assert.deepEqual(await chat.questions(), []);
  await other.refresh();
  await other.completed(changed);

  writeFileSync(join(out, 'result.json'), JSON.stringify({
    passed: true, actualMacRendererPreloadIpc: true, actualWebRenderer: true, actualHttpSqlite: true, liveModel: false,
    checks: ['anchor and strict main chats after a Mac handoff and in a separate Web session', 'exact authorized originals',
      '21-turn anchor page and draft survive reader return', 'one admission per continuation including duplicate submit',
      'persisted scope after reload and other-client change', '503 retry and 403 withdrawal with ticket re-login',
      'scope clear, plain main, and logout remove scope controls'],
  }, null, 2));
  console.log('PASS Mac-to-Central scope: anchor/strict, exact originals, one admission per submit, 503/403, re-login and sign-out.');
  first.destroy();
  second.destroy();
});
