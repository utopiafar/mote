import { afterEach, beforeEach, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
let root: string; let server: Server; let url: string; let items: Record<string, unknown>[]; let fail: boolean;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'mote-source-cli-'))); items = []; fail = false;
  server = createServer(async (req, res) => {
    const buffers: Buffer[] = []; for await (const chunk of req) buffers.push(chunk);
    const body = JSON.parse(Buffer.concat(buffers).toString()); res.setHeader('Content-Type', 'application/json');
    if (req.method === 'POST') res.end(JSON.stringify(body));
    else if (req.method === 'PATCH') res.end(JSON.stringify({ ...body, id: req.url!.split('/').at(-1) }));
    else { items.push(body); if (fail) { res.destroy(); return; } res.end(JSON.stringify({ id: 'b67c1b84-f2cd-4e59-bf67-215545a882dc', sourceId: req.url!.split('/')[3], externalId: body.externalId, revision: body.revision, duplicate: false })); }
  });
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  url = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
});
afterEach(async () => { server?.closeAllConnections(); await new Promise<void>(done => server?.close(() => done())); await rm(root, { recursive: true, force: true }); });
async function run(profile: string, args: string[] = [], token = 'synthetic-cli-token') {
  const directory = join(root, profile); await mkdir(directory, { recursive: true });
  const envFile = join(directory, 'mote.env'); await writeFile(envFile, `MOTE_PROFILE=${profile}\nMOTE_URL=${url}\nMOTE_TOKEN=${token}\n`);
  const child = spawn(process.execPath, ['--import', 'tsx', resolve('../../scripts/import-files.ts'), '--root', join(root, 'selected'), ...args], { cwd: resolve('../..'), env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('MOTE_'))), MOTE_ENV_FILE: envFile }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', chunk => output += chunk); child.stderr.on('data', () => {});
  const code = await new Promise<number | null>((done, reject) => { child.once('error', reject); child.once('exit', done); });
  return { code, output, directory };
}
it('CLI independently syncs the same source for two profiles, then skips acknowledged unchanged versions', async () => {
  await mkdir(join(root, 'selected')); await writeFile(join(root, 'selected', 'a.md'), '合成 CLI 🧑🏽‍💻');
  for (const profile of ['dev', 'test']) { expect((await run(profile)).output).toContain('Imported 1 changed'); expect((await run(profile)).output).toContain('Imported 0 changed'); }
  expect(items).toHaveLength(2); expect(items[0].text).toBe('合成 CLI 🧑🏽‍💻');
}, 15000);
it('CLI restores an unacknowledged revision after failed process, then tracks explicit deletion and restoration', async () => {
  await mkdir(join(root, 'selected')); const file = join(root, 'selected', 'a.md'); await writeFile(file, '合成离线版本');
  fail = true; expect((await run('dev', ['--track-deletions'])).code).not.toBe(0);
  fail = false; expect((await run('dev', ['--track-deletions'])).code).toBe(0); expect(items[0]).toEqual(items[1]);
  await rm(file); expect((await run('dev', ['--track-deletions'])).code).toBe(0); expect(items.at(-1)?.deleted).toBe(true);
  await writeFile(file, '合成离线版本'); expect((await run('dev', ['--track-deletions'])).code).toBe(0);
  expect(items.at(-1)?.revision).not.toBe(items[0].revision); expect(items.at(-1)?.text).toBe('合成离线版本');
}, 15000);
it('CLI recovers a lock whose former process has exited, while preserving acknowledged state', async () => {
  await mkdir(join(root, 'selected')); await writeFile(join(root, 'selected', 'a.md'), '合成 crash lock');
  const imported = await run('dev'); expect(imported.code).toBe(0);
  const stateDir = join(imported.directory, 'file-sync'); const stateFile = (await readdir(stateDir)).find(file => file.endsWith('.json'))!;
  const child = spawn(process.execPath, ['-e', 'process.exit(0)']); await new Promise(done => child.once('exit', done));
  await writeFile(join(stateDir, stateFile + '.lock'), String(child.pid));
  expect((await run('dev')).output).toContain('Imported 0 changed'); expect(items).toHaveLength(1);
}, 15000);
it('CLI credential change at the same URL isolates old pending text and submits only the current scan', async () => {
  await mkdir(join(root, 'selected')); const file = join(root, 'selected', 'a.md'); await writeFile(file, 'old synthetic private text');
  fail = true; expect((await run('dev')).code).not.toBe(0);
  fail = false; await writeFile(file, 'new synthetic current text');
  expect((await run('dev', [], 'other-synthetic-token')).code).toBe(0);
  expect(items).toHaveLength(2); expect(items[1].text).toBe('new synthetic current text');
}, 15000);
it('CLI dry-run writes no sync state, while reference mode sends no body', async () => {
  await mkdir(join(root, 'selected')); await writeFile(join(root, 'selected', 'a.md'), '合成引用正文');
  const dry = await run('dev', ['--dry-run']); expect(dry.code).toBe(0); expect((await readdir(dry.directory))).toEqual(['mote.env']); expect(items).toHaveLength(0);
  expect((await run('dev', ['--retention', 'reference'])).code).toBe(0); expect(items[0].text).toBe(''); expect(items[0].layer).toBe('reference');
}, 15000);
