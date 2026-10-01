import { mkdtemp, readFile, lstat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractSourceArchive } from '../update-archive.mjs';
import { verifyComponent } from './components.mjs';

export const centralBuildInputs = [
  'tsconfig.base.json', 'apps/server/tsconfig.json', 'apps/server/src/index.ts',
  'apps/web/tsconfig.json', 'apps/web/index.html', 'apps/web/src/main.tsx',
  'packages/shared/package.json', 'packages/shared/tsconfig.json', 'packages/shared/src/index.ts',
  'packages/agent/package.json', 'packages/agent/tsconfig.json', 'packages/agent/src/index.ts'
];
export async function verifySourceArchive(archive, release) {
  const temporary = await mkdtemp(join(tmpdir(), 'mote-release-source-'));
  const stage = join(temporary, 'source');
  try {
    const extracted = await extractSourceArchive(archive, stage, `mote-${release.version}/`);
    const root = JSON.parse(await readFile(join(stage, 'package.json'), 'utf8'));
    if (root.name !== 'mote' || root.private !== true || root.version !== undefined || !Array.isArray(root.workspaces)) throw Error('Invalid private monorepo source package');
    const archived = verifyComponent('central', { root: stage });
    if (archived.version !== release.version) throw Error('Archived central version differs');
    for (const app of ['server', 'web']) {
      const pkg = JSON.parse(await readFile(join(stage, `apps/${app}/package.json`), 'utf8'));
      if (pkg.name !== `@mote/${app}` || pkg.private !== true) throw Error('Invalid archived central workspace identity');
    }
    for (const path of centralBuildInputs) {
      const file = await lstat(join(stage, path)).catch(() => undefined);
      if (!file?.isFile()) throw Error(`Central source archive is missing build input: ${path}`);
    }
    return extracted;
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
