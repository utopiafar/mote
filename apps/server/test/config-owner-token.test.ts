import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serializeConfigDocument } from '@mote/shared/config-file';
import { buildApp } from '../src/app.js';
import {createConfigurationPlatform} from '../src/plugins/configuration-platform.js';
import { ConfigService } from '../src/config-service.js';
import { configurationFromFile, configurationBootstrap, readConfigDocument, registerBuiltinDomains } from '../src/config.js';

test('canonical source drives the actual owner HTTP consumer and keeps restart settings separate', async t => {
  const directory=mkdtempSync(join(tmpdir(),'mote-canonical-source-')),file=join(directory,'mote.yaml'),owner='generated-canonical-owner-credential-for-tests';
  let node:Awaited<ReturnType<typeof buildApp>>|undefined;
  t.after(async()=>{await node?.app.close();rmSync(directory,{recursive:true,force:true});});
  node=await buildApp({path:file,watch:false,initialDocument:{version:1,revision:0,server:{profile:'test',token:owner},storage:{dataDir:'./vault'},diagnostics:{level:'silent'},connectors:{syncIntervalMs:60000}}});
  const headers={authorization:'Bearer '+owner},get=()=>node!.app.inject({url:'/api/configuration',headers});
  const before=await get();assert.equal(before.statusCode,200,before.body);
  assert.equal(Object.hasOwn(before.json(),'envFile'),false);assert.equal(Object.hasOwn(before.json(),'groups'),false);assert.equal(before.body.includes(owner),false);
  const unchanged=node.configService.current('models');
  const saved=await node.app.inject({method:'PUT',url:'/api/configuration/connectors',headers,payload:{revision:0,value:{syncIntervalMs:90000,directory:'./next-connectors'}}});
  assert.equal(saved.statusCode,200,saved.body);
  assert.equal(node.configService.current<{syncIntervalMs:number}>('connectors').syncIntervalMs,90000);
  assert.equal(node.configService.current<{directory:string}>('connectors').directory,'');
  assert.equal(node.configService.saved<{directory:string}>('connectors').directory,'./next-connectors');
  assert.deepEqual(node.configService.current('models'),unchanged);
  await node.app.close();node=await buildApp({path:file,watch:false});
  assert.equal((await get()).statusCode,200);assert.equal(node.configService.current<{directory:string}>('connectors').directory,'./next-connectors');
});

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'mote-managed-owner-config-')), file = join(directory, 'mote.yaml'), vault = join(directory, 'vault');
  const ownerToken = 'generated-managed-owner-token-for-collision-fixtures';
  writeFileSync(file, 'version: 1\nrevision: 0\nstorage:\n  dataDir: ./vault\n');
  mkdirSync(vault); writeFileSync(join(vault, 'access-token'), ownerToken + '\n');
  const pure = configurationFromFile(file); assert.equal(Object.hasOwn(pure,'token'),false);
  const service = new ConfigService({ path: file, watch: false }); registerBuiltinDomains(service); await service.initialize();
  const node = await buildApp(pure, { configService: service, backgroundWorker: false });
  t.after(async () => { await node.app.close(); rmSync(directory, { recursive: true, force: true }); });
  return { node, service, file, ownerToken, headers: { authorization: 'Bearer ' + ownerToken } };
}

test('a pure bootstrap binds subsequent generic saves and external reloads to its managed owner credential', async t => {
  const f = await fixture(t), original = readFileSync(f.file, 'utf8');
  const response = await f.node.app.inject({ method: 'PUT', url: '/api/configuration/connectors', headers: f.headers, payload: { revision: f.service.revision, value: { mcpEnabled: true, mcpReadToken: f.ownerToken } } });
  assert.equal(response.statusCode, 400, response.body); assert.equal(response.json().error, 'config_invalid');
  assert.equal(readFileSync(f.file, 'utf8'), original); assert.equal(f.service.revision, 0); assert.equal(response.body.includes(f.ownerToken), false);
  const candidate = readConfigDocument(f.file); candidate.connectors = { ...f.service.saved<object>('connectors'), mcpEnabled: true, mcpReadToken: f.ownerToken };
  writeFileSync(f.file, serializeConfigDocument(candidate));
  await assert.rejects(f.service.reload(), (error: { code?: string }) => error.code === 'config_invalid');
  assert.equal(f.service.current<{ mcpEnabled: boolean }>('connectors').mcpEnabled, false); assert.equal(f.service.revision, 0);
  assert.equal(JSON.stringify(f.service.view()).includes(f.ownerToken), false);
});

