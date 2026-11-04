import {authorizeFixtureModels} from './fixtures/model-authorization.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, writeFileSync, rmSync} from 'node:fs';
import {access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';

const record = {
  id: '3c6f0d4e-7b72-4a0a-9c2e-5a1d8f2b7e64',
  capturedAt: '2026-01-01T00:00:00Z',
  appName: 'Generated Codex HTTP fixture',
  ocrText: 'Generated evidence read by the authenticated Codex query.',
};

async function until(check: () => boolean | Promise<boolean>, label: string, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(25);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function alive(pid: number) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function fixture(t: import('node:test').TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'mote-codex-query-'));
  const executable = join(directory, 'generated-codex.mjs');
  const modePath = join(directory, 'mode'), eventsPath = join(directory, 'events.ndjson');
  writeFileSync(join(directory, 'auth.json'), JSON.stringify({OPENAI_API_KEY: 'generated-unused'}), {mode: 0o600});
  writeFileSync(executable, `#!${process.execPath}
import readline from 'node:readline';
import {appendFileSync,readFileSync} from 'node:fs';
const mode=readFileSync(${JSON.stringify(modePath)},'utf8').trim();
const event=value=>appendFileSync(${JSON.stringify(eventsPath)},JSON.stringify({...value,mode,pid:process.pid,home:process.env.CODEX_HOME})+'\\n');
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
event({type:'started'});
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.method==='initialize')send({id:m.id,result:{}});
 else if(m.method==='account/read')send({id:m.id,result:{account:{type:'apiKey'}}});
 else if(m.method==='thread/start')send({id:m.id,result:{thread:{id:'generated-thread',model:m.params.model},model:m.params.model,serviceTier:m.params.serviceTier,approvalPolicy:'never',sandbox:{type:'readOnly'}}});
 else if(m.method==='turn/start'){
  event({type:'turn'});
  send({id:m.id,result:{turn:{id:'generated-turn'}}});
  if(mode==='crash'){event({type:'crash'});process.exit(9);}
  if(mode==='cancel')return;
  send({id:999,method:'item/tool/call',params:{threadId:'generated-thread',turnId:'generated-turn',tool:'timeline',namespace:null,arguments:{}}});
 }else if(m.id===999){
  if(m.result?.success!==true)process.exit(2);
  const items=JSON.parse(m.result.contentItems[0].text).data;
  send({id:1000,method:'item/tool/call',params:{threadId:'generated-thread',turnId:'generated-turn',tool:'evidence',namespace:null,arguments:{ids:[items[0].id]}}});
 }else if(m.id===1000){
  if(m.result?.success!==true)process.exit(3);
  const items=JSON.parse(m.result.contentItems[0].text).data,id=items[0].id;
  event({type:'answer',id});
  send({method:'item/completed',params:{threadId:'generated-thread',item:{id:'generated-message',type:'agentMessage',text:JSON.stringify({answer:'Generated Codex HTTP answer ['+id+']',citationIds:[id]})}}});
  send({method:'turn/completed',params:{threadId:'generated-thread',turn:{status:'completed'}}});
 }
});
`, {mode: 0o700});
  const config: Config = {
    dataDir: directory, token: 'generated-codex-http-owner', tokenPath: 'generated', host: '127.0.0.1', port: 0,
    maxStorageBytes: 30_000_000, maxExportBytes: 1_000_000, retentionDays: 0, insightIntervalHours: 0, allowedOrigins: [],
    model: 'generated-codex-model', modelProvider: 'codex', modelProtocol: 'codex-app-server', modelBaseUrl: '', apiKey: '',
    allowUnauthenticatedLocal: false, embeddingModel: '', embeddingBaseUrl: '', embeddingApiKey: '', diagnosticsEnabled: false,
    logLevel: 'silent', agentTimeoutMs: 20_000, codexBin: executable, codexHome: directory,
  };
  const node = await buildApp(config, {backgroundWorker: false});
  await node.app.ready();
  await authorizeFixtureModels(node);
  await node.store.ingest({...record, deviceId: 'generated-codex-device', deviceName: 'Generated', platform: 'import', source: 'note', durationMs: 0});
  t.after(async () => {
    await node.app.close();
    rmSync(directory, {recursive: true, force: true});
  });
  const headers = {authorization: 'Bearer ' + config.token};
  const events = () => { try { return readFileSync(eventsPath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch { return []; } };
  const setMode = (mode: string) => writeFileSync(modePath, mode);
  const post = (url: string, payload: unknown) => node.app.inject({method: 'POST', url, headers, payload});
  const get = (url: string) => node.app.inject({url, headers});
  const start = async () => {
    const id = randomUUID();
    const response = await post('/api/query-runs', {id, input: {question: 'Which generated evidence does the Codex query read?'}});
    assert.equal(response.statusCode, 202, response.body);
    return id;
  };
  const wait = async (id: string, status: string) => {
    let run: any;
    await until(async () => {
      run = (await get('/api/query-runs/' + id)).json();
      return run.status !== 'running';
    }, `query run ${id} to settle`);
    assert.equal(run.status, status, JSON.stringify(run));
    return run;
  };
  const released = async () => {
    const started = events().filter(event => event.type === 'started');
    assert.ok(started.length > 0);
    for (const event of started) {
      await until(() => !alive(event.pid), `Codex child ${event.pid} to exit`);
      await until(async () => { try { await access(dirname(event.home)); return false; } catch { return true; } }, `private runtime ${dirname(event.home)} to be removed`);
    }
  };
  const completedTurns = () => node.store.db.prepare("SELECT count(*) n FROM conversation_turns WHERE json_extract(json,'$.result') IS NOT NULL").get()!.n;
  return {node, headers, setMode, start, wait, released, completedTurns, events};
}

test('authenticated HTTP selects Codex, reads generated evidence, and saves the cited answer', async t => {
  const f = await fixture(t);
  f.setMode('success');
  const id = await f.start();
  const run = await f.wait(id, 'completed');
  assert.ok(run.conversationId && run.turnId, JSON.stringify(run));
  const conversation = (await f.node.app.inject({url: '/api/conversations/' + run.conversationId, headers: f.headers})).json() as any;
  const turn = conversation.turns.find((candidate: any) => candidate.id === run.turnId);
  assert.ok(turn, JSON.stringify(conversation));
  assert.equal(turn.result.answer, `Generated Codex HTTP answer [${record.id}]`);
  assert.deepEqual(turn.result.citations.map((citation: any) => citation.id), [record.id]);
  assert.ok(turn.result.evidenceDependencies.ids.includes(record.id));
  assert.equal(f.completedTurns(), 1);
  const events = f.events();
  assert.deepEqual(events.map(event => event.type), ['started', 'turn', 'answer']);
  assert.equal(events.find(event => event.type === 'answer').id, record.id);
  await f.released();
});

test('authenticated Codex cancellation commits no half answer and releases the child and private runtime', async t => {
  const f = await fixture(t);
  f.setMode('cancel');
  const id = await f.start();
  await until(() => f.events().some(event => event.type === 'turn'), 'Codex turn to start');
  const cancelled = await f.node.app.inject({method: 'POST', url: '/api/query-runs/' + id + '/cancel', headers: f.headers});
  assert.equal(cancelled.statusCode, 200, cancelled.body);
  await f.wait(id, 'cancelled');
  assert.equal(f.completedTurns(), 0);
  assert.equal(f.node.store.db.prepare('SELECT count(*) n FROM memories').get()!.n, 0);
  await f.released();
  // A later authenticated query proves the session and tool queue were released.
  f.setMode('success');
  const next = await f.start();
  await f.wait(next, 'completed');
  assert.equal(f.completedTurns(), 1);
  await f.released();
});

test('an App Server crash commits no half answer and a later authenticated Codex query recovers', async t => {
  const f = await fixture(t);
  f.setMode('crash');
  const id = await f.start();
  const run = await f.wait(id, 'failed');
  assert.ok(run.error?.code, JSON.stringify(run));
  assert.ok(f.events().some(event => event.type === 'crash'));
  assert.ok(!f.events().some(event => event.type === 'answer'));
  assert.equal(f.completedTurns(), 0);
  await f.released();
  f.setMode('success');
  const next = await f.start();
  await f.wait(next, 'completed');
  assert.equal(f.completedTurns(), 1);
  await f.released();
});
