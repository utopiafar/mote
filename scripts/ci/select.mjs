import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serverGroups, serverFiles } from './server-tests.mjs';
import { changedPaths } from '../release/affected-components.mjs';

// Check scopes are independent of release/components.json and its central artifact.
export const scopes = ['web', 'server', 'agent', 'shared', 'i18n', 'desktop', 'android', 'tooling'];
const documentation = path => path.startsWith('docs/') || path.startsWith('release/notes/')
  || /(?:^|\/)AGENTS\.md$/.test(path) || /^(?:README(?:\.[\w-]+)?|THIRD_PARTY_NOTICES)\.md$/.test(path)
  || /^\.agents\/skills\/.*\.(?:md|yaml)$/.test(path)
  || ['protocol/README.md', 'adapters/ui/README.md', 'plugins/source-packs/memex-markdown/README.md'].includes(path);

// Real file intake producers and the Kotlin consumer exercised by the light
// upload contract. Unrelated Server/Android modules keep their existing scopes.
const androidContractInputs = new Set([
  ...['app', 'auth', 'connections', 'source-routes', 'sources', 'source-schema', 'file-routes', 'files', 'file-schema', 'ingress',
    'store', 'evidence-store', 'sqlite-database', 'capture-schema', 'vault-schema', 'vault-schema-installation',
    'features/sources', 'features/files', 'features/connections'].map(name => `apps/server/src/${name}.ts`),
  ...['CentralClient', 'CentralUploadClient', 'CentralNotes', 'FileUploadConfirmation', 'IngressV2Protocol', 'LocalSources']
    .map(name => `apps/android/app/src/main/java/dev/mote/collector/${name}.kt`),
  'apps/android/app/src/test/java/dev/mote/collector/CentralProducerContractTest.kt',
  'apps/android/test-fixtures/central-kotlin-contract.ts',
  ...['app/build.gradle.kts', 'build.gradle.kts', 'settings.gradle.kts', 'gradle.properties'].map(name => `apps/android/${name}`),
  ...['index', 'files', 'sources', 'collector-receipt', 'protocol', 'connection', 'http-failure'].map(name => `packages/shared/src/${name}.ts`),
  'packages/shared/package.json', 'protocol/contract.json',
  '.github/workflows/component-checks.yml', 'scripts/ci/select.mjs', 'scripts/ci/select.test.mjs',
  'scripts/ci/gate.mjs', 'scripts/ci/workflows.test.mjs', 'scripts/ci/suites.test.mjs',
  'scripts/release/check-affected.mjs', 'scripts/release/check-affected.test.mjs',
]);

export function selectScopes(paths) {
  const selected = new Set(), fallback = [];
  let broadServer = false, androidContract = false;
  const add = (...names) => names.forEach(name => selected.add(name));
  for (const path of paths) {
    if (documentation(path)) continue;
    if (androidContractInputs.has(path)) androidContract = true;
    if (path === 'scripts/test-web-login.cjs') { add('desktop', 'web', 'i18n'); continue; }
    if (/^packages\/shared\/(?:src\/i18n(?:-[a-z]{2})?\.ts|test\/i18n\.test\.mjs)$/.test(path)
      || /^apps\/android\/app\/src\/main\/assets\/i18n-[a-z]{2}\.json$/.test(path) || /^scripts\/(?:check|sync)-i18n\.mjs$/.test(path)) { add('i18n'); continue; }
    if (path.startsWith('apps/web/')) { add('web', 'i18n'); continue; }
    if (path.startsWith('apps/server/')) { add('server', 'i18n'); continue; }
    if (path.startsWith('packages/agent/')) { add('agent', 'server'); broadServer = true; continue; }
    if (path.startsWith('apps/desktop/')) { add('desktop', 'i18n'); continue; }
    if (path.startsWith('apps/android/')) { add('android', 'i18n'); continue; }
    if (path.startsWith('packages/diagnostics/')) { add('desktop', 'i18n'); continue; }
    // Public plugin API/host changes are consumed by Central. Keep the real
    // server surface (including its existing shards) and tooling checks, without
    // falling through to the all-light unknown-path fallback or Android contract.
    if (path.startsWith('packages/plugin-api/') || path.startsWith('packages/plugin-host/')) { add('server', 'tooling'); broadServer = true; continue; }
    // The SDK is an author-facing build surface, not a current app consumer.
    if (path.startsWith('packages/plugin-sdk/')) { add('tooling'); continue; }
    if (path.startsWith('packages/shared/') || path.startsWith('protocol/')) {
      add('shared', 'agent', 'server', 'web', 'desktop', 'android', 'i18n'); broadServer = true; continue;
    }
    if (path.startsWith('scripts/ci/') || /^scripts\/release\/(?:check-affected|affected-components)(?:\.test)?\.mjs$/.test(path)) { add('tooling'); continue; }
    if (path.startsWith('.github/workflows/') || path.startsWith('scripts/release/') || path.startsWith('release/')) { add('tooling'); continue; }
    if (path.startsWith('plugins/') || path.startsWith('deploy/') || path.startsWith('Dockerfile') || path.startsWith('compose.')) { add('server', 'tooling'); broadServer = true; continue; }
    if (path.startsWith('adapters/') || path.startsWith('licenses/')) { add('desktop', 'android'); continue; }
    // Unknown code, root config and lock changes run every LIGHT scope, never a heavy suite.
    add(...scopes); broadServer = true; androidContract = true; fallback.push(path);
  }
  return { scopes: scopes.filter(name => selected.has(name)), fallback, ...(selected.has('server') ? { serverGroups: broadServer ? ['all'] : serverGroups(paths) } : {}), ...(androidContract ? { androidContract: true } : {}) };
}

