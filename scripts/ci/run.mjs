import { appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { parseOptions } from './select.mjs';
import { taskPlan, manualPlan, verifyInventory } from './suites.mjs';
import { runChecks } from '../release/check-affected.mjs';
try {
  const options = parseOptions(process.argv.slice(2), ['--task', '--suite', '--scope']);
  if (Boolean(options.task) === Boolean(options.suite)) throw Error('Choose exactly one --task or --suite');
  if (options.task && options.scope) throw Error('--scope requires --suite');
  const inventory = verifyInventory();
  const checks = options.task ? taskPlan(options.task, '.', process.env.CHECK_SERVER_GROUPS ? JSON.parse(process.env.CHECK_SERVER_GROUPS) : undefined) : manualPlan(options.suite, options.scope);
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const report = JSON.stringify({ revision, runnerRevision: process.env.CHECK_RUNNER_REVISION ?? revision, task: options.task, suite: options.suite, scope: options.scope ?? 'all', inventory, checks }, null, 2);
  console.log(report);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Executed revision and selected commands\n\n\`\`\`json\n${report}\n\`\`\`\n`);
  if (!options['dry-run']) process.exitCode = runChecks(checks);
} catch (error) { console.error(error.message); process.exitCode = 1; }
