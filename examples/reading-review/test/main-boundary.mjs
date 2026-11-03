/** [U] main-source boundary check for the external example.
 *
 * The reading review domain lives only in `examples/reading-review`. Product
 * source, scripts and protocol packages must not grow a domain-specific branch
 * or import. This script is intentionally inside the example so the main tree
 * never needs to mention the domain to enforce the boundary. */
import {readFileSync, readdirSync, statSync} from 'node:fs';
import {join, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const repository = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const roots = ['apps', 'packages', 'scripts', 'protocol', 'plugins'];
const skipped = new Set(['node_modules', 'dist', 'build', '.gradle', '.next', 'coverage', '.cache']);
const source = /\.(?:[cm]?[jt]sx?|kt|kts|json|ya?ml|md)$/;
const forbidden = /reading[-_ ]?review|readingreview|阅读复习/i;
const hits = [];
let scanned = 0;

function walk(directory) {
  for (const entry of readdirSync(directory, {withFileTypes: true})) {
    if (skipped.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (entry.isFile() && source.test(entry.name)) {
      const text = readFileSync(path, 'utf8');
      if (text.includes('\0')) continue;
      scanned++;
      if (forbidden.test(text)) hits.push(relative(repository, path));
    }
  }
}

for (const root of roots) {
  const path = join(repository, root);
  try { if (statSync(path).isDirectory()) walk(path); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

const result = {status: hits.length ? 'failed' : 'passed', scannedFiles: scanned, domainHits: hits};
console.log(JSON.stringify(result, null, 2));
if (hits.length) process.exitCode = 1;
