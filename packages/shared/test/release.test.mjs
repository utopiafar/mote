import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyReleaseEnvelope, checkRelease, downloadReleaseAsset, compareVersions, RELEASE_KEY_ID, RELEASE_PUBLIC_KEY } from '../dist/release.js';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 3072, publicKeyEncoding: { format: 'pem', type: 'spki' }, privateKeyEncoding: { format: 'pem', type: 'pkcs8' } });
const body = Buffer.from('generated release bytes\n');
const artifact = { component: 'server', platform: 'source', arch: 'all', format: 'tar.gz', name: 'mote-server-0.5.0.tar.gz', url: 'https://github.com/utopiafar/mote/releases/download/v0.5.0/mote-server-0.5.0.tar.gz', size: body.length, sha256: createHash('sha256').update(body).digest('hex') };
const fixture = () => ({ schemaVersion: 1, version: '0.5.0', channel: 'stable', repository: 'utopiafar/mote', tag: 'v0.5.0', notesUrl: 'https://github.com/utopiafar/mote/releases/tag/v0.5.0', publishedAt: '2026-09-14T00:00:00Z', assets: [artifact], images: [{component: 'server', image: 'ghcr.io/utopiafar/mote@sha256:' + 'a'.repeat(64)}] });
const signed = (value = fixture()) => { const payload = Buffer.from(JSON.stringify(value)); return JSON.stringify({schemaVersion: 1, keyId: RELEASE_KEY_ID, payload: payload.toString('base64'), signature: sign('RSA-SHA256', payload, privateKey).toString('base64')}); };

test('release identity pins the public key and authenticates raw bytes, metadata and asset locations', async () => {
  assert.equal(RELEASE_PUBLIC_KEY, await readFile(new URL('../../../release/release-public-key.pem', import.meta.url), 'utf8'));
  assert.equal(verifyReleaseEnvelope(signed(), {publicKey}).version, '0.5.0');
  assert.throws(() => verifyReleaseEnvelope(signed()), /invalid_manifest_signature/);
  const altered = JSON.parse(signed()); altered.payload = Buffer.from(JSON.stringify({...fixture(), version: '9.0.0'})).toString('base64');
  assert.throws(() => verifyReleaseEnvelope(JSON.stringify(altered), {publicKey}), /invalid_manifest_signature/);
  for (const bad of [
    {...fixture(), tag: 'v0.4.0'}, {...fixture(), channel: 'preview'},
    {...fixture(), assets: [{...artifact, url: 'https://attacker.invalid/file'}]},
    {...fixture(), assets: [artifact, artifact]},
    {...fixture(), images: [{component: 'server', image: 'ghcr.io/attacker/other@sha256:'+'a'.repeat(64)}]},
  ]) assert.throws(() => verifyReleaseEnvelope(signed(bad), {publicKey}));
  assert.throws(() => verifyReleaseEnvelope(signed(), {publicKey, version:'0.6.0'}), /release_version_mismatch/);
});

test('version comparisons do not silently downgrade or misorder prereleases', () => {
  assert.equal(compareVersions('0.5.0','0.5.0'),0);
  assert.equal(compareVersions('0.5.0','0.5.0-rc.2'),1);
  assert.equal(compareVersions('0.5.0-rc.10','0.5.0-rc.2'),1);
  assert.equal(compareVersions('1.0.0-beta-alpha','1.0.0-beta-beta'),-1);
  assert.throws(() => compareVersions('01.0.0','1.0.0'));
  assert.throws(() => compareVersions('1.0.0-01','1.0.0'));
});

test('GitHub check verifies the selected tag and never forwards central credentials', async () => {
  const calls = [];
  const network = async (url, init) => { calls.push(url); assert.equal(new Headers(init.headers).has('authorization'),false); assert.equal(init.redirect,'manual');
    return String(url).includes('api.github.com') ? Response.json({tag_name:'v0.5.0',draft:false,prerelease:false}) : new Response(signed()); };
  const result = await checkRelease({currentVersion:'0.4.0',publicKey,fetch:network});
  assert.equal(result.available,true); assert.equal(calls.length,2);
  assert.equal((await checkRelease({currentVersion:'0.6.0',publicKey,fetch:network})).available,false);
  await assert.rejects(checkRelease({publicKey,fetch:async()=>new Response('',{status:404})}),/release_not_found/);
  await assert.rejects(checkRelease({publicKey,fetch:async()=>new Response('',{status:302,headers:{location:'http://169.254.169.254/secret'}})}),/update_host_rejected/);
});

test('downloads verify content length and checksum before publishing a private file', async t => {
  const dir = await mkdtemp(join(tmpdir(),'mote-release-')); t.after(()=>rm(dir,{recursive:true,force:true}));
  const target = join(dir,'archive');
  await downloadReleaseAsset(artifact,target,{fetch:async()=>new Response(body)});
  assert.deepEqual(await readFile(target),body);
  await assert.rejects(downloadReleaseAsset(artifact,target,{fetch:async()=>new Response(body)}),/update_destination_exists/);
  for (const data of [Buffer.from('short'),Buffer.alloc(body.length,1),Buffer.alloc(body.length+1)]) {
    const path = join(dir,'broken'); await assert.rejects(downloadReleaseAsset(artifact,path,{fetch:async()=>new Response(data)}));
    assert.deepEqual((await readdir(dir)).sort(),['archive']);
  }
  await writeFile(join(dir,'preexisting.partial'),'do not destroy');
  await assert.rejects(downloadReleaseAsset(artifact,join(dir,'preexisting'),{fetch:async()=>new Response(body)}));
  assert.equal(await readFile(join(dir,'preexisting.partial'),'utf8'),'do not destroy');
  const raced = join(dir, 'raced');
  await assert.rejects(downloadReleaseAsset(artifact, raced, {fetch: async () => {
    await writeFile(raced, 'created during download'); return new Response(body);
  }}), /update_destination_exists/);
  assert.equal(await readFile(raced, 'utf8'), 'created during download');
  assert.equal((await readdir(dir)).includes('raced.partial'), false);
});
