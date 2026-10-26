import { appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
export const allBase = '0'.repeat(40);
export async function successfulAncestor({ repository, head, token, fetchRuns, isAncestor }) {
  try {
    if (!repository || !/^[0-9a-f]{40}$/.test(head ?? '') || !token) throw Error('Missing main baseline inputs');
    for (let page = 1; page <= 10; page++) {
      const runs = await fetchRuns(page);
      for (const run of runs) {
        if (run.event === 'push' && run.head_branch === 'main' && run.conclusion === 'success'
          && /^[0-9a-f]{40}$/.test(run.head_sha) && isAncestor(run.head_sha, head)) return { base: run.head_sha, reason: `successful main run ${run.id}` };
      }
      if (runs.length < 100) break;
    }
    throw Error('No successful ancestor found');
  } catch (error) {
    return { base: allBase, reason: `Conservative all-light fallback: ${error.message}` };
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const repository = process.env.GITHUB_REPOSITORY, head = process.env.CHECK_HEAD, token = process.env.GITHUB_TOKEN;
  const result = await successfulAncestor({ repository, head, token,
    fetchRuns: async page => {
      const response = await fetch(`https://api.github.com/repos/${repository}/actions/workflows/component-checks.yml/runs?event=push&branch=main&status=success&per_page=100&page=${page}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }, signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw Error(`Workflow history HTTP ${response.status}`);
      const body = await response.json();
      if (!Array.isArray(body.workflow_runs)) throw Error('Invalid workflow history');
      return body.workflow_runs;
    },
    isAncestor: (base, target) => {
      try { execFileSync('git', ['merge-base', '--is-ancestor', base, target], { stdio: 'pipe' }); return true; }
      catch { return false; }
    },
  });
  console.log(JSON.stringify(result));
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `base=${result.base}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `Main cumulative baseline: ${result.base} (${result.reason}). Failed/interrupted ranges remain in scope until a successful descendant run.\n`);
}
