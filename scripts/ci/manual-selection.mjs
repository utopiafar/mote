import { appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// Keep this dependency-free: validate even before npm ci or any selected job starts.
export const specialistScopes = {
  scale: ['memory', 'query', 'intake', 'admission'], recovery: ['replay', 'process', 'arrivals', 'shutdown'],
  benchmark: ['architecture', 'directory', 'sync', 'harness', 'file-commit', 'review-retrieval', 'guards'],
};
export function validateManual({ suite, scope = 'all', revision = '', actual }) {
  if (!['integration', 'docker', 'all', ...Object.keys(specialistScopes)].includes(suite)) throw Error(`Invalid manual suite: ${suite}`);
  if (scope !== 'all' && !specialistScopes[suite]?.includes(scope)) throw Error(`Invalid manual suite/scope: ${suite}/${scope}`);
  if (revision && !/^[0-9a-f]{40}$/i.test(revision)) throw Error('revision must be a full commit SHA');
  if (!/^[0-9a-f]{40}$/.test(actual ?? '') || (revision && revision.toLowerCase() !== actual)) throw Error('Checked revision differs from requested SHA');
  return actual;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const revision = validateManual({ suite: process.env.CHECK_SUITE, scope: process.env.CHECK_SCOPE, revision: process.env.CHECK_REVISION, actual: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() });
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `revision=${revision}\n`);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `Manual validation: ${process.env.CHECK_SUITE}/${process.env.CHECK_SCOPE} at ${revision}\n`);
    console.log(revision);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
