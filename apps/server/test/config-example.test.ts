import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import YAML from 'yaml';
import { isConfigSecretPath } from '@mote/shared/config-file';
import { ConfigError, readConfigDocument, repositoryRoot } from '../src/config.js';

const exampleFile = resolve(repositoryRoot, 'mote.example.yaml');
const exampleText = readFileSync(exampleFile, 'utf8');
const tokenPlaceholder = '  # token: "${MOTE_OWNER_TOKEN}"';

function privateExample(t: { after(fn: () => void): void }, text: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'mote-example-config-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'mote.yaml');
  writeFileSync(file, text, { mode: 0o600 });
  return file;
}

/** Return secret fields that carry a literal instead of an environment reference. */
function literalSecretPaths(raw: string): string[] {
  const found: string[] = [];
  const reference = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;
  function visit(value: unknown, path: (string | number)[]): void {
    if (Array.isArray(value)) value.forEach((entry, index) => visit(entry, [...path, index]));
    else if (value && typeof value === 'object') Object.entries(value).forEach(([key, entry]) => visit(entry, [...path, key]));
    else if (isConfigSecretPath(path) && value !== undefined && value !== null && value !== '' && !(typeof value === 'string' && reference.test(value))) found.push(path.join('.'));
  }
  visit(YAML.parse(raw) as unknown, []);
  return found;
}

test('K1-01: the shipped configuration example loads through the real config reader', () => {
  const document = readConfigDocument(exampleFile, {});
  assert.equal(document.version, 1);
  assert.equal(document.revision, 0);
});

test('K1-02: copying the example cannot expose a non-loopback listener or a configured model', () => {
  const document = readConfigDocument(exampleFile, {});
  const server = document.server as { host: string };
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(server.host), `example listener is ${server.host}`);
  const models = document.models as {
    deployment: { model: string; apiKey: string };
    profiles: unknown[];
    defaultModels: Record<string, string>;
    embedding: { model: string; baseUrl: string; apiKey: string };
  };
  assert.equal(models.deployment.model, '', 'the example configures no deployment model');
  assert.equal(models.deployment.apiKey, '', 'the example configures no deployment credential');
  assert.deepEqual(models.profiles, []);
  assert.deepEqual(models.defaultModels, {});
  assert.deepEqual(models.embedding, { model: '', baseUrl: '', apiKey: '' });
});

test('K1-03: the example provides no usable public owner token', (t) => {
  const document = readConfigDocument(exampleFile, {});
  assert.equal((document.server as { token: string }).token, '');
  const short = exampleText.replace(/^server:\n/m, 'server:\n  token: short-placeholder\n');
  const file = privateExample(t, short);
  assert.throws(() => readConfigDocument(file, {}), (error: unknown) => error instanceof ConfigError && error.field === 'server.token');
});

test('K1-04: the example contains no literal credential values', () => {
  assert.deepEqual(literalSecretPaths(exampleText), []);
  const leaked = exampleText.replace(/^server:\n/m, "server:\n  token: 'synthetic-example-secret'\n");
  assert.deepEqual(literalSecretPaths(leaked), ['server.token'], 'the check must reject a deliberate literal secret');
});

test('K1-05: supplying a generated 32-character token leaves the rest of the example usable', (t) => {
  const token = randomBytes(16).toString('hex');
  assert.equal(token.length, 32);
  assert.ok(exampleText.includes(tokenPlaceholder), 'the example keeps a token reference ready to uncomment');
  const file = privateExample(t, exampleText.replace(tokenPlaceholder, `  token: '${token}'`));
  const document = readConfigDocument(file, {});
  assert.equal((document.server as { token: string }).token, token);
  assert.equal((document.server as { host: string }).host, '127.0.0.1');
  assert.equal((document.storage as { dataDir: string }).dataDir, './data');
});
