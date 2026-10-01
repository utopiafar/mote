import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { loadComponent, bumpComponentVersion, verifyComponent, validVersion, compareVersions } from './components.mjs';
import { releaseFixture } from './fixtures.mjs';

test('central bump synchronizes server/web and their lock entries without changing clients', t => {
  const fixture = releaseFixture(t), android = fixture.read('apps/android/version.properties'), desktop = fixture.read('apps/desktop/package.json');
  assert.equal(bumpComponentVersion('central', 'minor', fixture.root).version, '1.5.0');
  assert.equal(JSON.parse(fixture.read('apps/web/package.json')).version, '1.5.0');
  assert.equal(JSON.parse(fixture.read('package-lock.json')).packages['apps/server'].version, '1.5.0');
  assert.equal(fixture.read('apps/android/version.properties'), android);
  assert.equal(fixture.read('apps/desktop/package.json'), desktop);
  assert.throws(() => verifyComponent('central', { root: fixture.root }), /ENOENT/);
  fixture.write('release/notes/central/1.5.0.md', 'Generated central fixture notes');
  assert.equal(verifyComponent('central', { root: fixture.root }).tag, 'central-v1.5.0');
});
test('desktop bump leaves central versions and Android code unchanged', t => {
  const fixture = releaseFixture(t), central = fixture.read('apps/server/package.json'), web = fixture.read('apps/web/package.json'), android = fixture.read('apps/android/version.properties');
  bumpComponentVersion('desktop', '2.5.1', fixture.root);
  assert.equal(loadComponent('desktop', fixture.root).version, '2.5.1');
  assert.equal(fixture.read('apps/server/package.json'), central);
  assert.equal(fixture.read('apps/web/package.json'), web);
  assert.equal(fixture.read('apps/android/version.properties'), android);
});
test('Android bump increments only Android versionName/code and does not edit npm lockfile', t => {
  const fixture = releaseFixture(t), lock = fixture.read('package-lock.json'), desktop = fixture.read('apps/desktop/package.json');
  const release = bumpComponentVersion('android', 'major', fixture.root);
  assert.equal(release.version, '4.0.0'); assert.equal(release.versionCode, 88);
  assert.equal(fixture.read('package-lock.json'), lock);
  assert.equal(fixture.read('apps/desktop/package.json'), desktop);
});
test('selected stream verification rejects stale locks, missing/empty notes, wrong tag and fork identity', t => {
  const fixture = releaseFixture(t), options = { root: fixture.root, ref: 'refs/tags/desktop-v2.5.0', repository: 'fixture/mote' };
  assert.equal(verifyComponent('desktop', options).version, '2.5.0');
  for (const ref of ['refs/tags/v2.5.0', 'refs/tags/android-v2.5.0', 'refs/heads/main']) assert.throws(() => verifyComponent('desktop', { ...options, ref }), /exact component version tag/);
  assert.throws(() => verifyComponent('desktop', { ...options, repository: 'fork/mote' }), /fork/);
  fixture.write('release/notes/desktop/2.5.0.md', ' \n');
  assert.throws(() => verifyComponent('desktop', options), /notes/);
  fixture.write('release/notes/desktop/2.5.0.md', 'Generated notes');
  const lock = JSON.parse(fixture.read('package-lock.json')); lock.packages['apps/desktop'].version = '9.9.9'; fixture.write('package-lock.json', lock);
  assert.throws(() => verifyComponent('desktop', options), /package-lock/);
  // A broken unrelated group cannot block an Android release.
  fixture.write('apps/web/package.json', { version: 'invalid' });
  assert.equal(verifyComponent('android', { root: fixture.root }).version, '3.8.0');
  assert.throws(() => loadComponent('central', fixture.root), /versions differ/);
});
test('version bumps reject downgrades and invalid semver without modifying files', t => {
  const fixture = releaseFixture(t), before = fixture.read('apps/android/version.properties');
  for (const version of ['3.8.0', '3.7.99', 'v3.9.0', '3.9.0-01', '3.9', '03.9.0', '3.9.0+metadata']) assert.throws(() => bumpComponentVersion('android', version, fixture.root), /newer/);
  assert.equal(fixture.read('apps/android/version.properties'), before);
  fixture.write('apps/android/version.properties', 'versionName=3.8.0\nversionCode=2100000000\n');
  assert.throws(() => bumpComponentVersion('android', 'patch', fixture.root), /limit/);
  assert.equal(validVersion('1.2.3-rc.1'), true);
  assert.equal(compareVersions('1.2.3-rc.9', '1.2.3-rc.10'), -1);
  assert.equal(compareVersions('1.2.3', '1.2.3-rc.10'), 1);
  assert.throws(() => loadComponent('web', fixture.root), /Choose/);
});
test('release version CLI performs an isolated group bump', t => {
  const fixture = releaseFixture(t);
  const output = execFileSync(process.execPath, [new URL('./version.mjs', import.meta.url).pathname, 'desktop', 'patch'], { cwd: fixture.root, encoding: 'utf8' });
  assert.equal(JSON.parse(output).tag, 'desktop-v2.5.1');
  assert.equal(loadComponent('central', fixture.root).version, '1.4.0');
});
