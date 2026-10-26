import test from 'node:test';
import assert from 'node:assert/strict';
import { successfulAncestor, allBase } from './main-base.mjs';
const head = 'f'.repeat(40), old = 'a'.repeat(40), failed = 'b'.repeat(40);
const run = (sha, conclusion = 'success', extra = {}) => ({ id: 123, head_sha: sha, event: 'push', head_branch: 'main', conclusion, ...extra });
const input = { repository: 'generated/fixture', head, token: 'generated-only', isAncestor: sha => [old, failed].includes(sha) };
test('main carries failed, interrupted and concurrent uncompleted ranges since its last successful ancestor', async () => {
  const result = await successfulAncestor({ ...input, fetchRuns: async () => [run('d'.repeat(40)), run(failed, 'failure'), run(failed, 'cancelled'), run(failed, null), run(old)] });
  assert.equal(result.base, old);
  assert.notEqual(result.base, failed);
});
test('non-main or non-push success cannot erase a main range and unavailable history selects every light scope', async () => {
  for (const fetchRuns of [async () => [], async () => { throw Error('fixture unavailable'); }, async () => [run(old, 'success', { event: 'pull_request' }), run(old, 'success', { head_branch: 'feature' })]]) {
    const result = await successfulAncestor({ ...input, fetchRuns }); assert.equal(result.base, allBase); assert.match(result.reason, /fallback/);
  }
});
test('history pagination can find an older reliable successful ancestor', async () => {
  const pages = [];
  const result = await successfulAncestor({ ...input, fetchRuns: async page => { pages.push(page); return page === 1 ? Array.from({ length: 100 }, () => run('d'.repeat(40))) : [run(old)]; } });
  assert.deepEqual(pages, [1, 2]); assert.equal(result.base, old);
});
