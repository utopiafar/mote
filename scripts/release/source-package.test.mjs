import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { releaseFixture } from './fixtures.mjs';
import { centralBuildInputs } from './source-validation.mjs';

test('Central container includes every production workspace dependency before install and in runtime', () => {
  const lock = JSON.parse(readFileSync('package-lock.json', 'utf8')).packages;
  const manifests = new Map(Object.entries(lock).filter(([path, value]) => !path.includes('node_modules') && value.name).map(([path, value]) => [value.name, {path, ...value}]));
  const required = new Map();
  const visit = name => {
    const manifest = manifests.get(name);
    if (!manifest || required.has(name)) return;
    required.set(name, manifest);
    for (const dependency of Object.keys(manifest.dependencies ?? {})) visit(dependency);
  };
  visit('@mote/server');
  const docker = readFileSync('Dockerfile', 'utf8'), [build, runtime] = docker.split(/^FROM .* AS runtime$/m);
  for (const {path} of required.values()) {
    const copy = `COPY ${path}/package.json ./${path}/package.json`;
    for (const stage of [build, runtime]) assert.ok(stage.indexOf(copy) >= 0 && stage.indexOf(copy) < stage.indexOf('RUN npm ci'), path);
    assert.ok(runtime.includes(`COPY --from=build /app/${path}/dist ./${path}/dist`), path);
  }
});

test('central packaging archives the committed monorepo with the central version and grouped URL', t => {
  const fixture = releaseFixture(t);
  for (const path of centralBuildInputs) fixture.write(path, path.endsWith('package.json') ? { name: `@mote/${path.split('/')[1]}`, version: '0.1.0', private: true } : 'Generated build input fixture');
  mkdirSync(join(fixture.root, 'scripts/release'), { recursive: true });
  for (const script of ['asset-metadata.mjs', 'components.mjs', 'android-dev-build.mjs']) copyFileSync(new URL(script, import.meta.url), join(fixture.root, 'scripts/release', script));
  const git = args => execFileSync('git', args, { cwd: fixture.root, stdio: 'pipe' });
  git(['init']); git(['add', '.']); git(['-c', 'user.name=Generated Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Generated source fixture']);
  fixture.write('untracked-fixture.txt', 'Generated uncommitted content');
  const env = { ...process.env, MOTE_BUILD_PROFILE: 'prod', GITHUB_REF: 'refs/tags/central-v1.4.0', GITHUB_REPOSITORY: fixture.policy.repository };
  execFileSync(process.execPath, [new URL('./source-package.mjs', import.meta.url).pathname], { cwd: fixture.root, env, stdio: 'pipe' });
  const archive = join(fixture.root, 'artifacts/release/mote-server-1.4.0.tar.gz'), metadata = JSON.parse(readFileSync(archive + '.asset.json', 'utf8'));
  assert.equal(metadata.component, 'server'); assert.equal(metadata.url, 'https://github.com/fixture/mote/releases/download/central-v1.4.0/mote-server-1.4.0.tar.gz');
  const files = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n');
  assert.ok(files.includes('mote-1.4.0/apps/server/package.json'));
  assert.ok(files.every(name => name.startsWith('mote-1.4.0/')));
  assert.ok(files.every(name => !name.includes('untracked-fixture')));
  const commit = git(['rev-parse', 'HEAD']).toString().trim();
  const devEnv = { ...env, MOTE_BUILD_PROFILE: 'dev', GITHUB_REF: 'refs/heads/main' };
  execFileSync(process.execPath, [new URL('./source-package.mjs', import.meta.url).pathname], { cwd: fixture.root, env: devEnv, stdio: 'pipe' });
  const devMetadata = JSON.parse(readFileSync(archive + '.asset.json', 'utf8'));
  assert.equal(devMetadata.profile, 'dev'); assert.equal(devMetadata.commit, commit); assert.equal(devMetadata.url, undefined);
  const buildInfo = JSON.parse(readFileSync(join(fixture.root, 'artifacts/release/build-info.json'), 'utf8'));
  assert.equal(buildInfo.commit, commit); assert.equal(buildInfo.tag, undefined);
  git(['rm', 'apps/web/src/main.tsx']); git(['-c', 'user.name=Generated Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Generated incomplete source fixture']);
  const incomplete = spawnSync(process.execPath, [new URL('./source-package.mjs', import.meta.url).pathname], { cwd: fixture.root, env, encoding: 'utf8' });
  assert.notEqual(incomplete.status, 0); assert.match(incomplete.stderr, /missing build input: apps\/web\/src\/main.tsx/);
  fixture.write('apps/server/package.json', { version: '1.5.0' }); fixture.write('apps/web/package.json', { version: '1.5.0' });
  const lock = JSON.parse(fixture.read('package-lock.json')); lock.packages['apps/server'].version = '1.5.0'; lock.packages['apps/web'].version = '1.5.0'; fixture.write('package-lock.json', lock);
  fixture.write('release/notes/central/1.5.0.md', 'Generated next central notes');
  const result = spawnSync(process.execPath, [new URL('./source-package.mjs', import.meta.url).pathname], { cwd: fixture.root, env: { ...env, GITHUB_REF: 'refs/tags/central-v1.5.0' }, encoding: 'utf8' });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /must be committed/);
});
