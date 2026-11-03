import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';

const externalSource = fileURLToPath(new URL('../../../examples/external-plugin/source.mjs', import.meta.url));
const token = 'generated-state-owner-token';
const headers = {authorization: `Bearer ${token}`};

function config(dataDir: string): Config {
  return {
    dataDir, token, tokenPath: 'fixture-only', host: '127.0.0.1', port: 0,
    maxStorageBytes: 20_000_000, maxExportBytes: 1_000_000, retentionDays: 0, insightIntervalHours: 0,
    allowedOrigins: [], model: '', modelBaseUrl: '', apiKey: '', allowUnauthenticatedLocal: false,
    embeddingModel: '', embeddingBaseUrl: '', embeddingApiKey: '', logLevel: 'silent',
    connectors: {
      directory: join(dataDir, 'connectors'), modules: [externalSource],
      mcpEnabled: false, mcpReadToken: '', mcpWriteEnabled: false, mcpWriteToken: '', mcpWriteSourceIds: [],
      googleClientId: '', googleClientSecret: '', googleRedirectUri: '', syncIntervalMs: 900_000, allowLocalMcp: false,
    },
  };
}

test('the external sample reads and writes host-bound state across restart and disable', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'mote-external-plugin-state-'));
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  const launches = async () => {
    const node = await buildApp(config(directory), {backgroundWorker: false});
    try {
      const response = await node.app.inject({url: '/api/connectors/status', headers});
      assert.equal(response.statusCode, 200, response.body);
      const status = response.json() as Record<string, {launches?: number}>;
      return {node, count: status['example-external-source']?.launches};
    } catch (error) { await node.app.close(); throw error; }
  };

  const first = await launches();
  assert.equal(first.count, 1, 'the host-bound state starts empty and records the first launch');
  try {
    await first.node.featureServices.connectors.stop('example-external-source');
    const stopped = await first.node.app.inject({url: '/api/connectors/status', headers});
    assert.equal((stopped.json() as Record<string, unknown>)['example-external-source'], undefined, 'the disabled instance exposes no status');
  } finally { await first.node.app.close(); }

  const second = await launches();
  try { assert.equal(second.count, 2, 'restart reads the state written before; disable did not clear it'); }
  finally { await second.node.app.close(); }

  const third = await launches();
  try { assert.equal(third.count, 3, 'the same instance identity continues its state across another restart'); }
  finally { await third.node.app.close(); }
});
