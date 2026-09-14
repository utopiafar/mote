import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DesktopUpdater, type UpdateDependencies } from '../src/updater';
import { ReleaseError, type ReleaseManifest } from '@mote/shared/release';
import { digest, updateZip } from './update-fixtures';
let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'mote-updater-')); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
const zip = updateZip([{ name: 'Mote.app/Contents/synthetic', text: 'fixture' }]);
const manifest: ReleaseManifest = { schemaVersion: 1, version: '0.6.0', channel: 'stable', repository: 'utopiafar/mote', tag: 'v0.6.0', notesUrl: 'https://github.com/utopiafar/mote/releases/tag/v0.6.0', publishedAt: '2026-09-14T00:00:00Z', assets: [{ component: 'desktop', platform: 'darwin', arch: 'arm64', format: 'zip', name: 'fixture.zip', url: 'https://github.com/utopiafar/mote/releases/download/v0.6.0/fixture.zip', size: zip.length, sha256: digest(zip), bundleId: 'dev.mote.collector', signing: 'adhoc' }], images: [] };
function deps(change: Partial<UpdateDependencies> = {}): UpdateDependencies {
  return { check: async () => ({ manifest, available: true }), download: async (_asset, path, options) => { await writeFile(path, zip); options?.onProgress?.(zip.length, zip.length); return path; }, inspect: async () => ({ valid: true, otherInstances: 0, digest: 'a'.repeat(64) }), extract: async (_archive, path) => { await mkdir(join(path, 'Mote.app')); }, ...change };
}
async function updater(dependencies = deps()) { const value = new DesktopUpdater({ directory: join(directory, 'updates'), helper: '/not-used', currentVersion: '0.5.0', arch: 'arm64', profile: 'test' }, dependencies); await value.initialize(); return value; }
async function settled(value: DesktopUpdater) { for (let i = 0; i < 100; i++) { if (!['checking', 'downloading', 'verifying'].includes(value.status().state)) return; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error('fixture timeout'); }
it('checks, downloads and validates the app while preserving every adjacent profile artifact', async () => {
  const files = ['config.json', 'token.enc', 'notes/draft.json', 'queue/event.json', 'models/model.gguf'];
  for (const path of files) { await mkdir(join(directory, ...path.split('/').slice(0, -1)), { recursive: true }); await writeFile(join(directory, path), 'private-synthetic-' + path); }
  const value = await updater(); expect((await value.check()).state).toBe('available'); value.download(); await settled(value);
  expect(value.status().state).toBe('ready'); expect(value.status().canInstall).toBe(false); expect(value.archivePath()).toMatch(/fixture\.zip$/);
  expect(JSON.stringify(value.status())).not.toContain('private-synthetic');
  for (const path of files) expect(await readFile(join(directory, path), 'utf8')).toBe('private-synthetic-' + path);
  await value.close();
});
it('an invalid signed release cannot be downloaded or installed', async () => {
  let downloaded = false;
  const value = await updater(deps({ check: async () => { throw new ReleaseError('invalid_manifest_signature'); }, download: async () => { downloaded = true; return ''; } }));
  expect((await value.check()).state).toBe('error'); expect(() => value.download()).toThrow(); expect(downloaded).toBe(false);
  await expect(value.install(async () => {}, () => {})).rejects.toThrow();
});
it('channel selection persists independently of node credentials and cancels an active transfer', async () => {
  const value = await updater(deps({ download: async (_asset, _path, options) => new Promise((_resolve, reject) => { const fail = () => reject(new Error('cancelled')); options?.signal?.addEventListener('abort', fail, { once: true }); if (options?.signal?.aborted) fail(); }) }));
  await value.check(); value.download(); await value.cancel(); expect(value.status().state).toBe('error'); expect(value.archivePath()).toBeUndefined();
  await value.setChannel('preview'); const restored = await updater(); expect(restored.status().channel).toBe('preview'); expect(restored.status().state).toBe('idle');
});
it('refuses unsafe archives before calling the platform extractor', async () => {
  let extracted = false;
  const value = await updater(deps({ download: async (_asset, path) => { await writeFile(path, updateZip([{ name: '../outside', text: 'fixture' }])); return path; }, extract: async () => { extracted = true; } }));
  await value.check(); value.download(); await settled(value); expect(value.status().state).toBe('error'); expect(extracted).toBe(false); expect(value.archivePath()).toBeUndefined();
});

it('repeated downloads keep one cache and never delete adjacent model or profile data', async () => {
  const value = await updater(); const untouched = join(directory, 'updates', 'downloads', 'manual-export'); await mkdir(untouched, { recursive: true }); await writeFile(join(untouched, 'keep'), 'synthetic');
  await value.check(); value.download(); await settled(value); const first = value.archivePath();
  value.download(); await settled(value); expect(value.status().state).toBe('ready'); expect(value.archivePath()).not.toBe(first);
  await expect(readFile(first!)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readdir(join(directory, 'updates', 'downloads'))).toHaveLength(2); expect(await readFile(join(untouched, 'keep'), 'utf8')).toBe('synthetic');
});
it('detects archive mutation during extraction even when the replacement bundle is ad-hoc signed', async () => {
  const value = await updater(deps({ extract: async (archive, path) => { await mkdir(join(path, 'Mote.app')); await writeFile(archive, Buffer.alloc(zip.length)); } }));
  await value.check(); value.download(); await settled(value); expect(value.status().state).toBe('error'); expect(value.archivePath()).toBeUndefined();
});
