#!/usr/bin/env node
/** Manual G4 real-model acceptance for the converged Agent runtimes.
 *
 * This runner is intentionally separate from the ordinary test glob and from
 * the fixture-only deep-extension matrix. It refuses to start without an
 * explicit runtime provider and execution budget, and it never substitutes a
 * provider or model. Every model call uses generated evidence in a temporary
 * in-memory reader; no personal archive, screenshots or credentials are read.
 *
 * The report is item based. Items this invocation did not exercise are marked
 * "未验证"/unverified instead of being reported as passed.
 */
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {mkdir, writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';

const repository = resolve(fileURLToPath(new URL('../', import.meta.url)));
const agentEntry = join(repository, 'packages/agent/dist/index.js');
const defaultReportDirectory = join(repository, '.mote', 'agent-runtime-live');
const PROTOCOLS = ['deepseek', 'openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai'];
const REASONING_EFFORTS = ['auto', 'off', 'low', 'high', 'max', 'minimal', 'medium', 'xhigh', 'ultra'];

/** The matrix is explicit so a short live run can never imply that every
 * planned runtime journey was executed. */
const items = [
  {
    id: 'query-evidence',
    title: 'real query reads generated evidence, calls a read-only tool and cites the original',
    default: true,
    runnable: true,
    run: runQueryEvidence,
  },
  {
    id: 'working-context',
    title: 'working-memory task compacts generated turns without archive retrieval',
    default: false,
    runnable: true,
    run: runWorkingContext,
  },
  {
    id: 'restart',
    title: 'a fresh Agent host/profile repeats the generated query in a second process',
    default: false,
    runnable: true,
    run: runRestart,
  },
  {
    id: 'budget-deadline',
    title: 'the explicit budget produces a typed deadline instead of an unbounded run',
    default: false,
    runnable: false,
    manual: 'Use packages/agent/test/active-budget.test.mjs for the deterministic contract and a separate live fault-injection run for provider timing.',
  },
  {
    id: 'cancel',
    title: 'cancellation closes the selected runtime without a successful late answer',
    default: false,
    runnable: false,
    manual: 'The existing fixture tests cover cancellation; a real-provider cancellation remains a separate manual journey.',
  },
  {
    id: 'image',
    title: 'generated image disclosure through read_image',
    default: false,
    runnable: false,
    manual: 'Use the existing generated image/runtime journeys; this short runner does not send an image.',
  },
  {
    id: 'import',
    title: 'Import workspace, preview and final manifest',
    default: false,
    runnable: false,
    manual: 'Use scripts/test-codex-provider-live.ts or the agent import host fixtures; this runner only exercises query.',
  },
  {
    id: 'host-delegation',
    title: 'Host delegation child loop and restart recovery',
    default: false,
    runnable: false,
    manual: 'Use the delegation fixture journeys or scripts/agent-extension-matrix.mjs; this runner does not request delegation.',
  },
];

const help = `Mote Agent runtime live acceptance (manual G4 selection)
  node scripts/agent-runtime-live-acceptance.mjs --provider <name> --model <id> --budget-ms <ms> [options]

Required:
  --provider <name>            Explicit provider. codex selects Codex App Server; dsh/deepseek
                               select DSH HTTP. Another named HTTP provider requires --protocol.
                               No default is used.
  --model <id>                 Exact real model ID from that provider's catalog.
  --budget-ms <ms>             Agent execution budget for every selected item (1000..3600000).
  --budget <ms>                Alias for --budget-ms; do not pass both with different values.

Options:
  --protocol <name>            DSH protocol; defaults to deepseek for dsh/deepseek. Required for other HTTP provider names.
                               Codex always uses codex-app-server.
  --reasoning <effort>         auto|off|low|high|max|minimal|medium|xhigh|ultra. Defaults to low for Codex and high for DSH.
  --service-tier <tier>        Codex only: default|fast. Defaults to default.
  --model-provider <name>      DSH model provider field; defaults to the selected provider name (deepseek for dsh).
  --base-url <url>             DSH model base URL. HTTPS, or loopback HTTP. Defaults to the protocol default.
  --api-key-env <name>         Environment variable for the DSH key. Defaults to MOTE_MODEL_API_KEY.
  --allow-unauthenticated-local Allow a loopback DSH model without a credential.
  --max-tokens <n>             DSH output budget; defaults to 8192.
  --max-tool-calls <n>         Bound the generated tool loop; defaults to 8.
  --only <id[,id]>             Select item(s). Repeatable. Defaults to query-evidence; "all" runs every runnable item.
  --list                       List the acceptance matrix without calling a model.
  --json                       Print the report as JSON instead of the human summary.
  --report <path>              Write the JSON report to this path.
  --help                       Show this help.

Without both --provider and --budget-ms the runner refuses to start. Items that
are not selected, or that this short runner does not implement, are reported as
"未验证"/unverified. Real-model results are not semantic-quality guarantees.`;

class UsageError extends Error {}

function failUsage(message) {
  throw new UsageError(message);
}

function normalizeProvider(value) {
  const raw = value.trim();
  const key = raw.toLowerCase();
  if (['codex', 'codex-app-server', 'mote.runtime.codex'].includes(key)) {
    return {runtime: 'codex', name: 'codex', protocolDefault: 'codex-app-server', modelProvider: 'codex'};
  }
  if (['dsh', 'mote.runtime.dsh'].includes(key)) {
    return {runtime: 'dsh', name: 'dsh', protocolDefault: 'deepseek', modelProvider: undefined};
  }
  if (key === 'deepseek') {
    return {runtime: 'dsh', name: 'deepseek', protocolDefault: 'deepseek', modelProvider: 'deepseek'};
  }
  // A named HTTP provider is allowed only with an explicit protocol; this
  // keeps provider/model selection explicit without silently guessing a route.
  if (/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(raw)) {
    return {runtime: 'dsh', name: raw, protocolDefault: undefined, modelProvider: raw};
  }
  return undefined;
}

function parseBudget(values) {
  const candidates = [values['budget-ms'], values.budget].filter(value => value !== undefined);
  if (!candidates.length) return undefined;
  if (new Set(candidates).size > 1) failUsage('Use only one of --budget-ms or --budget.');
  const raw = candidates[0];
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) failUsage('Budget must be an integer number of milliseconds.');
  const budget = Number(raw);
  if (!Number.isSafeInteger(budget) || budget < 1_000 || budget > 3_600_000) {
    failUsage('Budget must be between 1000 and 3600000 milliseconds.');
  }
  return budget;
}

