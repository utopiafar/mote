#!/usr/bin/env node
/** Validate a current Manifest and its external ZIP payload without installing it. */
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {planComposition} from '@mote/plugin-host';

const repository = resolve(fileURLToPath(new URL('../', import.meta.url)));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
/** Central provides a service runtime for ingress/processing packages. Other
 * service ABIs still need a host that publishes them. */
export function releaseCompatibilityFailures(manifest) {
  if (manifest.runtime !== 'service') return [];
  const surfaces = new Set((manifest.contributions ?? []).map(contribution => contribution.surface));
  if (surfaces.has('ingress') || surfaces.has('processing')) return [];
  return [{code: 'unsupported_runtime', message: 'This host does not provide a service runtime for the declared contributions', remediation: 'Declare an ingress or processing contribution, publish as "runtime": "worker", or install on a host that provides the required service runtime'}];
}

export async function validatePackage({manifestPath, zipPath, host = 'central', hostDependencies = [], releaseContract}) {
  const release = releaseContract ?? await import(pathToFileURL(join(repository, 'apps/server/dist/plugin-release.js')).href);
  const manifest = release.pluginManifestSchema.parse(JSON.parse(await readFile(resolve(manifestPath), 'utf8')));
  const archive = await readFile(resolve(zipPath));
  const digest = hash(archive);
  const failures = releaseCompatibilityFailures(manifest);
  if (digest !== manifest.archive.sha256) failures.push({code: 'digest_mismatch', expected: manifest.archive.sha256, actual: digest});
  let entries = [];
  try { entries = Object.keys(release.validatePluginArchive(archive, manifest)); }
  catch (error) { failures.push({code: 'archive_invalid', message: error.message}); }
  const plan = planComposition({revision: 1, host, packages: [manifest], hostDependencies});
  if (!plan.ok) failures.push(...plan.failures.map(failure => ({...failure})));
  return {ok: failures.length === 0, manifest, digest, entries, plan: plan.ok ? plan.plan : null, failures};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const {parseArgs} = await import('node:util');
  const {values} = parseArgs({args: process.argv.slice(2), options: {
    manifest: {type: 'string'}, zip: {type: 'string'}, host: {type: 'string', default: 'central'},
    'host-dependencies': {type: 'string'}, help: {type: 'boolean', short: 'h'},
  }});
  if (values.help || !values.manifest || !values.zip) {
    console.info('Usage: node scripts/plugin-validate.mjs --manifest FILE --zip FILE [--host central] [--host-dependencies JSON]');
    process.exit(values.help ? 0 : 1);
  }
  try {
    const result = await validatePackage({manifestPath: values.manifest, zipPath: values.zip, host: values.host, hostDependencies: values['host-dependencies'] ? JSON.parse(values['host-dependencies']) : []});
    console.info(JSON.stringify(result));
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    console.error(JSON.stringify({ok: false, error: error.message}));
    process.exitCode = 1;
  }
}
