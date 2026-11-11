// Shared synthetic inputs and real subprocess transport for deployment validation.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID, randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { repository, profilePaths, loadProfile, updateProfileConfiguration } from './profile-lib.mjs';

export async function freePort() {
  const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port; await new Promise(resolve => server.close(resolve));
  return port === 47832 ? freePort() : port;
}
export function command(binary, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd: repository, env: { ...process.env, ...options.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs ?? 60000);
    child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 4 * 1024 * 1024) child.kill('SIGKILL'); });
    child.stderr.on('data', chunk => { stderr += chunk; if (stderr.length > 4 * 1024 * 1024) child.kill('SIGKILL'); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}
export async function cli(home, profile, action, args = [], options = {}) {
  const result = await command(process.execPath, [join(repository, 'scripts/mote.mjs'), action, '--home', home, ...(profile ? ['--profile', profile] : []), ...args], options);
  if (options.fail) assert.notEqual(result.code, 0, `${action} must fail`);
  else assert.equal(result.code, 0, `${action}: ${result.stderr}`);
  return result;
}
// Legacy fixture call sites keep their names, but all edits go into the single YAML.
export async function updateEnvironment(p, values) {
  const fields = {
    MOTE_HOST: ['server.host', 'string'], MOTE_PORT: ['server.port', 'number'], MOTE_TOKEN: ['server.token', 'string'], MOTE_PUBLIC_URL: ['server.publicUrl', 'string'],
    MOTE_DATA_DIR: ['storage.dataDir', 'string'], MOTE_DATA_KEY: ['storage.dataKey', 'string'], MOTE_CONTENT_ENCRYPTION: ['storage.contentEncryptionEnabled', 'boolean'],
    MOTE_MAX_STORAGE_MB: ['storage.maxStorageBytes', 'MiB'], MOTE_MAX_EXPORT_MB: ['storage.maxExportBytes', 'MiB'], MOTE_RETENTION_DAYS: ['storage.retentionDays', 'number'],
    MOTE_MODEL: ['models.deployment.model', 'string'], MOTE_MODEL_API_KEY: ['models.deployment.apiKey', 'string'], MOTE_MODEL_BASE_URL: ['models.deployment.baseUrl', 'string'],
    MOTE_EMBEDDING_MODEL: ['models.embedding.model', 'string'], MOTE_EMBEDDING_API_KEY: ['models.embedding.apiKey', 'string'],
    MOTE_DIAGNOSTICS_ENABLED: ['diagnostics.enabled', 'boolean'], MOTE_DEBUG: ['diagnostics.debug', 'boolean'], MOTE_AGENT_TRACE_ENABLED: ['diagnostics.traceEnabled', 'boolean'],
    MOTE_LOG_DIR: ['diagnostics.directory', 'string'], MOTE_LOG_LEVEL: ['diagnostics.level', 'string'], MOTE_LOG_MAX_MB: ['diagnostics.maxBytes', 'MiB'], MOTE_LOG_MAX_TOTAL_MB:['diagnostics.maxTotalBytes','MiB'],
    MOTE_PUBLIC_URL: ['server.publicUrl', 'string'], MOTE_TLS_DOMAIN: ['server.tls.domain', 'string'],
  };
  await updateProfileConfiguration(p, document => {
    for (const [key, value] of Object.entries(values)) {
      const field = fields[key]; assert.ok(field, `Unknown fixture config field ${key}`);
      const [path, type] = field, segments = path.split('.'); let parent = document;
      for (const segment of segments.slice(0, -1)) parent = parent[segment] ??= {};
      parent[segments.at(-1)] = type === 'boolean' ? value === '1' || value === true : type === 'MiB' ? Number(value) * 1024 * 1024 : type === 'number' ? Number(value) : String(value);
    }
  });
  return loadProfile(profilePaths(p.profile, p.home));
}
export async function initializeFixture(home, profile, options = {}) {
  await cli(home, profile, 'init', ['--port', String(await freePort()), ...(options.runtime ? ['--runtime', options.runtime] : []), ...(options.image ? ['--image', options.image] : [])]);
  const p = await loadProfile(profilePaths(profile, home));
  await updateProfileConfiguration(p, document => {
    document.models.deployment = { provider: 'custom', protocol: 'openai-completions', baseUrl: '', model: '', reasoningEffort: 'auto', maxTokens: 8192, modelRequestTimeoutMs: 120000, agentTimeoutMs: 300000, allowUnauthenticatedLocal: false, apiKey: '', headers: {}, extraBody: {} };
    // Lifecycle journeys have no media models or dependency-installation side effects.
    document.media.workerToken = '';
  });
  return updateEnvironment(p, { MOTE_CONTENT_ENCRYPTION: '1', MOTE_DATA_KEY: options.dataKey ?? randomBytes(32).toString('hex'), MOTE_DIAGNOSTICS_ENABLED: '1' });
}
export async function request(p, path, { status = 200, method = 'GET', body, token = p.env.MOTE_TOKEN, binary = false } = {}) {
  const response = await fetch(p.url + path, { method, redirect: 'error', signal: AbortSignal.timeout(15000), headers: { Authorization: `Bearer ${token}`, 'X-Mote-Ingress-Version':'2', ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(response.status, status, `${method} ${path}: HTTP ${response.status} ${status === response.status ? '' : bytes.toString().slice(0, 400)}`);
  return binary ? bytes : bytes.length ? JSON.parse(bytes.toString()) : undefined;
}
export const note = () => ({ id: randomUUID(), deviceId: 'synthetic-profile-fixture', deviceName: '隔离部署测试', platform: 'linux', capturedAt: new Date().toISOString(), text: '  合成资料：开发、测试、正式环境各自独立。\n备份保留原文与 ID 👩🏽‍💻。  ', mood: '平静（合成）' });
function png() {
  const chunk = (type, data) => { const body = Buffer.concat([Buffer.from(type), data]), result = Buffer.alloc(data.length + 12); result.writeUInt32BE(data.length); body.copy(result, 4); result.writeUInt32BE(crc32(body), result.length - 4); return result; };
  const header = Buffer.alloc(13); header.writeUInt32BE(2, 0); header.writeUInt32BE(2, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.from([0, 200, 30, 90, 10, 50, 220, 0, 20, 180, 40, 240, 230, 80]))), chunk('IEND', Buffer.alloc(0))]);
}
export const image = png();
export const capture = () => ({ id: randomUUID(), deviceId: 'synthetic-profile-fixture', deviceName: 'Synthetic deployment image', platform: 'linux', capturedAt: new Date().toISOString(), durationMs: 15000, source: 'screen', appId: 'fixture.generated', appName: 'Generated fixture', ocrText: 'Generated 2×2 RGB pixels; no personal screenshot.', privacy: { excluded: false, redacted: false, mode: 'local' }, imageBase64: image.toString('base64'), imageMime: 'image/png' });