function parseInteger(name, raw, minimum, maximum, fallback) {
  if (raw === undefined) return fallback;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) failUsage(`${name} must be an integer.`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    failUsage(`${name} must be between ${minimum} and ${maximum}.`);
  }
  return value;
}

function validateBaseUrl(raw) {
  if (raw === undefined) return undefined;
  let url;
  try { url = new URL(raw); }
  catch { failUsage('--base-url must be an absolute HTTP or HTTPS URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    failUsage('--base-url must be HTTP(S) without credentials, query or fragment.');
  }
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    failUsage('Remote model endpoints must use HTTPS; HTTP is allowed only on loopback.');
  }
  return raw.replace(/\/+$/, '');
}

function selectItems(values) {
  const requested = (values.only ?? []).flatMap(value => value.split(',')).map(value => value.trim()).filter(Boolean);
  if (!requested.length) return new Set(items.filter(item => item.default).map(item => item.id));
  if (requested.includes('all')) return new Set(items.filter(item => item.runnable).map(item => item.id));
  const unknown = requested.filter(id => !items.some(item => item.id === id));
  if (unknown.length) failUsage(`Unknown acceptance item(s): ${unknown.join(', ')}. Use --list to inspect the matrix.`);
  const unsupported = requested.filter(id => !items.find(item => item.id === id).runnable);
  if (unsupported.length) failUsage(`This runner does not implement: ${unsupported.join(', ')}. See docs/testing-agent-runtimes.md for the separate manual entries.`);
  return new Set(requested);
}

