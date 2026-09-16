#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

// Check manifests without importing packages: workspace builds have not run yet,
// and types-only packages or packages with restricted exports have no entry point.
const manifestPath = resolve(process.argv[2] ?? 'package.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const require = createRequire(manifestPath);
const dependencies = { ...manifest.dependencies, ...manifest.devDependencies };
const missing = Object.keys(dependencies).filter(name =>
  !require.resolve.paths(name)?.some(directory => existsSync(join(directory, name, 'package.json'))),
);

if (missing.length) {
  console.error(`Mote: Missing dependencies for ${manifest.name}: ${missing.join(', ')}.`);
  console.error('Run npm ci from the repository root, then retry the dev command. Pulling code and building workspace libraries do not install new dependencies.');
  process.exitCode = 1;
}
