import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { scaleFiles } from './partitions.mjs';
export { scaleFiles } from './partitions.mjs';
export const listServerTests = (root = '.') => readdirSync(resolve(root, 'apps/server/test')).filter(name => name.endsWith('.test.ts')).sort().map(name => `apps/server/test/${name}`);
// A short, explicit module map. Central composition/storage/authority owners and unknown
// modules deliberately fall back to the whole light server suite; no inferred dependency engine.
const groups = {
  memory: /^(?:memory-|opening-memory|personal-memory|persona-memory|daily-event-memory|automatic-activity|owner-question|owner-questions|insight)/,
  intake: /^(?:source|file|archive|archived|capture|coding|ingress|ingest|import|recording|media|audio|notes|content-storage)/,
  execution: /^(?:execution-|operation|processing-|processor-|provider-admission|request-admission|task-execution|shutdown-execution)/,
  query: /^(?:query-|context-|scoped-query|citation|conversation|agent-view|indexer|vector|semantic-context)/,
  settings: /^(?:model-|connection|connector|plugin-|runtime-|update|notification|managed-calendar|calendar|feature-pack)/,
};
const foundational = /^(?:app|index|store|sqlite-database|materials|material-evidence|evidence-reader|memory|memory-pipeline|execution-engine|processing-runtime|provider-admission|file-processing|memory-strategies|sources|files|config|auth|authorization)\.[^.]+$/;
export function serverGroups(paths) {
  const selected = new Set();
  for (const path of paths.filter(path => path.startsWith('apps/server/'))) {
    if (/^apps\/server\/test\/[^/]+\.test\.ts$/.test(path)) { selected.add(`file:${path}`); continue; }
    const source = /^apps\/server\/src\/([^/]+)$/.exec(path);
    const nestedConnector = path.startsWith('apps/server/src/connectors/');
    if (!source && !nestedConnector) return ['all'];
    const name = source?.[1] ?? 'connector';
    if (foundational.test(name) || /authorization|authority|permissions?/.test(name)) return ['all'];
    const matches = Object.entries(groups).filter(([, pattern]) => pattern.test(name)).map(([group]) => group);
    if (!matches.length) return ['all'];
    matches.forEach(group => selected.add(group));
  }
  return [...selected].sort();
}
export function selectedServerFiles(selected = ['all'], root = '.') {
  if (!Array.isArray(selected) || !selected.length || selected.some(name => typeof name !== 'string')) throw Error('Invalid server group selection');
  const actual = listServerTests(root);
  if (!actual.length) throw Error('Server test inventory is empty');
  for (const group of selected) if (group !== 'all' && !groups[group] && !(group.startsWith('file:') && /^apps\/server\/test\/[^/]+\.test\.ts$/.test(group.slice(5)))) throw Error(`Unknown server group: ${group}`);
  // Deleting/renaming a test still checks real remaining consumers conservatively.
  if (selected.some(group => group.startsWith('file:') && !actual.includes(group.slice(5)))) selected = ['all'];
  return actual.filter(file => !scaleFiles.includes(file)).filter(file => selected.includes('all')
    || selected.includes(`file:${file}`) || selected.some(group => groups[group]?.test(file.split('/').at(-1)))
    || ['apps/server/test/connections.test.ts', 'apps/server/test/runtime-listener.test.ts'].includes(file));
}
export function serverFiles(shard, root = '.', selected = ['all']) {
  if (!Number.isInteger(shard) || shard < 1 || shard > 4) throw Error('Server shard must be 1..4');
  // Shard identity is stable against selection changes; each file has exactly one owner.
  const actual = listServerTests(root).filter(file => !scaleFiles.includes(file));
  const wanted = new Set(selectedServerFiles(selected, root));
  return actual.filter((file, index) => wanted.has(file) && index % 4 === shard - 1);
}
