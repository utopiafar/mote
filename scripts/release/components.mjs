import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const releaseComponents = ['central', 'desktop', 'android'];
const versionPattern = /^(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
export function validVersion(version) {
  const match = typeof version === 'string' && version.length <= 80 && versionPattern.exec(version);
  return Boolean(match && (!match[4] || match[4].split('.').every(part => !/^\d+$/.test(part) || part === '0' || !part.startsWith('0'))));
}
export function compareVersions(a, b) {
  if (!validVersion(a) || !validVersion(b)) throw Error('Invalid release version');
  const [baseA, preA] = a.split(/-(.*)/s), [baseB, preB] = b.split(/-(.*)/s);
  const partsA = baseA.split('.').map(Number), partsB = baseB.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (partsA[i] !== partsB[i]) return Math.sign(partsA[i] - partsB[i]);
  if (preA === preB) return 0;
  if (preA === undefined || preB === undefined) return preA === undefined ? 1 : -1;
  const aIds = preA.split('.'), bIds = preB.split('.');
  for (let i = 0; i < Math.max(aIds.length, bIds.length); i++) {
    if (aIds[i] === undefined || bIds[i] === undefined) return aIds[i] === undefined ? -1 : 1;
    if (aIds[i] === bIds[i]) continue;
    const aNumeric = /^\d+$/.test(aIds[i]), bNumeric = /^\d+$/.test(bIds[i]);
    if (aNumeric && bNumeric) return aIds[i].length === bIds[i].length ? (aIds[i] > bIds[i] ? 1 : -1) : Math.sign(aIds[i].length - bIds[i].length);
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    return aIds[i] > bIds[i] ? 1 : -1;
  }
  return 0;
}
export function loadComponent(component, root = process.cwd()) {
  if (!releaseComponents.includes(component)) throw Error('Choose release component: central, desktop or android');
  const config = readJson(join(root, 'release/components.json'))[component];
  if (!config) throw Error(`Missing ${component} release configuration`);
  let version, versionCode;
  if (config.versionProperties) {
    const properties = readFileSync(join(root, config.versionProperties), 'utf8');
    version = /^versionName=(.*)$/m.exec(properties)?.[1]?.trim();
    versionCode = Number(/^versionCode=(\d+)$/m.exec(properties)?.[1]);
    if (!Number.isInteger(versionCode) || versionCode <= 0 || versionCode > 2_100_000_000) throw Error('Invalid Android versionCode');
  } else {
    const packages = config.packages.map(path => readJson(join(root, path)));
    version = packages[0]?.version;
    if (packages.some(pkg => pkg.version !== version)) throw Error(`${component} workspace release versions differ`);
  }
  if (!validVersion(version)) throw Error('Invalid release version');
  return { component, ...config, version, ...(versionCode === undefined ? {} : { versionCode }), tag: `${component}-v${version}`, notes: `release/notes/${component}/${version}.md` };
}
export function verifyComponent(component, { root = process.cwd(), ref, repository } = {}) {
  const release = loadComponent(component, root);
  const policy = readJson(join(root, 'release/signing-policy.json'));
  if (ref && ref !== `refs/tags/${release.tag}`) throw Error('Release workflow must run on its exact component version tag');
  if (repository && repository !== policy.repository) throw Error('Configure a distinct release identity for a fork before publishing');
  if (!readFileSync(join(root, release.notes), 'utf8').trim()) throw Error('Release notes must not be empty');
  if (release.packages) {
    const lock = readJson(join(root, 'package-lock.json'));
    for (const path of release.packages) if (lock.packages[path.replace(/\/package.json$/, '')]?.version !== release.version) throw Error(`${component} package-lock version differs`);
  }
  return { ...release, repository: policy.repository, channel: release.version.includes('-') ? 'preview' : 'stable' };
}
export function bumpComponentVersion(component, target, root = process.cwd()) {
  const release = loadComponent(component, root);
  let version = target;
  if (['major', 'minor', 'patch'].includes(target)) {
    const parts = release.version.split('-')[0].split('.').map(Number), index = ['major', 'minor', 'patch'].indexOf(target);
    parts[index]++; for (let i = index + 1; i < parts.length; i++) parts[i] = 0;
    version = parts.join('.');
  }
  if (!validVersion(version) || compareVersions(version, release.version) <= 0) throw Error('New component version must be a valid version newer than its current version');
  const writes = [];
  if (release.versionProperties) {
    if (release.versionCode === 2_100_000_000) throw Error('Android versionCode limit reached');
    writes.push([join(root, release.versionProperties), `versionName=${version}\nversionCode=${release.versionCode + 1}\n`]);
  } else {
    const lock = readJson(join(root, 'package-lock.json'));
    for (const path of release.packages) {
      const pkg = readJson(join(root, path)), key = path.replace(/\/package.json$/, '');
      if (!lock.packages[key]) throw Error(`Missing lockfile workspace: ${key}`);
      pkg.version = version; lock.packages[key].version = version;
      writes.push([join(root, path), JSON.stringify(pkg, null, 2) + '\n']);
    }
    writes.push([join(root, 'package-lock.json'), JSON.stringify(lock, null, 2) + '\n']);
  }
  for (const [path, contents] of writes) writeFileSync(path, contents);
  return loadComponent(component, root);
}
