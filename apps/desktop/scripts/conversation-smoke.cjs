require('../../../scripts/fixture-background.cjs');
require('../../../scripts/fixture-language.cjs');
const {mkdirSync, writeFileSync} = require('node:fs');
const {join, resolve} = require('node:path');
const assert = require('node:assert/strict');
const {runDesktopChat, chatWindow, chatControls, conversationPath, older} = require('./central-chat-fixture.cjs');

runDesktopChat('conversation', 60000, 15000, async ({fixture, until, api, handoff}) => {
  const web = chatWindow('generated-desktop-conversation');
  const chat = chatControls(web, until);
  const path = conversationPath(fixture.conversationId);
  const reads = [];
  web.webContents.session.webRequest.onCompleted({urls: [fixture.url + path + '*']}, response => {
    const url = new URL(response.url);
    if (response.method === 'GET' && url.pathname === path) {
      reads.push({cursor: url.searchParams.get('cursor'), status: response.statusCode});
    }
  });
  const firstPageReads = () => reads.filter(read => read.cursor === null && read.status === 200).length;
  const pageReads = () => reads.filter(read => read.cursor !== null);
  const waitForPage = (count, first) => until(async () => {
    const questions = await chat.questions();
    return questions.length === count && questions[0] === first;
  }, count + ' turns starting with ' + first);

  assert.equal((await api(conversationPath('main'))).id, fixture.conversationId);
  await handoff(web);
  await waitForPage(20, 'Generated question 26');
  await until(() => chat.js('Boolean(document.querySelector(".chat-older:enabled"))'), 'older turns action');
  assert.ok(firstPageReads() >= 1);

  const draft = 'Generated unsent draft';
  await chat.field(draft);
  await api('/fixture/fail-next-page', {});
  await chat.click(older);
  await until(() => chat.js('Boolean(document.querySelector(".chat-error[role=alert]") && document.querySelector(".chat-older:enabled"))'), 'retryable read error');
  assert.deepEqual(pageReads().map(read => read.status), [503]);
  assert.equal((await chat.questions()).length, 20);
  assert.equal(await chat.draft(), draft);

  await chat.js('const button = document.querySelector(".chat-older:enabled"); button.click(); button.click();');
  await waitForPage(40, 'Generated question 6');
  assert.deepEqual(pageReads().map(read => read.status), [503, 200]);
  assert.equal(pageReads()[0].cursor, pageReads()[1].cursor, 'retry reads the same page');
  await chat.click(older);
  await waitForPage(45, 'Generated question 1');
  assert.equal(await chat.js('Boolean(document.querySelector(".chat-older"))'), false);
  assert.deepEqual(await chat.questions(), Array.from({length: 45}, (_, index) => 'Generated question ' + (index + 1)));
  assert.equal(await chat.draft(), draft);

  const followUp = 'Generated explicit continuation';
  await chat.field(followUp);
  await chat.click('.ask-form .send-button:enabled');
  await chat.completed(followUp);
  const saved = await api(path);
  assert.equal(saved.id, fixture.conversationId);
  assert.equal(saved.turnCount, 46);
  assert.equal(saved.turns.at(-1).question, followUp);
  assert.equal(saved.turns.at(-1).result.answer, 'Generated continued response');

  const pending = 'Generated retained after refresh';
  await chat.field(pending);
  const beforeRefresh = firstPageReads();
  await chat.refresh();
  await until(() => firstPageReads() > beforeRefresh, 'explicit main refresh');
  assert.equal(await chat.draft(), pending);

  // Change the stored snapshot without a push notification, so the renderer must
  // detect the revision change on the next cursor read and refresh the first page.
  const previousPages = pageReads().length;
  const changed = await api('/fixture/advance-revision', {});
  assert.ok(changed.revision > saved.revision);
  await chat.click(older);
  await until(() => pageReads().length === previousPages + 1, 'older page at the new revision');
  await waitForPage(20, 'Generated question 28');
  assert.equal((await chat.questions()).at(-1), 'Generated other-client continuation');
  assert.equal(await chat.draft(), pending);

  const out = resolve(__dirname, '../.mote/conversation-ui');
  mkdirSync(out, {recursive: true});
  writeFileSync(join(out, 'history.png'), (await web.webContents.capturePage()).toPNG());
  writeFileSync(join(out, 'result.json'), JSON.stringify({
    passed: true, actualMacRendererPreloadIpc: true, actualWebRenderer: true,
    actualCentralHttpSqlite: true, liveModel: false,
    checks: ['Mac ticket opens main chat', '20/40/45 ordered turns', '503 retains turns and draft; same cursor retries',
      'double click sends one page request', 'continuation persisted as turn 46',
      'new revision replaces rather than mixes turn pages and keeps the draft'],
  }, null, 2));
  console.log('PASS Mac-to-Central main chat: 20/40/45 turns, 503 cursor retry, turn 46, revision and draft.');
  web.destroy();
});
