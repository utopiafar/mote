import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { affectedComponents, changedPaths } from './affected-components.mjs';

export function checkPlan(affected, releaseTests) {
  const npm = name => ({ command: 'npm', args: ['run', name] });
  const plan = [];
  const all = affected.central && affected.desktop && affected.android;
  if (all) plan.push(npm('check:local'));
  else {
    if (affected.central || affected.desktop || affected.android) plan.push(npm('check:i18n'));
    if (affected.central) plan.push(npm('check:central'));
    if (affected.desktop) plan.push(npm('check:desktop'));
    // Component commands already run release-tool tests. Android/tooling-only changes need them too.
    if (!affected.central && !affected.desktop && (affected.android || affected.tooling)) {
      plan.push({ command: process.execPath, args: ['--test', ...releaseTests] });
    }
  }
  if (affected.android) plan.push({
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
    const args = process.argv.slice(2);
    const options = {};
    for (let i = 0; i < args.length; i++) {
      if (['--base', '--head'].includes(args[i]) && args[i + 1] && !args[i + 1].startsWith('--')) {
        options[args[i].slice(2)] = args[++i];
      } else if (!['--all', '--dry-run'].includes(args[i])) throw Error(`Invalid argument: ${args[i]}`);
    }
    const affected = args.includes('--all')
      ? { central: true, desktop: true, android: true, protocol: true, tooling: true }
      : affectedComponents(changedPaths(options));
    const tests = readdirSync('scripts/release').filter(file => file.endsWith('.test.mjs')).sort()
      .map(file => `scripts/release/${file}`);
    const plan = checkPlan(affected, tests);
    console.log(JSON.stringify({ affected, checks: plan }, null, 2));
    if (!plan.length) console.log('Documentation-only or no changed inputs: review formatting, grammar, links and rendering.');
    if (!args.includes('--dry-run')) process.exitCode = runChecks(plan);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
