import { appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { verifyComponent } from './components.mjs';
const [component, ...extra] = process.argv.slice(2);
if (extra.length) throw Error('Usage: node scripts/release/verify-version.mjs <central|desktop|android>');
const release = verifyComponent(component, { ref: process.env.GITHUB_REF, repository: process.env.GITHUB_REPOSITORY });
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `component=${component}\nversion=${release.version}\ntag=${release.tag}\ncommit=${commit}\nchannel=${release.channel}\n`);
console.log(JSON.stringify({ component, version: release.version, tag: release.tag, commit }));
