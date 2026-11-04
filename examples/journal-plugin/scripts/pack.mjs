#!/usr/bin/env node
/** Build this package's release artifact: a deterministic ZIP payload plus
 * the completed Manifest with the archive digest filled in. The Mote checkout
 * supplies the deterministic packer as development tooling only; package
 * files never import repository source. Pass `--mote PATH` or set
 * MOTE_REPOSITORY to a Mote checkout. */
import {cp, mkdir, mkdtemp, rm} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {packageManifestSchema} from '@mote/plugin-sdk';

const packageRoot = resolve(fileURLToPath(new URL('../', import.meta.url)));
const {values} = parseArgs({
  args: process.argv.slice(2),
  options: {mote: {type: 'string'}, out: {type: 'string'}, help: {type: 'boolean', short: 'h'}},
});
if (values.help) {
  console.info('Usage: node scripts/pack.mjs [--mote PATH] [--out DIR]');
  process.exit(0);
}
const moteInput = values.mote ?? process.env.MOTE_REPOSITORY;
if (!moteInput) throw Error('Pass --mote PATH or set MOTE_REPOSITORY to a Mote checkout');
const mote = resolve(moteInput);
const {packPlugin} = await import(pathToFileURL(join(mote, 'scripts/plugin-pack.mjs')).href);
const repositoryRequire = createRequire(join(mote, 'package.json'));
const {unzipSync} = repositoryRequire('fflate');

/** Same archive boundary the release resolver enforces: relative paths only,
 * the package entry and every declared contribution entry must be present. */
function validateArchive(bytes, manifest) {
  const entries = unzipSync(new Uint8Array(bytes));
  for (const name of Object.keys(entries)) {
    if (!name || name.startsWith('/') || name.includes('\\') || name.split('/').some(part => !part || part === '.' || part === '..'))
      throw Error(`Invalid archive path: ${name}`);
  }
  if (!entries[manifest.entry]) throw Error(`Missing package entry: ${manifest.entry}`);
  for (const contribution of manifest.contributions ?? []) {
    if (contribution.entry && !entries[contribution.entry]) throw Error(`Missing contribution entry: ${contribution.entry}`);
  }
}

const work = await mkdtemp(join(tmpdir(), 'mote-plugin-pack-'));
try {
  const payload = join(work, 'payload');
  await mkdir(payload, {recursive: true, mode: 0o700});
  for (const file of ['plugin.mjs', 'connector.mjs', 'backend.mjs', 'package.json', 'README.md'])
    await cp(join(packageRoot, file), join(payload, file));
  const out = resolve(packageRoot, values.out ?? 'dist');
  const result = await packPlugin({
    manifestPath: join(packageRoot, 'mote-plugin.json'),
    payload,
    out,
    manifestSchema: packageManifestSchema,
    validateArchive,
  });
  console.info(JSON.stringify(result));
} finally {
  await rm(work, {recursive: true, force: true});
}
