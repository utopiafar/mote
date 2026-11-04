#!/usr/bin/env node
/** Build the release artifact for this external package.
 *
 * The Mote repository packer is development tooling only; runtime files import
 * only `@mote/plugin-sdk`. Outputs are the current Manifest and the
 * deterministic ZIP that a release would attach. */
import {cp, mkdtemp, mkdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {packageManifestSchema} from '@mote/plugin-sdk';
import {unzipSync} from 'fflate';
import {packPlugin} from '../../../scripts/plugin-pack.mjs';

const packageRoot = resolve(fileURLToPath(new URL('../', import.meta.url)));
const repository = resolve(packageRoot, '../..');
const work = await mkdtemp(join(tmpdir(), 'mote-reading-export-pack-'));
try {
  const payload = join(work, 'payload');
  const output = join(work, 'output');
  await mkdir(payload, {recursive: true, mode: 0o700});
  await mkdir(join(payload, 'web'), {recursive: true, mode: 0o700});
  for (const file of ['plugin.mjs', 'domain.mjs', 'port.mjs', 'package.json', 'README.md'])
    await cp(join(packageRoot, file), join(payload, file));
  for (const file of ['index.html', 'bridge.mjs'])
    await cp(join(packageRoot, 'web', file), join(payload, 'web', file));
  const manifestPath = join(packageRoot, 'mote-plugin.json');
  const result = await packPlugin({
    manifestPath,
    payload,
    out: output,
    manifestSchema: packageManifestSchema,
    validateArchive: (bytes, manifest) => {
      const entries = unzipSync(new Uint8Array(bytes));
      for (const name of Object.keys(entries)) {
        if (!name || name.startsWith('/') || name.includes('\\') || name.split('/').some(part => !part || part === '.' || part === '..'))
          throw Error(`Invalid archive path: ${name}`);
      }
      if (!entries[manifest.entry]) throw Error(`Missing package entry: ${manifest.entry}`);
      for (const contribution of manifest.contributions ?? [])
        if (contribution.entry && !entries[contribution.entry]) throw Error(`Missing contribution entry: ${contribution.entry}`);
      return entries;
    },
  });
  await cp(result.manifestPath, manifestPath);
  await mkdir(join(packageRoot, 'archive'), {recursive: true, mode: 0o755});
  await cp(result.zipPath, join(packageRoot, 'archive', result.manifest.archive.asset));
  console.log(JSON.stringify({manifest: result.manifestPath, archive: result.zipPath, digest: result.digest,
    entries: result.entries, repository}, null, 2));
} finally {
  await rm(work, {recursive: true, force: true});
}