function parseOptions(argv) {
  return parseArgs({
    args: argv,
    strict: true,
    allowPositionals: false,
    options: {
      provider: {type: 'string'},
      model: {type: 'string'},
      'budget-ms': {type: 'string'},
      budget: {type: 'string'},
      protocol: {type: 'string'},
      reasoning: {type: 'string'},
      'service-tier': {type: 'string'},
      'model-provider': {type: 'string'},
      'base-url': {type: 'string'},
      'api-key-env': {type: 'string'},
      'allow-unauthenticated-local': {type: 'boolean'},
      'max-tokens': {type: 'string'},
      'max-tool-calls': {type: 'string'},
      only: {type: 'string', multiple: true},
      list: {type: 'boolean'},
      json: {type: 'boolean'},
      report: {type: 'string'},
      help: {type: 'boolean', short: 'h'},
    },
  }).values;
}

function printList() {
  for (const item of items) {
    const state = item.runnable ? (item.default ? 'default' : 'optional') : 'unverified-only';
    console.info(`${item.id} [${state}]`);
    console.info(`  ${item.title}`);
    if (item.manual) console.info(`  未验证: ${item.manual}`);
  }
}

function normalizeSettings(values) {
  const rawProvider = values.provider;
  const budgetMs = parseBudget(values);
  if (!rawProvider || budgetMs === undefined) {
    failUsage('An explicit --provider and --budget-ms are required. No runtime or budget default is applied.');
  }
  const provider = normalizeProvider(rawProvider);
  if (!provider) failUsage(`Unknown provider "${rawProvider}". Use codex, dsh, deepseek, or another named HTTP provider with --protocol.`);
  const model = values.model?.trim();
  if (!model) failUsage('An explicit --model is required; no real model is substituted.');
  if (provider.runtime === 'codex') {
    if (values.protocol && values.protocol !== 'codex-app-server') failUsage('Codex only supports the codex-app-server protocol.');
    if (values['base-url']) failUsage('Codex uses its local App Server login and does not accept --base-url.');
  }
  const protocol = provider.runtime === 'codex' ? 'codex-app-server' : (values.protocol ?? provider.protocolDefault);
  if (provider.runtime === 'dsh' && !protocol) failUsage(`HTTP provider "${provider.name}" requires an explicit --protocol.`);
  if (provider.runtime === 'dsh' && !PROTOCOLS.includes(protocol)) failUsage(`Unsupported DSH protocol "${protocol}".`);
  const reasoning = values.reasoning ?? (provider.runtime === 'codex' ? 'low' : 'high');
  if (!REASONING_EFFORTS.includes(reasoning)) failUsage(`Unsupported reasoning effort "${reasoning}".`);
  if (provider.runtime !== 'codex' && ['minimal', 'medium', 'xhigh', 'ultra'].includes(reasoning)) {
    failUsage(`Reasoning effort "${reasoning}" requires Codex App Server.`);
  }
  const serviceTier = values['service-tier'] ?? 'default';
  if (!['default', 'fast'].includes(serviceTier)) failUsage('--service-tier must be default or fast.');
  if (provider.runtime !== 'codex' && values['service-tier']) failUsage('--service-tier is only valid for Codex.');
  const baseUrl = provider.runtime === 'dsh' ? validateBaseUrl(values['base-url']) : undefined;
  const maxTokens = parseInteger('--max-tokens', values['max-tokens'], 1, 128_000, 8_192);
  const maxToolCalls = parseInteger('--max-tool-calls', values['max-tool-calls'], 1, 64, 8);
  let apiKey, allowUnauthenticatedLocal = false;
  if (provider.runtime === 'dsh') {
    allowUnauthenticatedLocal = Boolean(values['allow-unauthenticated-local']);
    if (allowUnauthenticatedLocal) {
      if (!baseUrl) failUsage('--allow-unauthenticated-local requires an explicit loopback --base-url.');
      const hostname = new URL(baseUrl).hostname;
      if (!['localhost', '127.0.0.1', '[::1]'].includes(hostname)) failUsage('--allow-unauthenticated-local is only valid for a loopback model endpoint.');
    }
    if (!allowUnauthenticatedLocal) {
      const envName = values['api-key-env'];
      apiKey = envName ? process.env[envName] : process.env.MOTE_MODEL_API_KEY;
      if (!apiKey && !envName && protocol === 'deepseek') apiKey = process.env.DEEPSEEK_API_KEY;
      const fallbackHint = !envName && protocol === 'deepseek' ? ' (or DEEPSEEK_API_KEY for the deepseek protocol)' : '';
      if (!apiKey) failUsage(`No DSH credential found. Set ${envName ?? 'MOTE_MODEL_API_KEY'}${fallbackHint}, or explicitly allow an unauthenticated loopback model.`);
    }
  }
  const modelProvider = provider.runtime === 'codex'
    ? 'codex'
    : (values['model-provider'] ?? provider.modelProvider ?? (protocol === 'deepseek' ? 'deepseek' : 'custom'));
  return {
    provider: provider.runtime,
    providerName: provider.name,
    runtime: provider.runtime === 'codex' ? 'mote.runtime.codex' : 'mote.runtime.dsh',
    protocol,
    model,
    modelProvider,
    budgetMs,
    reasoning,
    serviceTier,
    baseUrl,
    apiKey,
    allowUnauthenticatedLocal,
    maxTokens,
    maxToolCalls,
    requestTimeoutMs: provider.runtime === 'dsh' ? Math.min(Math.max(budgetMs, 5_000), 600_000) : null,
    only: selectItems(values),
  };
}