test('a pending replacement owner token cannot permit MCP to reuse the still-effective private owner credential', async t => {
  const f = await fixture(t), replacementOwner = 'generated-pending-owner-token-for-collision-fixtures';
  const saved = await f.node.app.inject({ method: 'PUT', url: '/api/configuration/server', headers: f.headers, payload: { revision: 0, value: { token: replacementOwner } } });
  assert.equal(saved.statusCode, 200, saved.body); assert.equal(f.service.revision, 1);
  assert.equal(f.service.current<{ token: string }>('server').token, ''); assert.equal(f.service.saved<{ token: string }>('server').token, replacementOwner);
  const original = readFileSync(f.file, 'utf8');
  for (const token of [f.ownerToken, replacementOwner]) {
    const response = await f.node.app.inject({ method: 'PUT', url: '/api/configuration/connectors', headers: f.headers, payload: { revision: f.service.revision, value: { mcpEnabled: true, mcpReadToken: token } } });
    assert.equal(response.statusCode, 400, response.body); assert.equal(response.json().error, 'config_invalid');
    assert.equal(readFileSync(f.file, 'utf8'), original); assert.equal(f.service.revision, 1); assert.equal(response.body.includes(token), false);
  }
  const candidate = readConfigDocument(f.file); candidate.connectors = { ...f.service.saved<object>('connectors'), mcpEnabled: true, mcpReadToken: f.ownerToken };
  writeFileSync(f.file, serializeConfigDocument(candidate)); await assert.rejects(f.service.reload(), { code: 'config_invalid' });
  assert.equal(f.service.current<{ mcpEnabled: boolean }>('connectors').mcpEnabled, false);
  assert.equal((await f.node.app.inject({ url: '/api/configuration', headers: f.headers })).statusCode, 200, 'the original owner remains the effective authority until restart');
});

test('MCP write credentials are also checked against the actual owner after pure bootstrap', async t => {
  const f = await fixture(t), original = readFileSync(f.file, 'utf8');
  const response = await f.node.app.inject({ method: 'PUT', url: '/api/configuration/connectors', headers: f.headers, payload: { revision: f.service.revision, value: { mcpEnabled: true, mcpReadToken: 'generated-distinct-read-token-for-fixtures', mcpWriteEnabled: true, mcpWriteToken: f.ownerToken, mcpWriteSourceIds: ['generated'] } } });
  assert.equal(response.statusCode, 400, response.body); assert.equal(response.json().error, 'config_invalid');
  assert.equal(readFileSync(f.file, 'utf8'), original); assert.equal(f.service.revision, 0); assert.equal(response.body.includes(f.ownerToken), false);
});

for (const nestedValue of [undefined, 'generated-value-must-not-be-substituted']) test(`effective bootstrap credentials keep literal reference-shaped contents when the nested variable is ${nestedValue === undefined ? 'missing' : 'defined'}`, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'mote-literal-credential-')), file = join(directory, 'mote.yaml');
  const originalOwner = process.env.MOTE_FIXTURE_LITERAL_OWNER, originalNested = process.env.MOTE_FIXTURE_OTHER;
  const ownerToken = 'generated-owner-${MOTE_FIXTURE_OTHER}-credential-of-sufficient-length';
  process.env.MOTE_FIXTURE_LITERAL_OWNER = ownerToken;
  if (nestedValue === undefined) delete process.env.MOTE_FIXTURE_OTHER; else process.env.MOTE_FIXTURE_OTHER = nestedValue;
  let node: Awaited<ReturnType<typeof buildApp>> | undefined, service: ConfigService | undefined;
  t.after(async () => { await node?.app.close(); await service?.close(); if (originalOwner === undefined) delete process.env.MOTE_FIXTURE_LITERAL_OWNER; else process.env.MOTE_FIXTURE_LITERAL_OWNER = originalOwner; if (originalNested === undefined) delete process.env.MOTE_FIXTURE_OTHER; else process.env.MOTE_FIXTURE_OTHER = originalNested; rmSync(directory, { recursive: true, force: true }); });
  writeFileSync(file, 'version: 1\nrevision: 0\nserver:\n  token: ${MOTE_FIXTURE_LITERAL_OWNER}\nstorage:\n  dataDir: ./vault\n');
  const pure = configurationFromFile(file); assert.equal(Object.hasOwn(pure,'token'),false);
  service = new ConfigService({ path: file, watch: false }); registerBuiltinDomains(service); await service.initialize();
  node = await buildApp(pure, { configService: service, backgroundWorker: false });
  const response = await node.app.inject({ url: '/api/configuration', headers: { authorization: 'Bearer ' + ownerToken } });
  assert.equal(response.statusCode, 200, response.body); assert.equal(response.body.includes(ownerToken), false);
  assert.equal(readFileSync(file, 'utf8').includes('${MOTE_FIXTURE_LITERAL_OWNER}'), true);
  if (nestedValue !== undefined) assert.equal((await node.app.inject({ url: '/api/configuration', headers: { authorization: 'Bearer ' + ownerToken.replace('${MOTE_FIXTURE_OTHER}', nestedValue) } })).statusCode, 401);
});


