import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
export function verifyGate(needs) {
  if (needs.affected?.result !== 'success') throw Error('Affected selection did not succeed');
  for (const [job, output] of [['regressions', 'node'], ['android', 'android']]) {
    const selected = needs.affected.outputs?.[output];
    if (!['true', 'false'].includes(selected)) throw Error(`Missing/invalid selection output: ${output}`);
    const expected = selected === 'true' ? 'success' : 'skipped';
    if (needs[job]?.result !== expected) throw Error(`${job}: expected ${expected}, got ${needs[job]?.result}`);
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { verifyGate(JSON.parse(process.env.CHECK_NEEDS)); console.log('All selected light checks passed; unselected checks were skipped.'); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
