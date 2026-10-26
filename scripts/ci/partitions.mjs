// Behavioral inventories, not test-size heuristics. Product assertions and fixture
// inputs live unchanged in the candidate revision; only execution cadence changes.
export const largeMemoryCase = 'three actual Memory jobs prepare large context grants through the bridge without losing their execution lease';
export const manualCases = [
  { suite: 'benchmark', scope: 'guards', file: 'apps/server/test/context-query.test.ts', name: 'literal search remains bounded on generated archive data', fileTimeout: 120000 },
  { suite: 'benchmark', scope: 'guards', file: 'apps/server/test/materials.test.ts', name: 'revalidating a rebuilt long transcript remains bounded with invalidated historical anchors', fileTimeout: 120000 },
  { suite: 'scale', scope: 'memory', file: 'apps/server/test/persona-memory.test.ts', name: '45-day generated Persona preserves late authorship, closes every bounded batch and deduplicates replay', fileTimeout: 120000 },
  { suite: 'scale', scope: 'memory', file: 'apps/server/test/memory-read-batch.test.ts', name: largeMemoryCase, fileTimeout: 300000 },
  { suite: 'scale', scope: 'memory', file: 'apps/server/test/memory-pipeline.test.ts', name: '400 generated days imported individually and in batches share one durable memory executor', fileTimeout: 300000 },
  { suite: 'scale', scope: 'memory', file: 'apps/server/test/memory-delegation.test.ts', name: 'a thousand generated originals drain bounded catalogs with complete independently reviewed coverage', fileTimeout: 300000 },
  { suite: 'scale', scope: 'memory', file: 'apps/server/test/memory-import-background.test.ts', name: 'HTTP import of a thousand generated originals rolls through bounded background packages without planning', fileTimeout: 900000 },
  { suite: 'scale', scope: 'intake', file: 'apps/server/test/imports.test.ts', name: '400 generated ZIP files recover an interrupted staging batch with stable original and child identities', fileTimeout: 120000 },
  { suite: 'scale', scope: 'admission', file: 'apps/server/test/request-admission.test.ts', name: 'more than 1000 pending queries are accepted through the API while execution stays within configured concurrency', fileTimeout: 180000 },
  { suite: 'recovery', scope: 'shutdown', file: 'apps/server/test/shutdown-execution.test.ts', name: 'app.close preserves 180 model waits, queues, retry deadlines and explicit cancellation; restart resumes eligible files', fileTimeout: 300000 },
];
export const manualFiles = [
  { suite: 'scale', scope: 'query', file: 'apps/server/test/query-large-lineage-http.test.ts', fileTimeout: 120000 },
];
// A single-case file has no automatic cases. Mixed files retain all short cases.
export const scaleFiles = ['apps/server/test/query-large-lineage-http.test.ts', 'apps/server/test/memory-import-background.test.ts', 'apps/server/test/persona-memory.test.ts'];
export const escapePattern = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const automaticSkipPattern = `^(?:${manualCases.map(item => escapePattern(item.name)).join('|')})$`;
