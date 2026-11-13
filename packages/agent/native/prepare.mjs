// Build the pinned native dependency. Reuses the source/toolchain/target caches;
// never installs a Rust toolchain or changes the system Codex installation.
import {createHash} from 'node:crypto';
import {access, copyFile, mkdir, readFile, rename, writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {delimiter, join, resolve} from 'node:path';

const here = fileURLToPath(new URL('.', import.meta.url));
const root = resolve(here, '../../..');
const version = '0.162.1';
const sourceSha256 = 'e709bda93494c000a69d4c07a85a1975ce433f5541e737d1a5feddd399c97c60';
const cache = resolve(process.env.MOTE_CODEX_NATIVE_BUILD_ROOT || join(root, '.mote/native/codex'));
const source = join(cache, 'source'), rust = join(source, 'codex-rs');
const archive = resolve(process.env.MOTE_CODEX_SOURCE_ARCHIVE || join(cache, `codex-${version}.tar.gz`));
const patch = join(here, 'codex.patch');
const exists = path => access(path).then(() => true, () => false);
const hash = async path => createHash('sha256').update(await readFile(path)).digest('hex');
const env = {...process.env, RUSTUP_AUTO_INSTALL: '0', CARGO_TARGET_DIR: join(cache, 'target'), XDG_CACHE_HOME: join(cache, 'xdg-cache')};
if (await exists(join(cache, 'cargo'))) env.CARGO_HOME = join(cache, 'cargo');
if (await exists(join(cache, 'rustup'))) env.RUSTUP_HOME = join(cache, 'rustup');
if (env.CARGO_HOME) env.PATH = join(env.CARGO_HOME, 'bin') + delimiter + env.PATH;
const cargo = env.CARGO_HOME && await exists(join(env.CARGO_HOME, 'bin/cargo')) ? join(env.CARGO_HOME, 'bin/cargo') : 'cargo';

async function run(command, args, cwd = root, {quiet = false, allowFailure = false} = {}) {
  const status = await new Promise((done, reject) => {
    const child = spawn(command, args, {cwd, env, stdio: quiet ? 'ignore' : 'inherit'});
    child.once('error', reject); child.once('exit', code => done(code ?? 1));
  });
  if (status && !allowFailure) throw new Error(`${command} failed (${status})`);
  return status;
}

await mkdir(cache, {recursive: true});
if (!await exists(archive)) {
  await run('curl', ['--fail', '--location', '--silent', '--show-error', '--output', archive,
    `https://codeload.github.com/openai/codex/tar.gz/refs/tags/rust-v${version}`]);
}
if (await hash(archive) !== sourceSha256) throw new Error('Pinned Codex source checksum mismatch');
if (!await exists(rust)) {
  await mkdir(source, {recursive: true});
  await run('tar', ['-xzf', archive, '--strip-components=1', '-C', source]);
}
if (await run('patch', ['--dry-run', '--forward', '-p1', '-i', patch], rust, {quiet: true, allowFailure: true}) === 0) {
  await run('patch', ['--forward', '-p1', '-i', patch], rust);
} else if (await run('patch', ['--dry-run', '--reverse', '-p1', '-i', patch], rust, {quiet: true, allowFailure: true}) !== 0) {
  throw new Error('Native source differs from the pinned Mote patch; use an isolated build root');
}
const budgetSource = join(here, 'context_budget.rs'), budgetTarget = join(rust, 'codex-api/src/context_budget.rs');
if (!await exists(budgetTarget) || await hash(budgetSource) !== await hash(budgetTarget)) await copyFile(budgetSource, budgetTarget);
const offline = process.argv.includes('--online') ? [] : ['--offline'];
if (process.argv.includes('--test')) {
  await run(cargo, ['+1.95.0', 'test', '--locked', ...offline, '--profile', 'dev-small', '-j', '4', '-p', 'codex-api', '--lib', 'context_budget::tests'], rust);
} else {
  await run(cargo, ['+1.95.0', 'build', '--locked', ...offline, '--profile', 'dev-small', '-j', '4', '-p', 'codex-app-server', '--bin', 'codex-app-server'], rust);
  const binary = join(cache, 'target/dev-small/codex-app-server');
  await run(binary, ['--mote-context-budget-version']);
  await mkdir(join(here, 'bin'), {recursive: true});
  // A running Mach-O must never be overwritten in place: macOS caches signed
  // executable pages by vnode. Install a fresh inode atomically on all hosts.
  const installed = join(here, `bin/codex-app-server.next-${process.pid}`);
  await copyFile(binary, installed);
  await rename(installed, join(here, 'bin/codex-app-server'));
  await writeFile(join(here, 'bin/build.json'), JSON.stringify({version, sourceSha256, patchSha256: await hash(patch),
    budgetSha256: await hash(join(here, 'context_budget.rs')), binarySha256: await hash(binary)}, null, 2) + '\n');
}
