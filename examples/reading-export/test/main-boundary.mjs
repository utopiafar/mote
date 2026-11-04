/** [U] boundary checks for the external second-level example.
 *
 * The reading export domain lives only in `examples/reading-export`. Product
 * source, scripts and protocol packages must not grow a domain-specific branch
 * or import. Runtime files may import only the public SDK and local package
 * modules; they may not reach into the reading review package or carry a local
 * scheduling algorithm. */
import {readFileSync, readdirSync, statSync} from 'node:fs';
import {dirname, join, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const packageRoot = resolve(fileURLToPath(new URL('../', import.meta.url)));
const repository = resolve(packageRoot, '../..');
const roots = ['apps', 'packages', 'scripts', 'protocol', 'plugins'];
const skipped = new Set(['node_modules', 'dist', 'build', '.gradle', '.next', 'coverage', '.cache']);
const source = /\.(?:[cm]?[jt]sx?|kt|kts|json|ya?ml|md)$/;
const forbidden = /reading[-_ ]?export|readingexport|阅读导出/i;
const hits = [];
let scannedMain = 0;

function walk(directory) {
  for (const entry of readdirSync(directory, {withFileTypes: true})) {
    if (skipped.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (entry.isFile() && source.test(entry.name)) {
      const text = readFileSync(path, 'utf8');
      if (text.includes('\0')) continue;
      scannedMain++;
      if (forbidden.test(text)) hits.push(relative(repository, path));
    }
  }
}

for (const root of roots) {
  const path = join(repository, root);
  try { if (statSync(path).isDirectory()) walk(path); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

const runtimeFiles = ['plugin.mjs', 'domain.mjs', 'port.mjs', 'web/bridge.mjs'];
const importViolations = [];
const algorithmHits = [];
const algorithm = /\b(?:spaced|daily|intensive)\b|firstInterval|nextInterval|ratingFactor/;
for (const file of runtimeFiles) {
  const text = readFileSync(join(packageRoot, file), 'utf8');
  for (const match of text.matchAll(/(?:from\s+|import\s*\()\s*['"]([^'"]+)['"]/g)) {
    const specifier = match[1];
    if (specifier === '@mote/plugin-sdk') continue;
    if (specifier.startsWith('.')) {
      const target = resolve(dirname(join(packageRoot, file)), specifier);
      if (target.startsWith(packageRoot + '/')) continue;
    }
    importViolations.push({file, specifier});
  }
  if (algorithm.test(text)) algorithmHits.push(file);
}

const result = {
  status: hits.length || importViolations.length || algorithmHits.length ? 'failed' : 'passed',
  scannedMainFiles: scannedMain,
  mainDomainHits: hits,
  runtimeImportViolations: importViolations,
  localAlgorithmHits: algorithmHits,
};
console.log(JSON.stringify(result, null, 2));
if (result.status !== 'passed') process.exitCode = 1;
