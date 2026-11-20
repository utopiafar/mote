import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const report = fileURLToPath(new URL('./request-latency-report.mjs', import.meta.url));
const epoch = Date.UTC(2026, 0, 1);
const at = offset => new Date(epoch + offset).toISOString();
const instanceId = randomUUID();
const cards = '/api/assistant-cards/:id';
const status = '/api/status';
const request = (routeTemplate, durationMs, end, extra = {}) => ({
  event: 'request.completed', at: at(end), durationMs, routeTemplate, instanceId, ...extra,
});
const block = (durationMs, end, jobLabels, extra = {}) => ({
  event: 'event-loop.blocked', at: at(end), durationMs, jobLabels, instanceId, ...extra,
});

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'mote-latency-report-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function writeLog(file, records) {
  return writeFile(file, records.map(record => JSON.stringify(record)).join('\n') + '\n');
}

async function readReport(path) {
  const { stdout, stderr } = await run(process.execPath, [report, path]);
  assert.equal(stderr, '');
  return JSON.parse(stdout);
}

test('PF0-03 computes nearest-rank percentiles per template and selects blocks that overlap the slow requests', async t => {
  const file = join(await fixture(t), 'diagnostics.ndjson');
  const cardRequests = Array.from({ length: 20 }, (_, index) =>
    request(cards, 10 * (index + 1), 1000 * (index + 1))).reverse();
  await writeLog(file, [
    block(85, 19990, ['assistant-followup']),
    block(60, 17980, ['material-organizer']),
    block(100, 23000, ['source-pipelines']),
    block(65, 19980, ['processing'], { instanceId: randomUUID() }),
    block(72, 19020, ['assistant-changes']),
    ...cardRequests,
    request(status, 7, 7500),
    request(status, 3, 7510),
    request(status, 5, 7520),
  ]);
  assert.deepEqual(await readReport(file), [
    {
      routeTemplate: cards,
      p50Ms: 100,
      p95Ms: 190,
      maxMs: 200,
      overlappingBlocks: [
        { durationMs: 72, jobLabels: ['assistant-changes'] },
        { durationMs: 85, jobLabels: ['assistant-followup'] },
      ],
    },
    { routeTemplate: status, p50Ms: 5, p95Ms: 7, maxMs: 7, overlappingBlocks: [] },
  ]);
});

test('PF0-04 outputs only route templates, durations, and approved job labels', async t => {
  const file = join(await fixture(t), 'diagnostics.ndjson');
  const id = randomUUID();
  const privateText = 'GENERATED_PRIVATE_BODY';
  const token = 'GENERATED_OWNER_TOKEN';
  const rawPath = `/api/assistant-cards/${id}?token=${token}`;
  await writeLog(file, [
    request(cards, 120, 150, { url: rawPath, body: privateText, authorization: token, requestId: id, route: rawPath }),
    request(undefined, 500, 150, { route: rawPath, url: rawPath }),
    request(rawPath, 600, 150),
    request(`/api/assistant-cards/${id}`, 650, 150),
    request(`${cards}\n`, 700, 150),
    block(75, 125, ['assistant-changes', token, { body: privateText }, 'assistant-changes'], { evidenceId: id, path: rawPath }),
    { event: 'agent.trace', at: at(125), trace: { body: privateText } },
  ]);
  assert.deepEqual(await readReport(file), [
    {
      routeTemplate: cards,
      p50Ms: 120,
      p95Ms: 120,
      maxMs: 120,
      overlappingBlocks: [{ durationMs: 75, jobLabels: ['assistant-changes'] }],
    },
  ]);
});

test('reads request and block events across Central segments in a log directory', async t => {
  const directory = await fixture(t);
  const segment = (family, level) => join(directory, `${family}.${level}.${epoch}.${epoch + 180}.${randomUUID()}.ndjson`);
  await Promise.all([
    writeLog(segment('central', 'info'), [request(cards, 100, 180)]),
    writeLog(segment('central', 'warn'), [block(70, 160, ['assistant-routines'])]),
    writeLog(segment('central', 'trace'), [request(cards, 900, 180)]),
    writeLog(segment('supervisor', 'info'), [request(cards, 850, 180)]),
    writeFile(join(directory, 'unrelated.ndjson'), '{malformed\n'),
  ]);
  assert.deepEqual(await readReport(directory), [{
    routeTemplate: cards, p50Ms: 100, p95Ms: 100, maxMs: 100,
    overlappingBlocks: [{ durationMs: 70, jobLabels: ['assistant-routines'] }],
  }]);
});
