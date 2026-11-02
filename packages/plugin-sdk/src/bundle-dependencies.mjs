import {cpSync, mkdirSync, rmSync} from 'node:fs';
import {join} from 'node:path';

// npm hoists workspace dependencies outside this package. bundleDependencies
// alone therefore packs zero entries; this prepack step materializes only the
// public runtime dist and manifest of the two private workspace packages.
const packageRoot = join(import.meta.dirname, '..');
const destination = join(packageRoot, 'node_modules', '@mote');
rmSync(destination, {recursive: true, force: true});
mkdirSync(destination, {recursive: true});
for (const name of ['plugin-api', 'plugin-host']) {
  const source = join(packageRoot, '..', name), target = join(destination, name);
  mkdirSync(target, {recursive: true});
  cpSync(join(source, 'package.json'), join(target, 'package.json'));
  cpSync(join(source, 'dist'), join(target, 'dist'), {recursive: true});
}
