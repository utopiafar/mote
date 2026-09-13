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