export function automaticTasks(selection, event = 'pull_request') {
  if (!['pull_request', 'push', 'local'].includes(event)) throw Error(`Unsupported automatic event: ${event}`);
  const selected = new Set(selection.scopes), tasks = [];
  // One source-boundary check before the affected Node tasks; no builds or heavy suites.
  if ([...selected].some(name => name !== 'android')) tasks.push('architecture');
  for (const name of ['tooling', 'i18n', 'shared']) if (selected.has(name)) tasks.push(name);
  for (const name of ['web', 'agent', 'desktop']) if (selected.has(name)) tasks.push(event === 'push' ? `${name}-contract` : name);
  if (selected.has('server')) tasks.push(...(event === 'push' ? ['server-contract'] : ['server-build', ...[1, 2, 3, 4].filter(shard => serverFiles(shard, '.', selection.serverGroups).length).map(shard => `server-${shard}`)]));
  // Main retains focused Kotlin consumption when its actual wire inputs change;
  // the full Android JVM suite remains a PR/local check.
  if (event === 'push' && selected.has('android') && !tasks.includes('shared')) tasks.push('shared');
  return { tasks, android: event !== 'push' && selected.has('android'), ...(selection.androidContract ? { androidContract: true } : {}) };
}

export function parseOptions(args, allowed = []) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const name = args[i];
    if (['--all', '--dry-run'].includes(name)) options[name.slice(2)] = true;
    else if (['--base', '--head', ...allowed].includes(name) && args[i + 1] && !args[i + 1].startsWith('--')) options[name.slice(2)] = args[++i];
    else throw Error(`Invalid argument: ${name}`);
  }
  return options;
}

export function selectionFromOptions(options) {
  if (options.all || /^0{40}$/.test(options.base ?? '')) return { scopes: [...scopes], fallback: ['all light scopes requested'], serverGroups: ['all'], androidContract: true };
  // Invalid revisions/diff errors throw: a failed selector is never an empty green plan.
  return selectScopes(changedPaths(options));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseOptions(process.argv.slice(2), ['--event']);
    const selection = selectionFromOptions(options), plan = automaticTasks(selection, options.event);
    const outputs = { matrix: JSON.stringify({ task: plan.tasks.length ? plan.tasks : ['none'] }), node: String(plan.tasks.length > 0), android: String(plan.android), android_contract: String(Boolean(plan.androidContract)), server_groups: JSON.stringify(selection.serverGroups ?? ['all']) };
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(outputs).map(([key, value]) => `${key}=${value}\n`).join(''));
    console.log(JSON.stringify({ ...selection, ...plan }, null, 2));
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Affected light checks\n\n\`\`\`json\n${JSON.stringify({ ...selection, ...plan }, null, 2)}\n\`\`\`\n`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
