import { appendFileSync, readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const groups = ['central', 'desktop', 'android'];
const roots = { central: ['@mote/server', '@mote/web'], desktop: ['@mote/desktop'], android: [] };

export function workspaceGraph(directory = '.') {
  return ['apps', 'packages'].flatMap(parent => readdirSync(resolve(directory, parent), { withFileTypes: true })
    .filter(entry => entry.isDirectory()).flatMap(entry => {
      const path = `${parent}/${entry.name}`;
      try {
        const pkg = JSON.parse(readFileSync(resolve(directory, path, 'package.json'), 'utf8'));
        return [{ path, name: pkg.name, dependencies: Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies, ...pkg.devDependencies }) }];
      } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    }));
}

/** Build inputs and npm dependency edges determine checks; this never chooses releases. */
export function affectedComponents(paths, graph = workspaceGraph()) {
  const result = { central: false, desktop: false, android: false, protocol: false, tooling: false };
  const mark = selected => selected.forEach(group => { result[group] = true; });
  const byName = new Map(graph.map(workspace => [workspace.name, workspace]));
  function uses(name, dependency, seen = new Set()) {
    if (name === dependency) return true;
    if (seen.has(name)) return false;
    seen.add(name);
    return (byName.get(name)?.dependencies ?? []).some(child => uses(child, dependency, seen));
  }
  for (const path of paths) {
    if (path.startsWith('docs/') || path.startsWith('release/notes/') || /^(?:README|THIRD_PARTY_NOTICES)\.md$/.test(path)) continue;
    if (path.startsWith('protocol/')) { mark(groups); result.protocol = true; continue; }
    if (path.startsWith('scripts/release/') || path.startsWith('.github/workflows/')) {
      mark(groups); result.tooling = true; continue;
    }
    if (path.startsWith('apps/android/')) { mark(['android']); continue; }
    const workspace = graph.find(entry => path.startsWith(entry.path + '/'));
    if (workspace) {
      mark(groups.filter(group => roots[group].some(root => uses(root, workspace.name))));
      // Kotlin consumes the shared cross-platform contracts and translation catalog.
      if (workspace.name === '@mote/shared') { mark(['android']); result.protocol = true; }
      continue;
    }
    if (path.startsWith('plugins/') || path.startsWith('deploy/') || path.startsWith('Dockerfile') || path.startsWith('compose.')) { mark(['central']); continue; }
    if (path.startsWith('adapters/') || path.startsWith('licenses/')) { mark(['desktop', 'android']); continue; }
    if (path.startsWith('models/') || path.startsWith('vendor/')) { mark(groups); continue; }
    // Root tooling/configuration and unknown inputs conservatively check every consumer.
    mark(groups);
    result.tooling = true;
  }
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const option = name => args[args.indexOf(name) + 1];
  let result;
  const base = args.includes('--base') ? option('--base') : 'origin/main';
  if (args.includes('--all') || /^0{40}$/.test(base)) result = Object.fromEntries(Object.keys(affectedComponents([])).map(key => [key, true]));
  else {
    const revision = ref => execFileSync('git', ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`], { encoding: 'utf8' }).trim();
    const head = revision(args.includes('--head') ? option('--head') : 'HEAD');
    const ancestor = execFileSync('git', ['merge-base', revision(base), head], { encoding: 'utf8' }).trim();
    const paths = execFileSync('git', ['diff', '--name-only', '-z', ancestor, head, '--'], { encoding: 'utf8' }).split('\0').filter(Boolean);
    result = affectedComponents(paths);
  }
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(result).map(([key, value]) => `${key}=${value}\n`).join(''));
  console.log(JSON.stringify(result));
}
