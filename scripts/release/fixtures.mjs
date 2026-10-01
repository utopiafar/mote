import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { loadComponent } from './components.mjs';

export function releaseFixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mote-component-release-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (path, data) => { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), typeof data === 'string' ? data : JSON.stringify(data, null, 2) + '\n'); };
  const config = JSON.parse(readFileSync(new URL('../../release/components.json', import.meta.url), 'utf8'));
  write('release/components.json', config);
  write('release/signing-policy.json', { repository: 'fixture/mote', androidCertificateSha256: 'fixture-cert', androidPackages: ['dev.mote.collector', 'dev.mote.collector.dev'] });
  write('package.json', { name: 'mote', private: true, workspaces: ['apps/*', 'packages/*'] });
  const packages = {};
  for (const app of ['server', 'web', 'desktop']) {
    write(`apps/${app}/package.json`, { name: `@mote/${app}`, version: app === 'desktop' ? '2.5.0' : '1.4.0', private: true });
    packages[`apps/${app}`] = { version: app === 'desktop' ? '2.5.0' : '1.4.0' };
  }
  write('apps/android/version.properties', 'versionName=3.8.0\nversionCode=87\n');
  write('package-lock.json', { name: 'mote', lockfileVersion: 3, packages });
  for (const component of ['central', 'desktop', 'android']) {
    const release = loadComponent(component, root);
    write(release.notes, `# Generated ${component} release notes\n`);
  }
  return { root, write, read: path => readFileSync(join(root, path), 'utf8'), policy: JSON.parse(readFileSync(join(root, 'release/signing-policy.json'), 'utf8')) };
}
export function fixtureAsset(fixture, component, overrides = {}) {
  const release = loadComponent(component, fixture.root);
  const name = component === 'central' ? `mote-server-${release.version}.tar.gz` : component === 'desktop' ? `mote-desktop-macos-dev-arm64-${release.version}.zip` : `mote-android-dev-arm64-${release.version}.apk`;
  const bytes = Buffer.from(`Generated ${component} fixture`);
  const metadata = {
    component: release.assetComponent, name, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
    url: `https://github.com/${fixture.policy.repository}/releases/download/${release.tag}/${name}`,
    ...(component === 'desktop' ? { bundleId: 'dev.mote.collector.dev', signing: 'adhoc', platform: 'darwin', arch: 'arm64', format: 'zip' } : {}),
    ...(component === 'android' ? { packageName: 'dev.mote.collector.dev', versionCode: release.versionCode, certificateSha256: fixture.policy.androidCertificateSha256, platform: 'android', arch: 'arm64', format: 'apk' } : {}),
    ...(component === 'central' ? { platform: 'source', arch: 'all', format: 'tar.gz' } : {}), ...overrides
  };
  fixture.write(`artifacts/release/${name}`, bytes.toString());
  fixture.write(`artifacts/release/${name}.asset.json`, metadata);
  return { release, name, metadata, directory: join(fixture.root, 'artifacts/release') };
}