function generatedArchive() {
  const current = {
    id: randomUUID(),
    capturedAt: '2026-09-18T00:00:00.000Z',
    deviceId: 'generated-live-acceptance',
    deviceName: 'Generated live acceptance',
    appName: 'Generated observatory note',
    sourceType: 'note',
    ocrText: 'Generated live acceptance fixture. The synthetic observatory opens on Thursday at 16:45. The earlier Wednesday 14:30 plan was cancelled. This is generated test data, not a personal record.',
  };
  const superseded = {
    ...current,
    id: randomUUID(),
    capturedAt: '2026-09-17T00:00:00.000Z',
    appName: 'Generated outdated draft',
    ocrText: 'Generated superseded draft: the synthetic observatory opens on Wednesday at 14:30. This draft was replaced by the current schedule.',
  };
  const records = [superseded, current];
  const reader = {
    search: async () => records,
    timeline: async () => ({items: records, nextCursor: null}),
    evidence: async ({ids}) => records.filter(record => ids.includes(record.id)),
    activity: async () => ({records: 0, activeMs: 0}),
    devices: async () => [],
  };
  return {current, superseded, reader};
}

function agentOptions(settings, reader) {
  const common = {
    reader,
    provider: settings.modelProvider,
    protocol: settings.protocol,
    model: settings.model,
    reasoningEffort: settings.reasoning,
    maxTokens: settings.maxTokens,
    maxToolCalls: settings.maxToolCalls,
    agentTimeoutMs: settings.budgetMs,
  };
  if (settings.provider === 'codex') {
    return {
      ...common,
      serviceTier: settings.serviceTier,
      codex: {
        ...(process.env.MOTE_CODEX_BIN ? {executable: process.env.MOTE_CODEX_BIN} : {}),
        ...(process.env.MOTE_CODEX_HOME ? {home: process.env.MOTE_CODEX_HOME} : {}),
      },
    };
  }
  return {
    ...common,
    baseUrl: settings.baseUrl,
    apiKey: settings.apiKey,
    allowUnauthenticatedLocal: settings.allowUnauthenticatedLocal,
    requestTimeoutMs: settings.requestTimeoutMs,
  };
}

