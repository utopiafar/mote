import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { serializeConfigDocument } from '@mote/shared/config-file';
import { configFromFile, configFromDocument, documentFromConfig, parseConfigDocument, readConfigDocument, resolveConfigDocument, configDocumentDomains, registerBuiltinDomains, ConfigError } from '../src/config.js';
import { ConfigService } from '../src/config-service.js';

const moduleUrl = new URL('../src/config.ts', import.meta.url).href;
function readConfig(env: Record<string, string>, cwd?: string) {
  return spawnSync(process.execPath, ['--import', new URL('../../../node_modules/tsx/dist/loader.mjs', import.meta.url).pathname, '--input-type=module', '-e',
    `import {configFromFile} from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify(configFromFile()));`], {
    env: { PATH: process.env.PATH, ...env }, encoding: 'utf8', timeout: 15000, cwd,
  });
}
function fixture(t: { after(fn: () => void): void }, name = 'config') {
  const root = mkdtempSync(join(tmpdir(), `mote-${name}-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, 'mote.yaml');
  const write = (patch: Record<string, unknown> = {}) => writeFileSync(file, serializeConfigDocument({ version: 1, revision: 0, storage: { dataDir: './vault' }, ...patch }));
  write(); return { root, file, write, vault: join(root, 'vault') };
}

test('YAML profiles isolate paths and private generated credentials across restarts', t => {
  const { root } = fixture(t);
  const configs = ['dev', 'test'].map((profile, index) => {
    const directory = join(root, profile); mkdirSync(directory);
    const file = join(directory, 'mote.yaml');
    writeFileSync(file, serializeConfigDocument({ version: 1, revision: 0, server: { profile, port: 47842 + index * 10 }, storage: { dataDir: './archive' }, diagnostics: { directory: './events', debug: true } }));
    const result = readConfig({ MOTE_CONFIG_FILE: file }); assert.equal(result.status, 0, result.stderr);
    const config = JSON.parse(result.stdout);
    assert.equal(config.profile, profile); assert.equal(config.port, 47842 + index * 10);
    assert.equal(config.dataDir, join(directory, 'archive')); assert.equal(config.logDirectory, join(directory, 'events'));
    assert.equal(config.diagnosticsDebug, true); assert.equal(config.agentTraceEnabled,false);
    assert.equal(config.logMaxBytes, 16*1024*1024);
    assert.equal(config.model, ''); assert.equal(config.apiKey, '');
    assert.equal(config.token, readFileSync(join(directory, 'archive/access-token'), 'utf8').trim());
    assert.equal(JSON.parse(readConfig({ MOTE_CONFIG_FILE: file }).stdout).token, config.token);
    return config;
  });
  assert.notEqual(configs[0].token, configs[1].token);
});

test('profile diagnostic defaults preserve explicit opt-outs and survive unrelated YAML saves', async t => {
  const { file, write } = fixture(t, 'profile-diagnostics');
  for (const profile of ['dev', 'test', 'prod', 'default']) {
    write({ server: { profile } });
    const loaded = configFromFile(file, { initializeCredentials: false });
    assert.equal(loaded.diagnosticsDebug, profile === 'dev');
    assert.equal(loaded.logLevel, 'info');
    write({ server: { profile }, diagnostics: { debug: false, traceEnabled: false, level: 'silent' } });
    const explicit = configFromFile(file, { initializeCredentials: false });
    assert.equal(explicit.diagnosticsDebug, false); assert.equal(explicit.agentTraceEnabled, false); assert.equal(explicit.logLevel, 'silent');
  }
  write({ server: { profile: 'dev' } });
  const config = configFromFile(file, { initializeCredentials: false });
  const service = new ConfigService({ path: file, watch: false, initialDocument: config.configuration.document });
  registerBuiltinDomains(service, config); t.after(() => service.close()); await service.initialize();
  await service.update('execution', { agentConcurrency: 9 }, service.revision);
  assert.equal(service.current<{ debug: boolean }>('diagnostics').debug,false);
  assert.equal(Object.hasOwn(readConfigDocument(file).diagnostics as object, 'debug'), false);
  await service.update('diagnostics', { debug: false }, service.revision);
  await service.update('execution', { agentConcurrency: 10 }, service.revision);
  assert.equal(configFromFile(file, { initializeCredentials: false }).diagnosticsDebug, false);
  assert.equal((readConfigDocument(file).diagnostics as { debug: boolean }).debug, false);
});

test('YAML retention preserves explicit capacities and enforces profile limits before creating storage', t => {
  const { file, write, vault } = fixture(t, 'log-retention');
  const mib = 1024 * 1024;
  for (const [profile, maxBytes, expected] of [
    ['dev',undefined,16*mib], ['dev', 2 * mib, 2 * mib],
    ['dev', Math.floor(0.1 * mib), Math.floor(0.1 * mib)], ['dev', 100 * mib, 100 * mib],
    ['test',undefined,16*mib], ['prod',undefined,16*mib], ['default', 8 * mib, 8 * mib],
  ] as const) {
    write({ server: { profile }, diagnostics: { ...(maxBytes === undefined ? {} : { maxBytes }), maxTotalBytes:512*1024*1024,maxEntries: 3000 } });
    const loaded = configFromFile(file, { initializeCredentials: false });
    assert.equal(loaded.logMaxBytes, expected); assert.equal(loaded.logMaxTotalBytes,512*1024*1024); assert.equal(loaded.logMaxEntries, 3000);
    assert.equal(existsSync(vault), false);
  }
  for (const [profile, maxBytes] of [['dev', 100 * mib + 1], ['dev', Math.floor(0.1 * mib) - 1], ['test',100*mib+1], ['prod',100*mib+1], ['dev', 'synthetic-private-limit']] as const) {
    write({ server: { profile }, diagnostics: { maxBytes } });
    assert.throws(() => configFromFile(file), (error: ConfigError) => error.field === 'diagnostics.maxBytes' && !error.message.includes('synthetic-private-limit'));
    assert.equal(existsSync(vault), false);
  }
});

test('retention saves validate profile capacity together and expose restart metadata', async t => {
  const { file, write } = fixture(t, 'log-retention-save');
  write({ server: { profile: 'dev' } });
  const config = configFromFile(file, { initializeCredentials: false });
  const service = new ConfigService({ path: file, watch: false, initialDocument: config.configuration.document });
  registerBuiltinDomains(service, config); t.after(() => service.close()); await service.initialize();
  assert.equal(service.current<{ maxBytes: number }>('diagnostics').maxBytes,16*1024*1024);
  const revision = service.revision;
  await assert.rejects(service.update('diagnostics', { maxBytes: 101 * 1024 * 1024 }, revision));
  assert.equal(service.revision, revision);
  assert.equal(configDocumentDomains().find(domain => domain.id === 'diagnostics')?.fields?.find(field => field.path === 'maxBytes')?.effect, 'restart');
});

for (const setting of [undefined, 2 * 1024 * 1024, 100 * 1024 * 1024]) {
  test(`configuration saves preserve ${setting === undefined ? 'profile-default' : 'explicit ' + setting} log capacity provenance`, async t => {
    const { file, write } = fixture(t, 'log-provenance');
    write({ server: { profile: 'dev' }, diagnostics: setting === undefined ? {} : { maxBytes: setting } });
    const config = configFromFile(file, { initializeCredentials: false });
    const service = new ConfigService({ path: file, watch: false, initialDocument: config.configuration.document });
    registerBuiltinDomains(service, config); t.after(() => service.close()); await service.initialize();
    const capacity=setting??16*1024*1024;
    const assertProvenance = () => {
      for (const document of [service.document(), readConfigDocument(file)]) {
        assert.equal(Object.hasOwn(document.diagnostics as object, 'maxBytes'), setting !== undefined);
        if (setting !== undefined) assert.equal((document.diagnostics as { maxBytes: number }).maxBytes, setting);
      }
      assert.equal(service.saved<{ maxBytes: number }>('diagnostics').maxBytes, capacity);
      assert.equal(service.current<{ maxBytes: number }>('diagnostics').maxBytes, capacity);
    };
    await service.update('execution', { agentConcurrency: 9 }, service.revision); assertProvenance();
    await service.update('diagnostics', { debug: true }, service.revision); assertProvenance();
    const before = readFileSync(file, 'utf8'), revision = service.revision;
    await service.update('diagnostics', { debug: true }, revision);
    assert.equal(service.revision, revision); assert.equal(readFileSync(file, 'utf8'), before);
    if (setting === undefined) {
      await service.update('server', { profile: 'test' }, service.revision);
      assert.equal(service.saved<{ maxBytes: number }>('diagnostics').maxBytes,16*1024*1024);
      assert.equal(service.current<{ maxBytes: number }>('diagnostics').maxBytes, capacity, 'profile and capacity changes remain pending restart');
      assert.equal(configFromFile(file, { initializeCredentials: false }).logMaxBytes,16*1024*1024);
      assert.equal(Object.hasOwn(service.document().diagnostics as object, 'maxBytes'), false);
    } else if (setting === 100 * 1024 * 1024) {
      const revision = service.revision;
      await service.update('server',{profile:'test'},revision);assertProvenance();assert.equal(service.saved<{profile:string}>('server').profile,'test');
    }
  });
}

test('selected YAML ignores ordinary ambient environment variables and old environment files', t => {
  const { file, write, root } = fixture(t);
  write({ server: { port: 48123 }, execution: { agentConcurrency: 6 }, models: { deployment: { model: 'file-model' } } });
  const old = join(root, 'mote.env'); writeFileSync(old, 'MOTE_PORT=49999\nMOTE_MODEL=old-file-model\n');
  const result = readConfig({ MOTE_CONFIG_FILE: file, MOTE_ENV_FILE: old, MOTE_PORT: '49998', MOTE_MODEL: 'ambient-model', MOTE_AGENT_CONCURRENCY: '64', MOTE_MODEL_API_KEY: 'synthetic-ambient-secret' });
  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(result.stdout);
  assert.equal(config.port, 48123); assert.equal(config.agentConcurrency, 6); assert.equal(config.model, 'file-model'); assert.equal(config.apiKey, '');
  assert.equal(config.configuration.configFile, file); assert.equal(Object.hasOwn(config.configuration, 'envFile'), false);
});

test('missing YAML and obsolete env syntax fail before creating storage', t => {
  const { root, file, vault } = fixture(t);
  assert.notEqual(readConfig({ MOTE_CONFIG_FILE: join(root, 'missing.yaml') }).status, 0);
  writeFileSync(file, `MOTE_DATA_DIR=${vault}\nMOTE_PORT=47832\n`);
  assert.notEqual(readConfig({ MOTE_CONFIG_FILE: file }).status, 0); assert.equal(existsSync(vault), false);
});

test('an obsolete environment-file selector cannot override the selected YAML profile', t => {
  const { root } = fixture(t), legacy = join(root, 'old-profile.env');
  writeFileSync(legacy, 'MOTE_DATA_DIR=./old-profile-data\n');
  const result = readConfig({ MOTE_ENV_FILE: legacy }, root);
  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(result.stdout);
  assert.equal(config.dataDir, join(realpathSync(root), 'vault'), 'The explicit YAML beside the working directory remains authoritative');
  assert.equal(existsSync(join(root, 'old-profile-data')), false);
});

test('pure bootstrap loading neither creates the vault nor reads or generates its private credential', t => {
  const { file, write, vault } = fixture(t);
  const pure = configFromFile(file, { initializeCredentials: false });
  assert.equal(pure.token, ''); assert.equal(pure.tokenPath, join(vault, 'access-token')); assert.equal(existsSync(vault), false);
  mkdirSync(vault); writeFileSync(join(vault, 'access-token'), 'invalid-token');
  assert.equal(configFromFile(file, { initializeCredentials: false }).token, '');
  assert.throws(() => configFromFile(file), (error: ConfigError) => error.field === 'server.token');
  const snapshot = readConfigDocument(file); write({ storage: { dataDir: './other-vault' } });
  const projected = configFromDocument(snapshot, file, undefined, { initializeCredentials: false });
  assert.equal(projected.dataDir, vault); assert.equal(existsSync(join(vault, '..', 'other-vault')), false);
});

test('bootstrap normalization derives profile and managed media defaults from the initialized file snapshot', async t => {
  const { file, write, vault } = fixture(t);
  write({ server: { profile: 'dev' }, media: { ocrEndpoint: 'http://127.0.0.1:19101/ocr' } });
  const seed = configFromFile(file, { initializeCredentials: false }), service = new ConfigService({ path: file, watch: false, initialDocument: seed.configuration.document });
  registerBuiltinDomains(service, seed); t.after(() => service.close());
  write({ server: { profile: 'test' }, storage: { dataDir: './selected-vault' }, media: { ocrEndpoint: 'http://127.0.0.1:19102/ocr' } });
  await service.initialize();
  assert.equal(service.current<{ profile: string }>('server').profile, 'test');
  assert.equal(service.current<{ traceEnabled: boolean }>('diagnostics').traceEnabled, false);
  assert.equal(service.current<{ policy: { services: { id: string; endpoint: string }[] } }>('processing').policy.services.find(item => item.id === 'central-image-ocr')?.endpoint, 'http://127.0.0.1:19102/ocr');
  const projected = configFromDocument(service.document(), file, undefined, { initializeCredentials: false });
  assert.equal(projected.dataDir, join(vault, '..', 'selected-vault')); assert.equal(projected.agentTraceEnabled, false);
  assert.equal(existsSync(vault), false); assert.equal(existsSync(projected.dataDir), false);
});

test('version, revision, strict fields, types and bounded values validate before storage', t => {
  const { file, write, vault } = fixture(t);
  for (const patch of [
    { version: 2 }, { revision: -1 }, { revision: Number.MAX_SAFE_INTEGER + 1 },
    { server: { port: 65536 } }, { server: { profile: '../prod' } }, { server: { privateTypo: 'synthetic-private' } },
    { diagnostics: { debug: 'synthetic-private' } }, { diagnostics: { level: 'verbose' } }, { diagnostics: { maxFiles: 1.5 } },
    { execution: { agentConcurrency: 65 } }, { execution: { interactiveConcurrency: 0 } }, { storage: { maxExportBytes: 0 } },
  ]) {
    write(patch); const result = readConfig({ MOTE_CONFIG_FILE: file }); assert.notEqual(result.status, 0, JSON.stringify(patch));
    assert.equal(existsSync(vault), false); assert.equal(result.stderr.includes('synthetic-private'), false);
  }
});

test('retired code module lists are unknown fields and never load code', t => {
  const { root, file, write, vault } = fixture(t, 'config-code-modules');
  const marker = join(root, 'generated-loaded.txt');
  const moduleFile = join(root, 'generated-module.mjs');
  writeFileSync(moduleFile, `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'loaded'); export default {};\n`);
  for (const patch of [
    { connectors: { modules: [moduleFile] } },
    { plugins: { backendModules: [moduleFile] } },
    { plugins: { fileProcessorModules: [moduleFile] } },
  ]) {
    write(patch);
    const result = readConfig({ MOTE_CONFIG_FILE: file });
    assert.notEqual(result.status, 0, JSON.stringify(patch));
    assert.equal(existsSync(marker), false, 'configuration never imports a code module');
    assert.equal(existsSync(vault), false);
  }
  write();
  const config = configFromFile(file, { initializeCredentials: false });
  assert.equal(Object.hasOwn(config, 'fileProcessorModules'), false);
  assert.equal(Object.hasOwn(config, 'backendPluginModules'), false);
  assert.equal(Object.hasOwn(config.connectors, 'modules'), false);
  assert.equal(Object.hasOwn(config.configuration.document!.connectors as object, 'modules'), false);
  assert.equal(Object.hasOwn(config.configuration.document!.plugins as object, 'backendModules'), false);
  assert.equal(Object.hasOwn(config.configuration.document!.plugins as object, 'fileProcessorModules'), false);
});

test('URL and credential failures do not expose supplied values or create storage', t => {
  const { file, write, vault } = fixture(t);
  for (const patch of [
    { models: { deployment: { baseUrl: 'ftp://fixture.invalid' } } },
    { models: { deployment: { baseUrl: 'https://synthetic-user:synthetic-secret@fixture.invalid/v1' } } },
    { models: { deployment: { baseUrl: 'https://fixture.invalid/v1?key=synthetic-secret' } } },
    { models: { deployment: { baseUrl: 'http://fixture.invalid/v1' } } },
    { server: { publicUrl: 'http://192.0.2.2' } }, { server: { publicUrl: 'https://fixture.invalid/prefix' } },
    { server: { allowedOrigins: ['https://fixture.invalid/path'] } }, { server: { token: 'short-synthetic-secret' } },
    { storage: { dataDir: './vault', dataKey: 'synthetic-secret' } },
    { models: { embedding: { model: 'fixture' } } },
    { connectors: { mcpEnabled: true, mcpReadToken: 'short-synthetic-secret' } },
    { connectors: { googleClientId: 'synthetic-secret' } },
    { connectors: { googleClientId: 'fixture', googleClientSecret: 'synthetic-secret', googleRedirectUri: 'https://fixture.invalid/wrong-path' } },
  ]) {
    write(patch); const result = readConfig({ MOTE_CONFIG_FILE: file }); assert.notEqual(result.status, 0);
    assert.equal(existsSync(vault), false); assert.equal(result.stderr.includes('synthetic-secret'), false);
  }
});

test('explicit secret references resolve only declared sensitive locations and remain unexpanded in the saved document', t => {
  const { file, write } = fixture(t);
  write({ server: { token: '${GENERATED_OWNER}' }, models: { deployment: { apiKey: '${GENERATED_API_KEY}', model: '${ORDINARY_MODEL}', headers: { 'X-Fixture': 'Bearer ${GENERATED_API_KEY}' }, extraBody: { vendor: { credential: '${GENERATED_API_KEY}' } } } } });
  const env = { MOTE_CONFIG_FILE: file, GENERATED_OWNER: 'synthetic-owner-token-of-sufficient-length', GENERATED_API_KEY: 'synthetic-private-model-key', ORDINARY_MODEL: 'must-not-expand' };
  const result = readConfig(env); assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(result.stdout);
  assert.equal(config.token, env.GENERATED_OWNER); assert.equal(config.apiKey, env.GENERATED_API_KEY); assert.equal(config.model, '${ORDINARY_MODEL}');
  assert.deepEqual(config.modelHeaders, { 'X-Fixture': 'Bearer synthetic-private-model-key' });
  assert.equal(JSON.stringify(config.configuration).includes('synthetic-private'), false); assert.equal(JSON.stringify(config.configuration).includes(env.GENERATED_OWNER), false);
  const saved = parseConfigDocument(readFileSync(file, 'utf8'), env);
  assert.equal((saved.models as { deployment: { apiKey: string } }).deployment.apiKey, '${GENERATED_API_KEY}');
  assert.equal(readFileSync(file, 'utf8').includes('synthetic-private'), false);
});

test('missing secret references and MCP owner-token conflicts fail safely before storage', t => {
  const { file, write, vault } = fixture(t);
  write({ models: { deployment: { apiKey: '${ABSENT_FIXTURE_SECRET}' } } });
  const missing = readConfig({ MOTE_CONFIG_FILE: file }); assert.notEqual(missing.status, 0); assert.equal(existsSync(vault), false);
  assert.equal(missing.stderr.includes('ABSENT_FIXTURE_SECRET'), false);
  const token = 'synthetic-distinctness-token-of-sufficient-length';
  write({ server: { token }, connectors: { mcpEnabled: true, mcpReadToken: token } });
  assert.notEqual(readConfig({ MOTE_CONFIG_FILE: file }).status, 0); assert.equal(existsSync(vault), false);
});

test('provider presets and Codex launch paths share the domain model schema', t => {
  const { file, write, root } = fixture(t);
  const cases = [
    { provider: 'deepseek', protocol: 'deepseek', url: 'https://api.deepseek.com/anthropic', reasoning: 'high', local: false },
    { provider: 'openai', protocol: 'openai-responses', url: 'https://api.openai.com/v1', reasoning: 'auto', local: false },
    { provider: 'anthropic', protocol: 'anthropic-messages', url: 'https://api.anthropic.com', reasoning: 'auto', local: false },
    { provider: 'gemini', protocol: 'google-generative-ai', url: 'https://generativelanguage.googleapis.com/v1beta', reasoning: 'auto', local: false },
    { provider: 'ollama', protocol: 'openai-completions', url: 'http://localhost:11434/v1', reasoning: 'auto', local: true },
  ];
  for (const expected of cases) {
    write({ models: { deployment: { provider: expected.provider } } });
    const result = readConfig({ MOTE_CONFIG_FILE: file }); assert.equal(result.status, 0, result.stderr); const config = JSON.parse(result.stdout);
    assert.equal(config.modelProvider, expected.provider); assert.equal(config.modelProtocol, expected.protocol); assert.equal(config.modelBaseUrl, expected.url);
    assert.equal(config.modelReasoningEffort, expected.reasoning); assert.equal(config.allowUnauthenticatedLocal, expected.local);
  }
  write({ models: { deployment: { provider: 'codex', model: 'fixture' }, codex: { executable: '/fixture/bin/codex', home: './login' } } });
  const result = readConfig({ MOTE_CONFIG_FILE: file }); assert.equal(result.status, 0, result.stderr); const config = JSON.parse(result.stdout);
  assert.equal(config.modelProtocol, 'codex-app-server'); assert.equal(config.modelRequestTimeoutMs, null); assert.equal(config.agentTimeoutMs, null);
  assert.equal(config.codexBin, '/fixture/bin/codex'); assert.equal(config.codexHome, join(root, 'login'));
});

test('programmatic Codex configuration preserves its empty endpoint through a file roundtrip', t => {
  const { file, write, vault } = fixture(t, 'codex-roundtrip');
  for (const provider of ['openai', 'codex']) {
    write({ models: { deployment: { provider, protocol: 'codex-app-server', baseUrl: '', model: 'gpt-6.1-terra' } } });
    const loaded = configFromFile(file, { initializeCredentials: false });
    assert.equal(loaded.modelProvider, provider); assert.equal(loaded.modelBaseUrl, '');
    const document = documentFromConfig(loaded);
    writeFileSync(file, serializeConfigDocument(document));
    const reloaded = configFromFile(file, { initializeCredentials: false });
    assert.equal(reloaded.modelProvider, provider); assert.equal(reloaded.modelProtocol, 'codex-app-server');
    assert.equal(reloaded.modelBaseUrl, ''); assert.equal(reloaded.model, 'gpt-6.1-terra');
    assert.equal(reloaded.modelRequestTimeoutMs, null); assert.equal(reloaded.agentTimeoutMs, null);
    assert.throws(() => documentFromConfig({ ...loaded, modelBaseUrl: 'https://fixture.invalid/v1' }));
  }
  assert.equal(existsSync(vault), false);
});

test('model advanced validation and deadlines use the same rules before storage', t => {
  const { file, write, vault } = fixture(t);
  for (const deployment of [
    { provider: 'synthetic-private-provider' }, { protocol: 'synthetic-private-protocol' }, { headers: { Host: 'synthetic-private' } },
    { headers: { 'X-Fixture': 'synthetic-private\r\nInjected: value' } }, { headers: { 'X-Fixture': 123 } },
    { extraBody: { tools: ['synthetic-private'] } }, { extraBody: { store: true } }, { extraBody: { previous_response_id: 'synthetic-private' } },
    { extraBody: JSON.parse('{"__proto__":{"secret":"synthetic-private"}}') }, { extraBody: { vendor: { constructor: 'synthetic-private' } } },
    { maxTokens: 0 }, { maxTokens: 128001 }, { agentTimeoutMs: 4999 }, { agentTimeoutMs: 3600001 }, { modelRequestTimeoutMs: 600001 },
  ]) {
    write({ models: { deployment } }); const result = readConfig({ MOTE_CONFIG_FILE: file }); assert.notEqual(result.status, 0);
    assert.equal(existsSync(vault), false); assert.equal(result.stderr.includes('synthetic-private'), false);
  }
});

test('trusted Python packs retain pinned validation in YAML', t => {
  const { file, write, root, vault } = fixture(t);
  const pack = { id: 'fixture.pack', version: '1', packRoot: join(root, 'pack'), script: 'parse.py', scriptSha256: 'a'.repeat(64), pythonExecutable: '/usr/bin/python3', config: { timeZoneOffset: '+08:00' } };
  write({ plugins: { importPythonPacks: [pack] } }); const valid = readConfig({ MOTE_CONFIG_FILE: file }); assert.equal(valid.status, 0, valid.stderr);
  assert.deepEqual(JSON.parse(valid.stdout).importPythonPacks, [pack]); rmSync(vault, { recursive: true });
  for (const packs of [[{ ...pack, script: '../outside.py' }], [{ ...pack, scriptSha256: 'not-pinned' }], [{ ...pack, config: { oversized: 'x'.repeat(8193) } }], [pack, pack]]) {
    write({ plugins: { importPythonPacks: packs } }); assert.notEqual(readConfig({ MOTE_CONFIG_FILE: file }).status, 0); assert.equal(existsSync(vault), false);
  }
});

test('startup emits only a stable field code when YAML validation fails', t => {
  const { file, write, root } = fixture(t);
  write({ diagnostics: { debug: 'synthetic-private-setting-do-not-echo' } });
  const result = spawnSync(process.execPath, ['--import', 'tsx', new URL('../src/index.ts', import.meta.url).pathname], { env: { PATH: process.env.PATH, MOTE_CONFIG_FILE: file }, encoding: 'utf8', timeout: 15000 });
  assert.notEqual(result.status, 0); assert.equal(result.stderr.includes('synthetic-private'), false); assert.equal(result.stderr.includes(root), false);
  assert.deepEqual(JSON.parse(result.stderr.trim()), { event: 'server.start_failed', category: 'configuration', field: 'diagnostics.debug' });
});

test('registered metadata covers every default field with a real apply policy', () => {
  const domains = configDocumentDomains();
  for (const domain of domains) for (const field of domain.fields ?? []) assert.ok(field.effect, `${domain.id}.${field.path}`);
  for (const id of ['server', 'storage', 'media', 'updates']) {
    const domain = domains.find(value => value.id === id)!;
    for (const key of Object.keys(domain.defaultValue as object)) assert.ok(domain.fields?.some(field => field.path === key || field.path.startsWith(key + '.')), `${id}.${key}`);
  }
  assert.equal(domains.find(value => value.id === 'storage')?.fields?.find(field => field.path === 'dataDir')?.effect, 'migration');
  assert.equal(domains.find(value => value.id === 'execution')?.fields?.find(field => field.path === 'agentConcurrency')?.effect, 'next-admission');
  assert.equal(domains.find(value => value.id === 'connectors')?.fields?.find(field => field.path === 'syncIntervalMs')?.effect, 'immediate');
  const saved = parseConfigDocument('version: 1\nrevision: 0\n');
  assert.equal((resolveConfigDocument(saved).execution as { agentConcurrency: number }).agentConcurrency, 8);
  assert.throws(() => parseConfigDocument('version: 2\nrevision: 0\n'), ConfigError);
});

test('sensitive object keys cannot enter configuration field metadata', t => {
  const { file, write } = fixture(t);
  write({ models: { deployment: { headers: { 'X-Synthetic-Private-Key': 'fixture' }, extraBody: { vendor: { 'synthetic-private-object-key': 'fixture' } } } }, plugins: { configuration: { 'synthetic-private-plugin-key': { value: 'fixture' } } } });
  const config = configFromFile(file);
  const metadata = JSON.stringify(configDocumentDomains(config).map(domain => ({ id: domain.id, fields: domain.fields })));
  for (const privateKey of ['X-Synthetic-Private-Key', 'synthetic-private-object-key', 'synthetic-private-plugin-key']) assert.equal(metadata.includes(privateKey), false);
});

test('partial processing settings inherit managed media defaults from the same YAML snapshot', t => {
  const { file, write } = fixture(t);
  write({ media: { ocrEndpoint: 'http://127.0.0.1:19101/ocr', asrEndpoint: 'http://127.0.0.1:19102/transcribe' }, processing: { settings: { timeoutMs: 5000 } } });
  const config = configFromFile(file), processing = config.configuration.document?.processing as { settings: { timeoutMs: number; localEndpoint: string }; policy: { services: { id: string; endpoint: string }[] } };
  assert.equal(processing.settings.timeoutMs, 5000); assert.equal(processing.settings.localEndpoint, 'http://127.0.0.1:19102/transcribe');
  assert.equal(processing.policy.services.find(service => service.id === 'central-image-ocr')?.endpoint, 'http://127.0.0.1:19101/ocr');
  const domain = configDocumentDomains(config).find(domain => domain.id === 'processing')!;
  const parsed = domain.schema.parse(domain.resolve?.({ settings: { timeoutMs: 6000 } })) as typeof processing;
  assert.equal(parsed.settings.localEndpoint, processing.settings.localEndpoint); assert.equal(parsed.settings.timeoutMs, 6000);
});
