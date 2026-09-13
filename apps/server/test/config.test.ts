import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const moduleUrl = new URL('../src/config.ts', import.meta.url).href;
function readConfig(env: Record<string, string>) {
  return spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
    `import {configFromEnv} from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify(configFromEnv()));`], {
    env: { PATH: process.env.PATH, ...env }, encoding: 'utf8', timeout: 15000,
  });
}
test('explicit server profiles isolate paths and generated credentials and keep restart identity', t => {
  const root = mkdtempSync(join(tmpdir(), 'mote-config-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const configs = ['dev', 'test'].map((name, index) => {
    const directory = join(root, name); mkdirSync(directory);
    const file = join(directory, 'mote.env');
    writeFileSync(file, `MOTE_PROFILE=${name}\nMOTE_DATA_DIR=./archive\nMOTE_PORT=${47842 + index * 10}\nMOTE_LOG_DIR=./events\nMOTE_DEBUG=1\n`);
    const first = readConfig({ MOTE_ENV_FILE: file });
    assert.equal(first.status, 0, first.stderr);
    const config = JSON.parse(first.stdout);
    assert.equal(config.profile, name);
    assert.equal(config.port, 47842 + index * 10);
    assert.equal(config.dataDir, join(directory, 'archive'));
    assert.equal(config.logDirectory, join(directory, 'events'));
    assert.equal(config.diagnosticsDebug, true);
    assert.equal(config.model, '');
    assert.equal(config.apiKey, '');
    assert.equal(config.token, readFileSync(join(directory, 'archive/access-token'), 'utf8').trim());
    const next = readConfig({ MOTE_ENV_FILE: file });
    assert.equal(next.status, 0, next.stderr);
    assert.equal(JSON.parse(next.stdout).token, config.token);
    return config;
  });
  assert.notEqual(configs[0].token, configs[1].token);
});
test('missing files and invalid diagnostic configuration fail before creating a vault', t => {
  const root = mkdtempSync(join(tmpdir(), 'mote-config-invalid-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const vault = join(root, 'vault');
  const absent = readConfig({ MOTE_ENV_FILE: join(root, 'missing'), MOTE_DATA_DIR: vault });
  assert.notEqual(absent.status, 0);
  assert.match(absent.stderr, /missing, unreadable or invalid/);
  for (const setting of ['MOTE_LOG_LEVEL=verbose', 'MOTE_LOG_MAX_FILES=1.5', 'MOTE_DEBUG=yes', 'MOTE_PROFILE=../prod']) {
    const file = join(root, 'invalid.env'); writeFileSync(file, `MOTE_DATA_DIR=${vault}\n${setting}\n`);
    const result = readConfig({ MOTE_ENV_FILE: file });
    assert.notEqual(result.status, 0, setting);
    assert.equal(existsSync(vault), false);
  }
});

test('startup reports the invalid setting without its private supplied value', t => {
  const root=mkdtempSync(join(tmpdir(),'mote-config-message-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const file=join(root,'mote.env');
  const secret='synthetic-private-setting-do-not-echo';
  writeFileSync(file,`MOTE_DEBUG=${secret}\nMOTE_DATA_DIR=./vault\n`);
  const entry=new URL('../src/index.ts',import.meta.url);
  const result=spawnSync(process.execPath,['--import','tsx',entry.pathname],{env:{PATH:process.env.PATH,MOTE_ENV_FILE:file},encoding:'utf8',timeout:15000});
  assert.notEqual(result.status,0);
  assert.equal(result.stderr.includes(secret),false);
  assert.equal(result.stderr.includes(root),false);
  assert.deepEqual(JSON.parse(result.stderr.trim()),{event:'server.start_failed',category:'configuration',field:'MOTE_DEBUG'});
});

test('provider/public URLs, encryption key and declared metadata validate before creating a vault', t => {
  const root=mkdtempSync(join(tmpdir(),'mote-config-safe-url-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const vault=join(root,'vault'),file=join(root,'mote.env');
  for(const setting of [
    'MOTE_MODEL_BASE_URL=ftp://provider.invalid',
    'MOTE_MODEL_BASE_URL=https://synthetic-user:synthetic-secret@provider.invalid/v1',
    'MOTE_MODEL_BASE_URL=https://provider.invalid/v1?key=synthetic-secret',
    'MOTE_MODEL_BASE_URL="https://provider.invalid/v1#synthetic-secret"',
    'MOTE_EMBEDDING_BASE_URL=javascript:synthetic-secret',
    'MOTE_PUBLIC_URL=http://192.0.2.2:8080',
    'MOTE_PUBLIC_URL=https://mote.example.invalid/prefix',
    'MOTE_ALLOWED_ORIGINS=https://app.invalid/private-path',
    'MOTE_DATA_KEY=synthetic-invalid-key',
    'MOTE_RUNTIME=unsupported', 'MOTE_STORAGE_KIND=unsupported', 'MOTE_TUNNEL_PROTOCOL=unsupported', 'MOTE_TOKEN=too-short',
  ]) {
    writeFileSync(file,`MOTE_DATA_DIR=${vault}\n${setting}\n`);
    const result=readConfig({MOTE_ENV_FILE:file});assert.notEqual(result.status,0,setting);assert.equal(existsSync(vault),false);
    assert.ok(!result.stderr.includes('synthetic-secret'));
  }
});

test('configuration sources track process overrides, selected file and defaults without storing secret values in context', t => {
  const root=mkdtempSync(join(tmpdir(),'mote-config-source-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const file=join(root,'mote.env');
  writeFileSync(file,'MOTE_PROFILE=test\nMOTE_DATA_DIR=./vault\nMOTE_MODEL=file-model\nMOTE_MODEL_API_KEY=synthetic-private-model-key\nMOTE_MODEL_BASE_URL=\nMOTE_PORT=47852\nMOTE_RUNTIME=docker\nMOTE_STORAGE_KIND=docker-volume\nMOTE_STORAGE_SOURCE=synthetic-volume\nMOTE_STORAGE_MOUNT=/data\nMOTE_CONFIG_FILE=/synthetic/host/mote.env\nMOTE_PUBLIC_URL=https://mote.example.invalid\n');
  const result=readConfig({MOTE_ENV_FILE:file,MOTE_PORT:'48123'});assert.equal(result.status,0,result.stderr);
  const config=JSON.parse(result.stdout),context=config.configuration;
  assert.equal(config.port,48123);assert.equal(config.model,'file-model');assert.equal(config.modelBaseUrl,'https://api.deepseek.com');
  assert.equal(context.envFile,file);assert.equal(context.hostConfigFile,'/synthetic/host/mote.env');assert.equal(context.baseDir,root);
  assert.equal(context.sources.MOTE_PORT,'environment');assert.equal(context.sources.MOTE_MODEL,'env-file');assert.equal(context.sources.MOTE_MODEL_BASE_URL,undefined);
  assert.equal(context.runtime,'docker');assert.equal(context.storageSource,'synthetic-volume');assert.equal(context.publicUrl,'https://mote.example.invalid');
  assert.ok(!JSON.stringify(context).includes('synthetic-private-model-key'));assert.ok(!JSON.stringify(context).includes(config.token));
});
