import { bumpComponentVersion } from './components.mjs';
const [component, target, ...extra] = process.argv.slice(2);
if (!target || extra.length) throw Error('Usage: npm run release:version -- <central|desktop|android> <patch|minor|major|X.Y.Z>');
const release = bumpComponentVersion(component, target);
console.log(JSON.stringify({ component, version: release.version, ...(release.versionCode ? { versionCode: release.versionCode } : {}), tag: release.tag, notes: release.notes }));
