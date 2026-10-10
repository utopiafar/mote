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
    if (path.startsWith('docs/') || path.startsWith('release/notes/') || /^(?:README(?:\.[\w-]+)?|AGENTS|THIRD_PARTY_NOTICES)\.md$/.test(path)
      || ['protocol/README.md', 'adapters/ui/README.md', 'plugins/source-packs/memex-markdown/README.md'].includes(path)) continue;
    if (path.startsWith('protocol/')) { mark(groups); result.protocol = true; continue; }
    const workflow = /^\.github\/workflows\/release-(central|desktop|android)\.yml$/.exec(path);
    if (workflow) { mark([workflow[1]]); result.tooling = true; continue; }
    if (/^scripts\/release\/(?:affected-components|check-affected)(?:\.test)?\.mjs$/.test(path)) {
      result.tooling = true; continue;
    }
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

/** Local checks include all working changes; CI's explicit head checks only committed inputs. */
export function changedPaths({ base = 'origin/main', head, directory = '.', workingTree = head === undefined } = {}) {
  const git = args => execFileSync('git', args, { cwd: directory, encoding: 'utf8' });
  const revision = ref => git(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]).trim();
  const target = revision(head ?? 'HEAD');
  const ancestor = git(['merge-base', revision(base), target]).trim();
  const paths = git(['diff', '--no-renames', '--name-only', '-z', ancestor, target, '--']).split('\0');
  if (workingTree) {
    paths.push(...git(['diff', '--cached', '--no-renames', '--name-only', '-z', 'HEAD', '--']).split('\0'));
    paths.push(...git(['diff', '--no-renames', '--name-only', '-z', '--']).split('\0'));
    paths.push(...git(['ls-files', '--others', '--exclude-standard', '-z']).split('\0'));
  }
  return [...new Set(paths.filter(Boolean))];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const option = name => args[args.indexOf(name) + 1];
  let result;
  const base = args.includes('--base') ? option('--base') : 'origin/main';
  if (args.includes('--all') || /^0{40}$/.test(base)) result = Object.fromEntries(Object.keys(affectedComponents([])).map(key => [key, true]));
  else {
    const paths = changedPaths({ base, head: args.includes('--head') ? option('--head') : undefined });
    result = affectedComponents(paths);
  }
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(result).map(([key, value]) => `${key}=${value}\n`).join(''));
  console.log(JSON.stringify(result));
}
