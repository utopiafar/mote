import assert from 'node:assert/strict';
import type {TestContext} from 'node:test';
import type {InjectOptions} from 'fastify';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildApp} from '../../src/app.js';
import {bytesHash} from '../../src/scope/originals.js';
import {defaultProcessingSettings} from '../../src/scope/processing-schema.js';

export async function scopedFilesFixture(t: TestContext,options:Pick<Parameters<typeof buildApp>[0],'importPythonPacks'>|((host:Awaited<ReturnType<typeof buildApp>>)=>void)={}) {
  const directory = mkdtempSync(join(tmpdir(), 'mote-joint-files-'));
  let host = await buildApp({dataDir: directory,...(typeof options==='function'?{}:options)});
  if(typeof options==='function')options(host);
  const nodes=[host];
  t.after(async () => { for(const node of nodes.reverse())await node.app.close(); rmSync(directory, {recursive: true, force: true}); });
  const password = 'Generated-joint-files-password';
  const headers = {'x-mote-protocol-version': '2', 'x-mote-ingress-version': '3'};
  const request = (token: string | undefined, url: string, method: any = 'GET', payload?: unknown, extra = {}) => host.app.inject({method, url, headers: {...headers, ...(token ? {authorization: 'Bearer ' + token} : {}), ...extra}, ...(payload === undefined ? {} : {payload:payload as InjectOptions['payload']})});
  const checked = async (...args: Parameters<typeof request>) => {
    const response = await request(...args); assert.equal(response.statusCode, 200, response.body); return response.json();
  };
  await host.accounts!.initialize('generated-admin', password);
  const login = (username: string) => checked(undefined, '/api/auth/login', 'POST', {username, password, mode: 'client'});
  const admin = await login('generated-admin');
  for (const username of ['generated-a', 'generated-b']) await checked(admin.token, '/api/admin/accounts', 'POST', {username, password});
  const a = await login('generated-a'), b = await login('generated-b');
  for (const account of [a, b]) {
    await checked(account.token, '/api/ingress/sources', 'POST', {id: 'same-source', name: 'Generated files', kind: 'local-files', deviceId: 'same-device', platform: 'import', retention: 'archive'});
    const view = await checked(account.token, '/api/configuration');
    await checked(account.token, '/api/configuration/processing', 'PUT', {revision: view.revision, value: {...defaultProcessingSettings(), automatic: false, summarize: false, semanticTurns: false}});
  }
  const uploadBytes = async (token: string, externalId: string, bytes: Buffer, mimeType: string) => {
    const hash = bytesHash(bytes);
    const input = await checked(token, '/api/ingress/sources/same-source/uploads', 'POST', {batchId: externalId, revision: {sourceId: 'same-source', previousRevision: null, sizeBytes: bytes.length, sha256: hash, relativePath: externalId + (mimeType.startsWith('audio/') ? '.wav' : '.txt'), item: {externalId, revision: 'same-r1', observedAt: '2026-10-16T00:00:00Z', title: externalId, text: '', kind: 'file', layer: 'original', mimeType}}});
    await checked(token, '/api/ingress/uploads/' + input.id + '/parts/0', 'PUT', {bytes: bytes.toString('base64'), checksum: hash});
    return (await checked(token, '/api/ingress/uploads/' + input.id + '/commit', 'POST', {})).captures[0];
  };
  const upload=(token:string,externalId:string,text:string)=>uploadBytes(token,externalId,Buffer.from(text),'text/plain');
  const restart=async()=>{await host.app.close();host=await buildApp({dataDir:directory,...(typeof options==='function'?{}:options)});nodes.push(host);if(typeof options==='function')options(host);};
  return {directory, get host(){return host;}, a, b, admin, request, checked, upload, uploadBytes,restart};
}

