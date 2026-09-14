import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acknowledgeInstalledUpdate } from '../src/update-install';
let root: string;
beforeEach(async () => { root = await realpath(await mkdtemp(join(tmpdir(), 'mote-update-ack-'))); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const directory = join(root, 'profile', 'updates'), nonce = 'a'.repeat(32), transaction = join(directory, 'transactions', nonce), bundlePath = join(root, 'Mote.app');
  await mkdir(transaction, { recursive: true });
  const job = { schemaVersion: 1, nonce, newVersion: '0.5.0', profile: 'test', targetPath: bundlePath };
  await writeFile(join(transaction, 'job.json'), JSON.stringify(job));
  return { directory, transaction, job, args: { argv: ['--mote-update-transaction=' + transaction], directory, bundlePath, version: '0.5.0', profile: 'test' } };
}
it('acknowledges only its own matching version, bundle and profile transaction', async () => {
  const value = await fixture(); await acknowledgeInstalledUpdate(value.args);
  expect(JSON.parse(await readFile(join(value.transaction, 'ready.json'), 'utf8'))).toEqual({ nonce: value.job.nonce, version: '0.5.0' });
});
it('never writes readiness into another profile, bundle, version or arbitrary launch path', async () => {
  const value = await fixture();
  for (const change of [{ profile: 'legacy' }, { version: '0.4.0' }, { bundlePath: join(root, 'Other.app') }, { directory: join(root, 'other') }, { argv: [...value.args.argv, ...value.args.argv] }]) await acknowledgeInstalledUpdate({ ...value.args, ...change });
  await expect(readFile(join(value.transaction, 'ready.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  const outside = join(root, 'outside'); await mkdir(outside); await writeFile(join(outside, 'job.json'), JSON.stringify(value.job));
  await rm(value.transaction, { recursive: true }); await symlink(outside, value.transaction);
  await acknowledgeInstalledUpdate(value.args); await expect(readFile(join(outside, 'ready.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});