async function loadAgent() {
  if (!existsSync(agentEntry)) {
    throw new Error('packages/agent/dist/index.js is missing. Run `npm run build -w @mote/agent` first.');
  }
  return import(pathToFileURL(agentEntry).href);
}

function sanitizeError(error) {
  const name = error instanceof Error ? error.name : 'UnknownError';
  const message = error instanceof Error ? error.message : String(error);
  return {name, message: message.slice(0, 800)};
}

async function queryOnce(module, settings, fixture, input, trace = []) {
  const agent = module.createAgent(agentOptions(settings, fixture.reader));
  let result, failure;
  try {
    result = await agent.query({
      ...input,
      signal: AbortSignal.timeout(settings.budgetMs + 5_000),
      onTrace(event) {
        if (event.type === 'tool.started' && typeof event.tool === 'string' && !trace.includes(event.tool)) trace.push(event.tool);
        input.onTrace?.(event);
      },
    });
  } catch (error) {
    failure = error;
  }
  try { await agent.close(); }
  catch (error) { failure ??= error; }
  if (failure) throw failure;
  return result;
}

function assertCitedAnswer(result, fixture) {
  assert.ok(result.runId, 'the Host must return a run ID');
  assert.ok(result.trace.length > 0, 'the real model must call a retrieval tool');
  assert.ok(result.trace.some(step => step.tool === 'search_context' || step.tool === 'timeline'), 'the real model must discover the generated archive');
  assert.ok(result.trace.some(step => step.tool === 'evidence'), 'the real model must read the delivered original evidence');
  assert.ok(result.citations.some(citation => citation.id === fixture.current.id), 'the current generated record must be cited');
  assert.match(result.answer, /16:45/, 'the answer must contain the current generated opening time');
  assert.match(result.answer, /\b(thursday|thu)\b/i, 'the answer must contain the current generated opening day');
}

async function runQueryEvidence(context) {
  const fixture = generatedArchive();
  const trace = [];
  const started = performance.now();
  const result = await queryOnce(context.module, context.settings, fixture, {
    question: 'Find the generated observatory schedule in the archive. Read the exact original evidence and report the current opening day and time. Cite the current record, not the superseded draft.',
    language: 'en',
    timeZone: 'Asia/Shanghai',
    contextTime: '2026-09-18T00:00:00.000Z',
  }, trace);
  assertCitedAnswer(result, fixture);
  return {
    durationMs: Math.round(performance.now() - started),
    evidence: {
      tools: result.trace.map(step => step.tool),
      citations: result.citations.map(citation => citation.id),
      answer: result.answer,
      evidenceReadRanges: result.evidenceReadRanges ?? [],
    },
  };
}

