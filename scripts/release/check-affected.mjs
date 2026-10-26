import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { automaticTasks, parseOptions, selectionFromOptions } from '../ci/select.mjs';
import { taskPlan } from '../ci/suites.mjs';

export function checkPlan(selection, { event = 'local', directory = '.' } = {}) {
  const automatic = automaticTasks(selection, event);
  const plan = automatic.tasks.flatMap(task => taskPlan(task, directory, selection.serverGroups));
  if (automatic.android) plan.push({
    command: 'apps/android/gradlew', args: ['-p', 'apps/android', '--no-daemon', ':app:testDebugUnitTest'],
  });
  return plan;
}

export function runChecks(plan) {
  for (const { command, args } of plan) {
    console.log(`\n> ${command} ${args.join(' ')}`);
    const result = spawnSync(command, args, { stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) return result.status ?? 1;
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseOptions(process.argv.slice(2));
    const affected = selectionFromOptions(options);
    const plan = checkPlan(affected);
    console.log(JSON.stringify({ affected, checks: plan }, null, 2));
    if (!plan.length) console.log('Documentation-only or no changed inputs: review formatting, grammar, links and rendering.');
    if (!options['dry-run']) process.exitCode = runChecks(plan);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