test('startup hands the pinned private owner facts to the foundation before listener resources open',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-pinned-bootstrap-')),file=join(directory,'mote.yaml'),vault=join(directory,'vault');
  const owner='generated-pinned-startup-owner-token',replacement='generated-next-startup-owner-token';
  mkdirSync(vault);writeFileSync(join(vault,'access-token'),owner+'\n',{mode:0o600});writeFileSync(file,'version: 1\nrevision: 0\nstorage:\n  dataDir: ./vault\n');
  const source=configurationFromFile(file),service=new ConfigService({...source,watch:false});let node:Awaited<ReturnType<typeof buildApp>>|undefined;
  t.after(async()=>{await node?.app.close();await service.close();rmSync(directory,{recursive:true,force:true});});
  registerBuiltinDomains(service);await service.initialize();const pinned=configurationBootstrap(service);
  writeFileSync(pinned.owner.tokenPath,replacement+'\n',{mode:0o600});
  node=await buildApp({...source,privateCredential:pinned.owner},{configService:service,backgroundWorker:false});
  assert.deepEqual(node.bootstrap.configurationBootstrap.owner,pinned.owner);
  const headers={authorization:'Bearer '+owner};
  assert.equal((await node.app.inject({url:'/api/configuration',headers})).statusCode,200);
  assert.equal((await node.app.inject({url:'/api/configuration',headers:{authorization:'Bearer '+replacement}})).statusCode,401);
  const rejected=await node.app.inject({method:'PUT',url:'/api/configuration/connectors',headers,payload:{revision:service.revision,value:{mcpEnabled:true,mcpReadToken:owner}}});assert.equal(rejected.statusCode,400,rejected.body);
  assert.equal(readFileSync(pinned.owner.tokenPath,'utf8'),replacement+'\n');
});


test('programmatic owner credential collisions reject before writing the source or opening the vault',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-owner-preflight-')),vault=join(directory,'vault'),file=join(directory,'mote.yaml'),owner='generated-distinct-owner-required-before-source-write';
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  let code:string|undefined;
  await assert.rejects(buildApp({path:file,privateCredential:{token:owner,tokenPath:join(vault,'access-token')},initialDocument:{version:1,revision:0,storage:{dataDir:vault},connectors:{mcpEnabled:true,mcpReadToken:owner}}}),error=>{code=(error as {code?:string}).code;assert.equal(String(error).includes(owner),false);return true;});
  assert.equal(existsSync(file),false,'Invalid owner/MCP credentials must fail before writing the source');
  assert.equal(existsSync(vault),false,'Invalid owner/MCP credentials must fail before opening the vault');
  assert.equal(code,'config_invalid');
});


test('an explicit server owner takes precedence over an unused private fallback during initial validation',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-owner-precedence-')),owner='generated-configured-owner-credential-for-startup',fallback='generated-unused-private-credential-for-startup';
  let node:Awaited<ReturnType<typeof buildApp>>|undefined;t.after(async()=>{await node?.app.close();rmSync(directory,{recursive:true,force:true});});
  node=await buildApp({path:join(directory,'mote.yaml'),privateCredential:{token:fallback,tokenPath:join(directory,'unused-token')},initialDocument:{version:1,revision:0,server:{token:owner},storage:{dataDir:join(directory,'vault')},connectors:{mcpEnabled:true,mcpReadToken:fallback}}},{backgroundWorker:false});
  assert.equal(node.bootstrap.configurationBootstrap.owner.token,owner);assert.equal(node.bootstrap.configurationBootstrap.owner.source,'configured-value');
  assert.equal((await node.app.inject({url:'/api/configuration',headers:{authorization:'Bearer '+owner}})).statusCode,200);
  assert.equal((await node.app.inject({url:'/api/configuration',headers:{authorization:'Bearer '+fallback}})).statusCode,401);
});


test('a supplied bootstrap service retains its pinned owner validator before platform prepare',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-owner-service-handoff-')),file=join(directory,'mote.yaml'),vault=join(directory,'vault');
  const owner='generated-current-handoff-owner-token',replacement='generated-pending-handoff-owner-token';
  mkdirSync(vault);writeFileSync(join(vault,'access-token'),owner+'\n',{mode:0o600});writeFileSync(file,'version: 1\nrevision: 0\nstorage:\n  dataDir: ./vault\n');
  const source=configurationFromFile(file),service=new ConfigService({...source,watch:false});registerBuiltinDomains(service);await service.initialize();const pinned=configurationBootstrap(service);
  await service.update('server',{token:replacement},service.revision);const revision=service.revision,before=readFileSync(file,'utf8');
  const platform=createConfigurationPlatform({...source,privateCredential:pinned.owner},{configService:service});
  t.after(async()=>{await platform.close();rmSync(directory,{recursive:true,force:true});});
  await assert.rejects(service.update('connectors',{mcpEnabled:true,mcpReadToken:owner},revision),{code:'config_invalid'});
  assert.equal(service.revision,revision);assert.equal(readFileSync(file,'utf8'),before);assert.equal(service.current<{mcpEnabled:boolean}>('connectors').mcpEnabled,false);
});
