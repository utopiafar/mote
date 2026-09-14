import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, copyFile, appendFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile), publicSource = process.argv.includes('--public');
const root = await mkdtemp(join(tmpdir(), 'mote-setup-vision-'));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
const execute = (file, args, options = {}) => run(file, args, { env, timeout: 180000, maxBuffer: 4 * 1024 * 1024, ...options });
try {
  const project = join(root, 'project'), scripts = join(project, 'scripts'); await mkdir(scripts, { recursive: true });
  const script = join(scripts, 'setup-vision.sh'); await copyFile(resolve('scripts/setup-vision.sh'), script);
  const original = await readFile(script, 'utf8'); let revision = /MOTE_LLAMA_REVISION=([a-f0-9]{40})/.exec(original)?.[1]; assert(revision);
  if (!publicSource) {
    const source = join(root, 'source'); await mkdir(source);
    await execute('git', ['init', source]); await writeFile(join(source, 'fixture.txt'), 'generated source\n');
    await execute('git', ['-C', source, 'add', 'fixture.txt']);
    await execute('git', ['-C', source, '-c', 'user.name=Mote Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'generated fixed source']);
    revision = (await execute('git', ['-C', source, 'rev-parse', 'HEAD'])).stdout.trim();
    // Keep production behavior, substituting only the isolated Git origin and pinned fixture commit.
    await writeFile(script, original.replaceAll('https://github.com/ggml-org/llama.cpp.git', source).replace(/MOTE_LLAMA_REVISION=[a-f0-9]{40}/, 'MOTE_LLAMA_REVISION=' + revision));
  }
  console.log(JSON.stringify({ phase: 'fresh-clone', publicSource }));
  await execute('sh', [script]);
  const checkout = join(project, 'vendor', 'llama.cpp');
  assert.equal((await execute('git', ['-C', checkout, 'rev-parse', 'HEAD'])).stdout.trim(), revision);
  assert.equal((await execute('git', ['-C', checkout, 'status', '--porcelain'])).stdout, '');
  console.log(JSON.stringify({ phase: 'repeat-clean-checkout', publicSource }));
  await execute('sh', [script]);
  const tracked = publicSource ? 'README.md' : 'fixture.txt';
  await appendFile(join(checkout, tracked), '\nMote synthetic setup regression modification\n');
  const modified = await readFile(join(checkout, tracked));
  await assert.rejects(execute('sh', [script]), error => /has local edits/.test(error.stderr));
  assert.deepEqual(await readFile(join(checkout, tracked)), modified);
  await execute('git', ['-C', checkout, 'restore', '--', tracked]);
  const untracked = join(checkout, 'mote-untracked-fixture.txt'); await writeFile(untracked, 'must preserve\n');
  await assert.rejects(execute('sh', [script]), error => /has local edits/.test(error.stderr));
  assert.equal(await readFile(untracked, 'utf8'), 'must preserve\n');
  console.log(JSON.stringify({ ok: true, publicSource, pinnedRevision: revision, freshClone: true, repeatCleanCheckout: true, modifiedTrackedFileRejectedAndPreserved: true, untrackedFileRejectedAndPreserved: true }));
} finally { await rm(root, { recursive: true, force: true }); }
