import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { verifyComponent } from './components.mjs';
import { verifySourceArchive } from './source-validation.mjs';

const release = verifyComponent('central', { ref: process.env.GITHUB_REF, repository: process.env.GITHUB_REPOSITORY });
// Archive the committed monorepo so npm workspaces and shared dependencies remain reproducible.
for (const path of release.packages) {
  const committed = JSON.parse(execFileSync('git', ['show', `HEAD:${path}`], { encoding: 'utf8' }));
  if (committed.version !== release.version) throw Error('Central source version must be committed before packaging');
}
const directory = resolve(process.env.MOTE_RELEASE_OUTPUT || 'artifacts/release');
mkdirSync(directory, { recursive: true });
const archive = join(directory, `mote-server-${release.version}.tar.gz`);
execFileSync('git', ['archive', '--format=tar.gz', `--prefix=mote-${release.version}/`, '--output', archive, 'HEAD'], { stdio: 'inherit' });
await verifySourceArchive(archive, release);
execFileSync(process.execPath, ['scripts/release/asset-metadata.mjs', 'server', archive], { stdio: 'inherit' });
