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

test('Agent deadline defaults to 120 seconds and validates bounded integer overrides before creating storage', t => {
  const root=mkdtempSync(join(tmpdir(),'mote-config-timeout-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const file=join(root,'mote.env'),vault=join(root,'vault');
  writeFileSync(file,`MOTE_DATA_DIR=${vault}\n`);
  assert.equal(JSON.parse(readConfig({MOTE_ENV_FILE:file}).stdout).modelTimeoutMs,120000);
  for(const value of ['5000','300000','600000']){
    const result=readConfig({MOTE_ENV_FILE:file,MOTE_MODEL_TIMEOUT_MS:value});assert.equal(result.status,0,result.stderr);
    assert.equal(JSON.parse(result.stdout).modelTimeoutMs,Number(value));
  }
  const invalidVault=join(root,'invalid-vault');
  for(const value of ['4999','600001','5000.5','','Infinity','synthetic-secret-invalid-timeout']){
    const result=readConfig({MOTE_ENV_FILE:file,MOTE_DATA_DIR:invalidVault,MOTE_MODEL_TIMEOUT_MS:value});assert.notEqual(result.status,0);
    assert.match(result.stderr,/MOTE_MODEL_TIMEOUT_MS/);assert.equal(result.stderr.includes('synthetic-secret-invalid-timeout'),false);
    assert.equal(existsSync(invalidVault),false);
  }
});

test('model provider presets supply explicit protocols, endpoints and compatible reasoning defaults', t => {
  const root=mkdtempSync(join(tmpdir(),'mote-config-providers-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const file=join(root,'mote.env');writeFileSync(file,'MOTE_DATA_DIR=./vault\n');
  const cases = [
    {provider:'deepseek',protocol:'deepseek',url:'https://api.deepseek.com',reasoning:'high',local:false},
    {provider:'openai',protocol:'openai-responses',url:'https://api.openai.com/v1',reasoning:'auto',local:false},
    {provider:'anthropic',protocol:'anthropic-messages',url:'https://api.anthropic.com',reasoning:'auto',local:false},
    {provider:'gemini',protocol:'google-generative-ai',url:'https://generativelanguage.googleapis.com/v1beta',reasoning:'auto',local:false},
    {provider:'ollama',protocol:'openai-completions',url:'http://localhost:11434/v1',reasoning:'auto',local:true},
  ];
  for (const expected of cases) {
    const result=readConfig({MOTE_ENV_FILE:file,MOTE_MODEL_PROVIDER:expected.provider});assert.equal(result.status,0,result.stderr);
    const config=JSON.parse(result.stdout);
    assert.equal(config.modelProvider,expected.provider);assert.equal(config.modelProtocol,expected.protocol);
    assert.equal(config.modelBaseUrl,expected.url);assert.equal(config.modelReasoningEffort,expected.reasoning);
    assert.equal(config.allowUnauthenticatedLocal,expected.local);assert.deepEqual(config.modelHeaders,{});assert.deepEqual(config.modelExtraBody,{});
    assert.equal(config.model,'');assert.equal(config.apiKey,'');
  }
  const legacy=readConfig({MOTE_ENV_FILE:file});assert.equal(legacy.status,0,legacy.stderr);
  assert.equal(JSON.parse(legacy.stdout).modelProtocol,'deepseek');assert.equal(JSON.parse(legacy.stdout).modelReasoningEffort,'high');
});

test('custom protocols and advanced JSON parameters load without adding secret values to configuration provenance', t => {
  const root=mkdtempSync(join(tmpdir(),'mote-config-advanced-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const file=join(root,'mote.env');writeFileSync(file,'MOTE_DATA_DIR=./vault\n');
  const headers={Authorization:'Bearer synthetic-private-header'},extra={vendor:{credential:'synthetic-private-extra'},temperature:0.2};
  for (const protocol of ['openai-completions','openai-responses','anthropic-messages','google-generative-ai','deepseek']) {
    const result=readConfig({MOTE_ENV_FILE:file,MOTE_MODEL_PROVIDER:'custom',MOTE_MODEL_PROTOCOL:protocol,
      MOTE_MODEL_BASE_URL:'https://fixture.example.invalid/custom/v1',MOTE_MODEL:'fixture/manual-model-id',
      MOTE_MODEL_API_KEY:'synthetic-private-api-key',MOTE_MODEL_HEADERS:JSON.stringify(headers),MOTE_MODEL_EXTRA_BODY:JSON.stringify(extra),
      MOTE_MODEL_REASONING_EFFORT:'auto',MOTE_MODEL_MAX_TOKENS:'1'});
    assert.equal(result.status,0,result.stderr);const config=JSON.parse(result.stdout);
    assert.equal(config.modelProvider,'custom');assert.equal(config.modelProtocol,protocol);assert.equal(config.model,'fixture/manual-model-id');
    assert.equal(config.modelReasoningEffort,'auto');assert.equal(config.modelMaxTokens,1);assert.deepEqual(config.modelHeaders,headers);assert.deepEqual(config.modelExtraBody,extra);
    assert.equal(config.configuration.sources.MOTE_MODEL_HEADERS,'environment');assert.equal(config.configuration.sources.MOTE_MODEL_EXTRA_BODY,'environment');
    assert.ok(!JSON.stringify(config.configuration).includes('synthetic-private'));assert.ok(!result.stderr.includes('synthetic-private'));
  }
  const overridden=readConfig({MOTE_ENV_FILE:file,MOTE_MODEL_PROVIDER:'openai',MOTE_MODEL_PROTOCOL:'openai-completions',MOTE_MODEL_REASONING_EFFORT:'off',MOTE_MODEL_MAX_TOKENS:'128000'});
  assert.equal(overridden.status,0,overridden.stderr);const config=JSON.parse(overridden.stdout);
  assert.equal(config.modelProtocol,'openai-completions');assert.equal(config.modelBaseUrl,'https://api.openai.com/v1');assert.equal(config.modelReasoningEffort,'off');assert.equal(config.modelMaxTokens,128000);
});

test('model provider, protocol and advanced parameter failures do not echo supplied values or create storage', t => {
  const root=mkdtempSync(join(tmpdir(),'mote-config-model-reject-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const file=join(root,'mote.env'),vault=join(root,'vault');writeFileSync(file,`MOTE_DATA_DIR=${vault}\n`);
  const invalid: Record<string,string>[] = [
    {MOTE_MODEL_PROVIDER:'synthetic-private-provider'}, {MOTE_MODEL_PROTOCOL:'synthetic-private-protocol'},
    {MOTE_MODEL_REASONING_EFFORT:'synthetic-private-reasoning'}, {MOTE_MODEL_HEADERS:'synthetic-private-invalid-json'},
    {MOTE_MODEL_EXTRA_BODY:'["synthetic-private"]'}, {MOTE_MODEL_HEADERS:'{"Host":"synthetic-private"}'},
    {MOTE_MODEL_HEADERS:'{"X-Test":"synthetic-private\\r\\nInjected: value"}'}, {MOTE_MODEL_HEADERS:'{"X-Test":123}'},
    {MOTE_MODEL_EXTRA_BODY:'{"tools":["synthetic-private"]}'}, {MOTE_MODEL_EXTRA_BODY:'{"generationConfig":{"maxOutputTokens":999999}}'},
    {MOTE_MODEL_EXTRA_BODY:'{"store":true}'}, {MOTE_MODEL_EXTRA_BODY:'{"previous_response_id":"synthetic-private"}'},
    {MOTE_MODEL_EXTRA_BODY:'{"__proto__":{"secret":"synthetic-private"}}'},
    {MOTE_MODEL_HEADERS:JSON.stringify({'X-Test':'synthetic-private'+'x'.repeat(16384)})},
    {MOTE_MODEL_MAX_TOKENS:'0'}, {MOTE_MODEL_MAX_TOKENS:'128001'}, {MOTE_MODEL_MAX_TOKENS:'1.5'},
  ];
  for (const change of invalid) {
    const result=readConfig({MOTE_ENV_FILE:file,...change});assert.notEqual(result.status,0,Object.keys(change).join(','));
    assert.ok(!result.stderr.includes('synthetic-private'));assert.equal(existsSync(vault),false);
  }
});

test('model transport requires remote HTTPS while loopback HTTP remains configurable', t => {
  const root=mkdtempSync(join(tmpdir(),'mote-config-model-tls-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const file=join(root,'mote.env'),vault=join(root,'vault');writeFileSync(file,`MOTE_DATA_DIR=${vault}\n`);
  for (const url of ['http://fixture.example.invalid/v1','http://192.168.1.2/v1','http://127.0.0.1.attacker.invalid/v1']) {
    const result=readConfig({MOTE_ENV_FILE:file,MOTE_MODEL_BASE_URL:url});assert.notEqual(result.status,0);assert.equal(existsSync(vault),false);
  }
  for (const url of ['https://fixture.example.invalid/v1','http://127.0.0.1:11434/v1','http://localhost:11434/v1','http://[::1]:11434/v1']) {
    const result=readConfig({MOTE_ENV_FILE:file,MOTE_MODEL_BASE_URL:url});assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).modelBaseUrl,url);
  }
});
