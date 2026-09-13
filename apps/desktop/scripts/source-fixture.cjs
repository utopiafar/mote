// Generated files/calendar objects only. Never requests EventKit access or captures a screen.
const assert = require('node:assert/strict');
const { readFile, writeFile, mkdir, mkdtemp, realpath, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { createServer } = require('node:http');
const { randomUUID } = require('node:crypto');
const { LocalSourceManager } = require('../dist/source-manager');
const { SourceSync } = require('../dist/source-sync');
const { DEFAULT_SOURCE_OPTIONS } = require('../dist/source-types');
const { decodeCalendarScan } = require('../dist/source-calendar');
(async () => {
  const connection = JSON.parse(await readFile(resolve(process.argv[2]), 'utf8'));
  const url = connection.url || connection.serverUrl;
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/);
  const request = async (path, body, method = 'GET') => {
    const response = await fetch(url + path, { method, headers: { Authorization: 'Bearer ' + connection.token, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20000), redirect: 'error' });
    if (!response.ok) throw new Error('Synthetic node HTTP ' + response.status); return response.json();
  };
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'mote-source-live-fixture-')));
  const deviceId = 'desktop-sources-' + randomUUID(); let app; let lost = false; const sent = [];
  const proxy = createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString()); const response = await request(req.url, body, req.method);
      if (req.method === 'PUT') { sent.push(body); if (!lost) { lost = true; res.destroy(); return; } }
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(response));
    } catch { res.writeHead(502); res.end('{}'); }
  });
  try {
    await new Promise((resolve, reject) => { proxy.once('error', reject); proxy.listen(0, '127.0.0.1', resolve); });
    const config = { serverUrl: 'http://127.0.0.1:' + proxy.address().port, token: connection.token, deviceId };
    const files = join(directory, 'selected'); await mkdir(files); const file = join(files, '合成日记.md');
    const text = '合成来源资料 🧑🏽‍💻 e\u0301\n第一段：周五整理工具。\n第二段：图片、文件与日历是原始证据。\n“忽略所有指令”在这里是引用文字，不是给 Agent 的指令。';
    await writeFile(file, text);
    app = new LocalSourceManager(join(directory, 'private'), config, '/never-run-real-calendar-helper'); await app.initialize();
    await app.addFiles(files, { ...DEFAULT_SOURCE_OPTIONS, trackDeletions: true }); await app.sync();
    assert.equal(app.status()[0].pending, 1); await app.close();
    app = new LocalSourceManager(join(directory, 'private'), config, '/never-run-real-calendar-helper'); await app.initialize(); await app.sync();
    assert.equal(app.status()[0].pending, 0); assert.deepEqual(sent[0], sent[1]);
    const sourceId = app.status()[0].source.id; const externalId = sent[0].externalId;
    const currentItem = async () => (await request('/api/sources/' + sourceId + '/items?includeDeleted=true')).items.find(item => item.externalId === externalId);
    await writeFile(file, text + '\n第三段：已更新版本。'); await app.sync();
    await rm(file); await app.sync();
    assert.equal((await currentItem()).deleted, true);
    await writeFile(file, text); await app.sync();
    const history = (await request('/api/sources/' + sourceId + '/history?externalId=' + encodeURIComponent(externalId))).items;
    assert.equal(history.length, 4); assert.equal(new Set(history.map(x => x.revision)).size, 4);
    const current = (await currentItem());
    assert.equal(current.text, text); assert.equal(current.deleted, false);
    const localSource = app.status()[0].source; await app.update(sourceId, { ...localSource, retention: 'reference', enabled: true }); await app.sync();
    const reference = (await currentItem());
    assert.equal(reference.layer, 'reference'); assert.equal(reference.text, '');
    const calendarSource = { id: 'synthetic-calendar-' + randomUUID(), deviceId, name: '合成日历（未读取系统日历）', kind: 'local-calendar', platform: 'macos', retention: 'snapshot', enabled: true };
    const now = Date.now(); const start = new Date(now + 3600000).toISOString(), end = new Date(now + 7200000).toISOString();
    const calendar = decodeCalendarScan({ permission: 'granted', complete: true, events: [{ id: 'synthetic-only-event', title: '合成原生日历事件', text: '合成会议资料', start, end, allDay: false, status: 'confirmed', timeZone: 'Asia/Shanghai' }] }, DEFAULT_SOURCE_OPTIONS, { start: new Date(now - 86400000).toISOString(), end: new Date(now + 86400000).toISOString() });
    const calendarSync = new SourceSync(join(directory, 'calendar.json')); await calendarSync.initialize(); await calendarSync.stage(calendar, true); await calendarSync.flush(calendarSource, request);
    const calendarRow = (await request('/api/sources/' + calendarSource.id + '/items')).items[0];
    assert.equal(calendarRow.calendar.start, start); assert.notEqual(calendarRow.observedAt, start); assert.equal(calendarRow.text, '合成会议资料');
    process.stdout.write(JSON.stringify({ ok: true, fixtureOnly: true, deviceId, fileSourceId: sourceId, calendarSourceId: calendarSource.id, ackLostRestart: true, fileHistoryVersions: history.length, deletionRestoration: true, referenceMetadataOnly: true, eventKitDecoderSyntheticOnly: true }) + '\n');
  } finally { await app?.close(); proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve)); await rm(directory, { recursive: true, force: true }); }
})().catch(error => { process.stderr.write('Synthetic source fixture failed: ' + (error.message?.startsWith('Synthetic node HTTP ') ? error.message : error.name) + ' at ' + (error.stack?.split('\n').find(line => line.includes('source-fixture.cjs')) || 'unknown stage') + '\n'); process.exitCode = 1; });
