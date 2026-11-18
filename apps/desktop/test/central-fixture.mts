import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { serializeConfigDocument } from '@mote/shared/config-file';
import { buildApp, type QueryAgent } from '../../server/src/app.js';
import { configurationFromFile } from '../../server/src/config.js';

const inactiveAgent: QueryAgent = {
  configured: false,
  async query() { throw Error('No model calls in this Central fixture'); },
  async close() {},
};

interface CentralFixtureOptions {
  agent?: QueryAgent;
  allowedOrigins?: string[];
  maxExportBytes?: number;
  dataKey?: string;
  deployment?: { model: string; baseUrl: string; apiKey: string };
}

/** Start the real Central Host with a private, generated YAML profile. */
export async function buildFixtureCentral(directory: string, token: string, options: CentralFixtureOptions = {}) {
  const { agent = inactiveAgent, allowedOrigins = [], maxExportBytes = 1_000_000, dataKey, deployment } = options;
  const path = join(directory, 'mote.yaml');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(path, serializeConfigDocument({
    version: 1,
    revision: 0,
    server: { profile: 'test', runtime: 'native', host: '127.0.0.1', port: 0, token, allowedOrigins },
    storage: { dataDir: '.', maxExportBytes, ...(dataKey ? { contentEncryptionEnabled: true, dataKey } : {}) },
    execution: { insightIntervalHours: 0 },
    diagnostics: { level: 'silent', traceEnabled: false },
    ...(deployment ? { models: { deployment } } : {}),
  }), { mode: 0o600, flag: 'wx' });
  return buildApp(configurationFromFile(path), { agent, backgroundWorker: false });
}