async function runWorkingContext(context) {
  const reader = {
    search: async () => { throw new Error('working-memory must not read the archive'); },
    timeline: async () => { throw new Error('working-memory must not read the archive'); },
    evidence: async () => { throw new Error('working-memory must not read the archive'); },
    activity: async () => { throw new Error('working-memory must not read the archive'); },
    devices: async () => [],
  };
  const turns = [
    {turnId: 'generated-first', question: 'Never upload the project to a public cloud. I explicitly reject cloud deployment.', answer: 'Understood; local-only remains required.'},
    ...Array.from({length: 12}, (_, index) => ({turnId: `generated-${index}`, question: `Generated progress ${index}`, answer: 'Synthetic context filler; no change to prior constraints. '.repeat(50)})),
    {turnId: 'generated-last', question: 'The export date is undecided.', answer: 'Awaiting a decision.'},
  ];
  const started = performance.now();
  const result = await queryOnce(context.module, context.settings, {reader}, {
    question: 'Compact this dialogue into at most 1800 characters. Preserve explicit rejected proposals and unresolved decisions.',
    skill: 'working-memory',
    language: 'en',
    timeZone: 'Asia/Shanghai',
    contextTime: '2026-09-18T00:00:00.000Z',
    taskContext: {turns},
  });
  assert.equal(result.trace.length, 0, 'working-memory must not call archive tools');
  assert.equal(result.citations.length, 0, 'working-memory must not cite archive records');
  assert.ok(result.answer.length <= 1_800, 'working-memory must respect the requested compact length');
  assert.match(result.answer, /cloud/i, 'working-memory must retain the cloud constraint');
  assert.match(result.answer, /(reject|never|not|prohibit|local.only)/i, 'working-memory must retain the rejected deployment decision');
  return {
    durationMs: Math.round(performance.now() - started),
    evidence: {tools: [], citations: [], answerCharacters: result.answer.length, answer: result.answer},
  };
}

async function runRestart(context) {
  const fixture = generatedArchive();
  const started = performance.now();
  const first = await queryOnce(context.module, context.settings, fixture, {
    question: 'Find the generated observatory schedule in the archive. Read the exact original evidence and report the current opening day and time. Cite the current record.',
    language: 'en', timeZone: 'Asia/Shanghai', contextTime: '2026-09-18T00:00:00.000Z',
  });
  assertCitedAnswer(first, fixture);
  const second = await queryOnce(context.module, context.settings, fixture, {
    question: 'In a fresh runtime, find the generated observatory schedule again. Read the exact original evidence, report the current opening day and time, and cite the current record.',
    language: 'en', timeZone: 'Asia/Shanghai', contextTime: '2026-09-18T00:00:00.000Z',
  });
  assertCitedAnswer(second, fixture);
  assert.notEqual(first.runId, second.runId, 'a fresh Agent host must issue a new run ID');
  return {
    durationMs: Math.round(performance.now() - started),
    evidence: {runs: 2, runIds: [first.runId, second.runId], tools: [...new Set([...first.trace, ...second.trace].map(step => step.tool))]},
  };
}

function itemState(item, selected, stopped) {
  if (!item.runnable) {
    return {status: 'unverified', label: '未验证', reason: `This short runner does not execute this live journey. ${item.manual}`};
  }
  if (!selected) {
    return {status: 'unverified', label: '未验证', reason: `Not selected. Use --only ${item.id} to run it explicitly.`};
  }
  if (stopped) {
    return {status: 'unverified', label: '未验证', reason: 'Not run because an earlier selected item failed.'};
  }
  return undefined;
}

function reportPath(values, settings) {
  if (values.report) return resolve(repository, values.report);
  const stamp = new Date().toISOString().replaceAll(':', '-').replace(/\.\d{3}Z$/, 'Z');
  const safeModel = settings.model.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 80);
  return join(defaultReportDirectory, `${stamp}-${settings.provider}-${safeModel}.json`);
}

async function writeReport(path, report) {
  await mkdir(dirname(path), {recursive: true, mode: 0o700});
  await writeFile(path, JSON.stringify(report, null, 2) + '\n', {mode: 0o600});
}

