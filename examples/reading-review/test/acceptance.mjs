/** [M] clean-instance acceptance for the reading review package.
 *
 * Starts the real Central source entrypoint with a generated private YAML
 * profile, installs this package through `connectors.modules`, selects a
 * strategy, reviews one generated card, stops, restarts the same profile and
 * reads the committed plan again. The host, SQLite vault and instance state are
 * real; only the card text is generated. */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {randomBytes, randomUUID} from 'node:crypto';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {serializeConfigDocument} from '../../../packages/shared/src/config-file.ts';

const repository = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const source = pathToFileURL(fileURLToPath(new URL('../source.mjs', import.meta.url))).href;
const report = {status: 'running', fixtureOnly: true, liveModel: false, physicalDevice: false, checks: [], failure: undefined};
let run;

async function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : undefined;
      server.close(error => error ? reject(error) : port ? resolvePort(port) : reject(Error('Could not allocate a private port')));
    });
  });
}

async function start(directory) {
  const port = await freePort();
  const token = randomBytes(32).toString('hex');
  const dataDir = join(directory, 'data');
  mkdirSync(dataDir, {recursive: true, mode: 0o700});
  const configFile = join(directory, 'mote.yaml');
  writeFileSync(configFile, serializeConfigDocument({
    version: 1, revision: 0,
    server: {profile: 'generated', runtime: 'native', host: '127.0.0.1', port, token},
    storage: {dataDir},
    models: {deployment: {model: ''}},
    diagnostics: {traceEnabled: false, level: 'silent'},
    connectors: {modules: [source]},
  }), {mode: 0o600});
  const baseUrl = `http://127.0.0.1:${port}`;
  let output = '';
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `await import(${JSON.stringify(join(repository, 'apps/server/src/index.ts'))})`], {
    cwd: repository,
    env: {...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('MOTE_'))), MOTE_CONFIG_FILE: configFile},
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + chunk.toString('utf8')).slice(-12000); });
  const deadline = Date.now() + 30000;
  for (;;) {
    if (child.exitCode !== null) throw Error(`Central exited before health: ${output.slice(-2000)}`);
    try { if ((await fetch(baseUrl + '/api/health', {signal: AbortSignal.timeout(500)})).ok) break; } catch {}
    if (Date.now() >= deadline) throw Error(`Central health deadline: ${output.slice(-2000)}`);
    await delay(25);
  }
  // The real entrypoint installs its graceful stop handlers immediately after
  // logging `server.listening`. Wait for that event so a ready health response
  // cannot race a default SIGTERM kill.
  for (;;) {
    if (output.includes('server.listening')) break;
    if (child.exitCode !== null) throw Error(`Central exited before the listening event: ${output.slice(-2000)}`);
    if (Date.now() >= deadline) throw Error(`Central listening deadline: ${output.slice(-2000)}`);
    await delay(20);
  }
  async function stop() {
    const closed = new Promise(resolveClose => child.once('close', (code, signal) => resolveClose({code, signal})));
    if (child.exitCode !== null || child.signalCode !== null) return {exited: true, code: child.exitCode, signal: child.signalCode};
    child.kill('SIGTERM');
    const outcome = await Promise.race([closed, delay(15000).then(() => ({timeout: true}))]);
    if (outcome.timeout) {
      child.kill('SIGKILL');
      throw Error('Central did not stop gracefully after the reading review acceptance');
    }
    return {exited: true, code: outcome.code, signal: outcome.signal};
  }
  async function request(path, {method = 'GET', body} = {}) {
    const response = await fetch(baseUrl + path, {
      method,
      headers: {Authorization: `Bearer ${token}`, ...(body === undefined ? {} : {'Content-Type': 'application/json'})},
      ...(body === undefined ? {} : {body: JSON.stringify(body)}),
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    });
    const value = await response.json().catch(() => ({}));
    assert.equal(response.ok, true, `${method} ${path} failed with HTTP ${response.status}: ${JSON.stringify(value)}`);
    return value;
  }
  return {
    token, baseUrl, configFile, dataDir,
    request,
    stop,
    close: async () => {
      try { await stop(); } finally { rmSync(directory, {recursive: true, force: true}); }
    },
  };
}

const directory = mkdtempSync(join(tmpdir(), 'mote-reading-review-acceptance-'));
try {
  run = await start(directory);
  const initial = await run.request('/api/connectors/reading-review/state');
  assert.equal(initial.strategy, null);
  assert.equal(initial.cards.length, 0);
  report.checks.push('clean profile: external package loaded by connectors.modules and instance state initialized');

  const selected = await run.request('/api/connectors/reading-review/strategy', {method: 'PUT', body: {strategy: 'spaced'}});
  assert.equal(selected.strategy, 'spaced');
  const prompt = `Generated reading prompt ${randomUUID()}`;
  const answer = `Generated reading answer ${randomUUID()}`;
  const added = await run.request('/api/connectors/reading-review/cards', {method: 'POST', body: {prompt, answer}});
  const card = added.cards[0];
  assert.equal(card.prompt, prompt);
  assert.equal(card.answer, answer);
  const reviewed = await run.request('/api/connectors/reading-review/round', {method: 'POST', body: {cardId: card.id, rating: 'good'}});
  assert.equal(reviewed.strategy, 'spaced');
  assert.equal(reviewed.historyCount, 1);
  assert.equal(reviewed.rounds[0].cardId, card.id);
  assert.equal(reviewed.rounds[0].intervalDays, 3);
  assert.ok(Date.parse(reviewed.cards[0].dueAt) > Date.parse(reviewed.rounds[0].reviewedAt));
  report.checks.push('strategy selected and one review round committed through owner-only HTTP');

  const status = await run.request('/api/connectors/status');
  assert.equal(status['reading-review'].strategy, 'spaced');
  assert.equal(status['reading-review'].reviews, 1);
  report.checks.push('the package publishes its own connector status projection');

  const stopped = await run.stop();
  assert.equal(stopped.exited, true);
  assert.equal(stopped.code, 0);
  report.checks.push('graceful shutdown of the same generated profile');

  run = await start(directory);
  const resumed = await run.request('/api/connectors/reading-review/state');
  assert.equal(resumed.strategy, 'spaced');
  assert.equal(resumed.stateRevision, reviewed.stateRevision);
  assert.equal(resumed.cards[0].id, card.id);
  assert.equal(resumed.cards[0].prompt, prompt);
  assert.equal(resumed.rounds[0].id, reviewed.rounds[0].id);
  assert.equal(resumed.historyCount, 1);
  assert.equal(resumed.cards[0].dueAt, reviewed.cards[0].dueAt);
  report.checks.push('same-profile restart reads the same plan, card, revision and review round from ctx.state');
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.failure = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.exitCode = 1;
} finally {
  if (run) await run.close().catch(error => { report.failure ??= `cleanup: ${error instanceof Error ? error.message : String(error)}`; process.exitCode = 1; });
  if (!run) rmSync(directory, {recursive: true, force: true});
  console.log(JSON.stringify(report, null, 2));
}
