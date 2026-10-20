import {createHash} from 'node:crypto';
import {readFile, lstat, realpath} from 'node:fs/promises';
import {resolve, dirname, relative, isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const catalogPath = resolve(projectRoot, 'docs/validation/dsh-compatibility/samples.v1.json');
export const gitBlob = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const stages = () => ({installation: 'not_run', nativeLoading: 'not_run', toolInvocation: 'not_run', moteJourney: 'not_run'});

export function validateCatalog(value) {
  if (!value || value.schemaVersion !== 1 || !sha(value.moteCommit) || !sha(value.lockfileGitBlob)) throw Error('Invalid catalog identity');
  if (!Array.isArray(value.samples) || value.samples.length === 0) throw Error('Empty compatibility sample set');
  const ids = new Set();
  for (const sample of value.samples) {
    if (!sample || typeof sample.id !== 'string' || !sample.id || ids.has(sample.id)) throw Error('Invalid or duplicate sample identity');
    ids.add(sample.id);
    if (!['upstream', 'community'].includes(sample.origin) || !['target', 'boundary'].includes(sample.track)) throw Error('Invalid sample classification');
    if (typeof sample.package !== 'string' || !sample.package || typeof sample.scenario !== 'string' || !sample.scenario) throw Error('Missing sample description');
    const source = sample.source;
    if (source?.type === 'npm-lock') {
      if (source.version !== value.dshVersion || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(source.integrity || '')) throw Error('Invalid npm pin');
      const url = new URL(source.resolved);
      if (url.protocol !== 'https:' || url.hostname !== 'registry.npmjs.org' || url.username || url.password || url.hash) throw Error('Invalid npm archive source');
    } else if (source?.type === 'git') {
      if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(source.repository || '') || !sha(source.commit) || !sha(source.manifestGitBlob)) throw Error('Invalid Git pin');
      if (!source.files || !Object.hasOwn(source.files, 'package.json') || source.files['package.json'] !== source.manifestGitBlob) throw Error('Missing manifest pin');
      for (const [path, hash] of Object.entries(source.files)) {
        if (isAbsolute(path) || path.split(/[\\/]/).some(part => !part || part === '.' || part === '..') || path.includes('\\') || !sha(hash)) throw Error('Invalid pinned file');
      }
    } else throw Error('Unknown sample source');
  }
  return value;
}

export async function readCatalog(path = catalogPath) {
  return validateCatalog(JSON.parse(await readFile(path, 'utf8')));
}

// Lock metadata is a reproducibility input, not proof that archive bytes were fetched.
export function auditLock(catalog, bytes) {
  validateCatalog(catalog);
  if (gitBlob(bytes) !== catalog.lockfileGitBlob) throw Error('Frozen lockfile changed; create a new catalog revision');
  const lock = JSON.parse(bytes.toString('utf8'));
  if (lock.packages?.['node_modules/@deepseek-ai/dsh']?.version !== catalog.dshVersion) throw Error('Harness version does not match catalog');
  const samples = catalog.samples.map(sample => {
    if (sample.source.type === 'npm-lock') {
      const entry = lock.packages?.[`node_modules/${sample.package}`];
      if (!entry || ['version', 'resolved', 'integrity'].some(key => entry[key] !== sample.source[key])) throw Error(`Lock pin mismatch: ${sample.id}`);
      return {id: sample.id, origin: sample.origin, category: sample.category, track: sample.track,
        source: sample.source, metadata: 'lock_matched', archiveBytesVerified: false,
        peerDependencies: entry.peerDependencies || {}, stages: stages()};
    }
    return {id: sample.id, origin: sample.origin, category: sample.category, track: sample.track,
      source: sample.source, metadata: 'github_manifest_reviewed', archiveBytesVerified: false, stages: stages()};
  });
  return {schemaVersion: 1, kind: 'source-metadata-audit', moteCommit: catalog.moteCommit,
    dshVersion: catalog.dshVersion, lockfileGitBlob: catalog.lockfileGitBlob, samples,
    summary: {samples: samples.length, runtimeExecuted: 0, compatibilityRate: null}};
}

export async function verifySourceFiles(directory, sample) {
  if (sample.source.type !== 'git') throw Error('Expected a Git sample');
  const root = await realpath(directory);
  const verified = {};
  for (const [name, expected] of Object.entries(sample.source.files)) {
    const path = resolve(root, name);
    const rel = relative(root, path);
    if (rel.startsWith('..') || isAbsolute(rel)) throw Error('Source path escapes sample');
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || await realpath(path) !== path) throw Error('Source must be a regular non-symlink file');
    const hash = gitBlob(await readFile(path));
    if (hash !== expected) throw Error(`Source byte mismatch: ${sample.id}/${name}`);
    verified[name] = hash;
  }
  return verified;
}

export function environmentProblems(version, resolvePackage) {
  const problems = [];
  if (!/^v?\d+\./.test(version) || Number(version.replace(/^v/, '').split('.')[0]) < 24) problems.push('node_24_required');
  for (const name of ['@deepseek-ai/dsh-sdk-client', '@deepseek-ai/dsh', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-llm-pi-ai']) {
    try { resolvePackage(name); } catch { problems.push(`dependency_missing:${name}`); }
  }
  return problems;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length && (args.length !== 2 || args[0] !== '--lockfile')) throw Error('Usage: node scripts/dsh-compatibility/audit.mjs [--lockfile PATH]');
    const catalog = await readCatalog();
    const report = auditLock(catalog, await readFile(args[1] || resolve(projectRoot, 'package-lock.json')));
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    console.error(JSON.stringify({status: 'failed', error: error.message}));
    process.exitCode = 1;
  }
}