function printHuman(report) {
  console.info(`Mote Agent runtime live acceptance (manual G4)`);
  console.info(`provider: ${report.provider.runtime} (${report.provider.selected})  model: ${report.model}  protocol: ${report.provider.protocol}`);
  console.info(`budget: ${report.budgetMs} ms  maxTokens: ${report.maxTokens}  maxToolCalls: ${report.maxToolCalls}`);
  for (const item of report.items) {
    const suffix = item.status === 'passed' ? `${item.durationMs} ms` : item.reason;
    console.info(`  ${item.status === 'passed' ? 'PASS' : item.status === 'failed' ? 'FAIL' : '未验证'} ${item.id}: ${suffix}`);
    if (item.status === 'passed' && item.evidence?.tools) console.info(`    tools: ${item.evidence.tools.join(', ') || '(none)'}`);
  }
  console.info(`Result: ${report.status === 'passed' ? 'PASS' : 'FAIL'} (${report.summary.passed} passed, ${report.summary.failed} failed, ${report.summary.unverified} 未验证)`);
  if (report.failure) console.info(`First failure: ${report.failure.item}: ${report.failure.name}: ${report.failure.message}`);
}

async function main(argv) {
  let values;
  try {
    values = parseOptions(argv);
  } catch (error) {
    console.error(`Invalid arguments: ${error instanceof Error ? error.message : String(error)}`);
    console.error('Run with --help for the acceptance runner contract.');
    process.exitCode = 2;
    return;
  }
  if (values.help) { console.info(help); return; }
  if (values.list) { printList(); return; }
  let settings;
  try {
    settings = normalizeSettings(values);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(`Refusing to run: ${error.message}`);
    console.error('Run with --help for the acceptance runner contract.');
    process.exitCode = 2;
    return;
  }
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const results = [];
  let stopped = false, failure;
  let module;
  try {
    module = await loadAgent();
  } catch (error) {
    console.error(`Cannot start live acceptance: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
    return;
  }
  for (const item of items) {
    const unverified = itemState(item, settings.only.has(item.id), stopped);
    if (unverified) { results.push({id: item.id, title: item.title, selected: settings.only.has(item.id), ...unverified}); continue; }
    const itemStarted = performance.now();
    try {
      const result = await item.run({module, settings});
      results.push({id: item.id, title: item.title, selected: true, status: 'passed', label: '通过', durationMs: result.durationMs ?? Math.round(performance.now() - itemStarted), evidence: result.evidence});
    } catch (error) {
      stopped = true;
      const safe = sanitizeError(error);
      failure ??= {item: item.id, ...safe};
      results.push({id: item.id, title: item.title, selected: true, status: 'failed', label: '失败', durationMs: Math.round(performance.now() - itemStarted), error: safe});
    }
  }
  const summary = {
    passed: results.filter(item => item.status === 'passed').length,
    failed: results.filter(item => item.status === 'failed').length,
    unverified: results.filter(item => item.status === 'unverified').length,
  };
  const report = {
    schemaVersion: 1,
    status: summary.failed || summary.passed === 0 ? 'failed' : 'passed',
    generatedFixturesOnly: true,
    personalDataUsed: false,
    liveModel: true,
    provider: {selected: settings.providerName, runtime: settings.runtime, protocol: settings.protocol},
    model: settings.model,
    reasoningEffort: settings.reasoning,
    ...(settings.provider === 'codex' ? {serviceTier: settings.serviceTier} : {requestTimeoutMs: settings.requestTimeoutMs}),
    budgetMs: settings.budgetMs,
    maxTokens: settings.maxTokens,
    maxToolCalls: settings.maxToolCalls,
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Math.round(performance.now() - started),
    items: results,
    summary,
    ...(failure ? {failure} : {}),
    limitations: [
      'A passing protocol/tool/citation result is not a semantic-quality benchmark.',
      'One stochastic run does not establish recall, accuracy or provider stability.',
      'Items reported as 未验证 were not executed by this invocation.',
      'Physical devices, external accounts and personal archives are outside this runner.',
    ],
  };
  const path = values.report || !values.json ? reportPath(values, settings) : undefined;
  if (path) await writeReport(path, report);
  if (values.json) console.info(JSON.stringify(report, null, 2));
  else {
    printHuman(report);
    if (path) console.info(`Report: ${path}`);
  }
  if (report.status !== 'passed') process.exitCode = 1;
}

await main(process.argv.slice(2));
