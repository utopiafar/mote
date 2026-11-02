#!/usr/bin/env node
/** Deterministic package payload packer for the current H03 PackageManifest.
 *
 * The release Manifest is external to the ZIP payload. This intentionally
 * avoids a self-reference when the Manifest carries the archive digest. */
import {createHash} from 'node:crypto';
import {mkdir, readFile, readdir, lstat, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {zipSync} from 'fflate';

// fflate writes ZIP date fields from local getters; fixed local fields keep
// the archive independent of the machine timezone.
const ZIP_MTIME = new Date(1980, 0, 1, 0, 0, 0);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const safePath = value => Boolean(value) && !value.startsWith('/') && !value.includes('\\') && !value.split('/').some(part => !part || part === '.' || part === '..');

async function collect(directory, base = '') {
  const files = [];
  for (const entry of await readdir(directory, {withFileTypes: true})) {
    const path = base ? base + '/' + entry.name : entry.name;
    if (!safePath(path)) throw Error(`Invalid payload path: ${path}`);
    const absolute = join(directory, entry.name);
    const stat = await lstat(absolute);
    if (stat.isSymbolicLink()) throw Error(`Payload must not contain symbolic links: ${path}`);
    if (stat.isDirectory()) files.push(...await collect(absolute, path));
    else if (stat.isFile()) {
      if (path !== 'mote-plugin.json') files.push({path, bytes: await readFile(absolute)});
    } else throw Error(`Unsupported payload entry: ${path}`);
  }
  return files;
}

export async function packPlugin({manifestPath, payload, out, manifestSchema, validateArchive}) {
  const manifestFile = resolve(manifestPath);
  const payloadRoot = resolve(payload), output = resolve(out);
  if (output === payloadRoot || output.startsWith(payloadRoot + '/')) throw Error('Output directory must be outside the payload tree');
  let release;
  if (!manifestSchema || !validateArchive) {
    try { release = await import(new URL('../apps/server/dist/plugin-release.js', import.meta.url).href); }
    catch { throw Error('Build @mote/server before packing (the release Manifest contract and archive validator are shared)'); }
  }
  const manifest = (manifestSchema ?? release.pluginManifestSchema).parse(JSON.parse(await readFile(manifestFile, 'utf8')));
  const files = (await collect(payloadRoot)).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  if (!files.some(file => file.path === manifest.entry)) throw Error(`Manifest entry is absent from payload: ${manifest.entry}`);
  for (const contribution of manifest.contributions ?? []) if (contribution.entry && !files.some(file => file.path === contribution.entry)) throw Error(`Contribution entry is absent from payload: ${contribution.entry}`);
  const zippable = Object.fromEntries(files.map(file => [file.path, [file.bytes, {mtime: ZIP_MTIME, os: 0}]]));
  const archive = zipSync(zippable, {level: 9});
  const validator = validateArchive ?? release.validatePluginArchive;
  validator(archive, manifest);
  const digest = hash(archive);
  const releaseManifest = {...manifest, archive: {...manifest.archive, sha256: digest}};
  await mkdir(output, {recursive: true, mode: 0o700});
  const zipPath = join(output, manifest.archive.asset);
  const manifestOut = join(output, 'mote-plugin.json');
  await writeFile(zipPath, archive, {mode: 0o600});
  await writeFile(manifestOut, JSON.stringify(releaseManifest, null, 2) + '\n', {mode: 0o600});
  return {manifest: releaseManifest, manifestPath: manifestOut, zipPath, digest, entries: files.map(file => file.path)};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const {parseArgs} = await import('node:util');
  const {values} = parseArgs({args: process.argv.slice(2), options: {
    manifest: {type: 'string'}, payload: {type: 'string'}, out: {type: 'string'}, help: {type: 'boolean', short: 'h'},
  }});
  if (values.help || !values.manifest || !values.payload || !values.out) {
    console.info('Usage: node scripts/plugin-pack.mjs --manifest FILE --payload DIR --out DIR');
    process.exit(values.help ? 0 : 1);
  }
  packPlugin({manifestPath: values.manifest, payload: values.payload, out: values.out}).then(result => console.info(JSON.stringify(result))).catch(error => { console.error(`Mote plugin-pack: ${error.message}`); process.exitCode = 1; });
}
