import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync, rmSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import ts from 'typescript';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const documentPath = join(testDirectory, '../../../docs/plugin-ui-sdk.md');
const expectedExamples = [
  'register-view', 'data', 'action', 'native-provider',
  'errors', 'version', 'lifecycle', 'i18n',
] as const;

/** The document is the source of truth: every marked block is a complete
 * module with a run() export, so a documented call cannot drift from the real
 * host/shared SDK without failing this contract. */
function documentedExamples() {
  const source = readFileSync(documentPath, 'utf8');
  const pattern = /```ts\r?\n\/\/ @contract example: ([a-z0-9-]+)\r?\n([\s\S]*?)```/g;
  const examples = new Map<string, string>();
  for (const match of source.matchAll(pattern)) examples.set(match[1]!, match[2]!);
  return examples;
}

function compilerOptions() {
  const configPath = join(testDirectory, '../tsconfig.json');
  const loaded = ts.readConfigFile(configPath, ts.sys.readFile);
  if (loaded.error) throw new Error(ts.flattenDiagnosticMessageText(loaded.error.messageText, '\n'));
  const parsed = ts.parseJsonConfigFileContent(loaded.config, ts.sys, dirname(configPath));
  const error = parsed.errors.find(item => item.code !== 18003);
  if (error) throw new Error(ts.flattenDiagnosticMessageText(error.messageText, '\n'));
  return {...parsed.options, noEmit: true};
}

test('documented UI SDK examples compile and run against the real APIs', async t => {
  const examples = documentedExamples();
  assert.deepEqual([...examples.keys()], [...expectedExamples], 'the document exposes every contract example exactly once');

  const files = new Map<string, string>();
  for (const name of expectedExamples) {
    const file = join(testDirectory, `plugin-ui-sdk-example-${name}-${randomUUID()}.ts`);
    writeFileSync(file, examples.get(name)!);
    files.set(name, file);
  }
  t.after(() => {
    for (const file of files.values()) rmSync(file, {force: true});
  });

  const program = ts.createProgram([...files.values()], compilerOptions());
  const diagnostics = ts.getPreEmitDiagnostics(program).filter(diagnostic => {
    return diagnostic.file !== undefined && [...files.values()].includes(diagnostic.file.fileName);
  });
  assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: file => file,
    getCurrentDirectory: () => testDirectory,
    getNewLine: () => '\n',
  }));

  const results = new Map<string, any>();
  for (const [name, file] of files) {
    const module = await import(pathToFileURL(file).href);
    assert.equal(typeof module.run, 'function', `${name} exports run()`);
    results.set(name, await module.run());
  }

  const view = results.get('register-view');
  assert.equal(view.pageId, 'notes');
  assert.equal(view.rendererId, 'notes.detail');

  const data = results.get('data');
  assert.equal(data.schemaRef, 'fixture.note');
  assert.equal(data.schemaVersion, 1);
  assert.match(data.markup, /Generated note/);

  const action = results.get('action');
  assert.equal(action.saved.ok, true);
  assert.equal(action.unknown.reason, 'undeclared');
  assert.equal(action.calls, 1);

  const native = results.get('native-provider');
  assert.deepEqual(native.missing, {state: 'requires-build', reason: 'requires_build'});
  assert.deepEqual(native.active, {state: 'active'});
  assert.equal(native.provider.buildId, 'mac-fixture-2026.11.04');

  const errors = results.get('errors');
  assert.equal(errors.reason, 'api_incompatible');
  assert.equal(errors.contractCode, 'invalid_contract');
  assert.equal(errors.stateCode, 'invalid_namespace');

  const version = results.get('version');
  assert.equal(version.sdk, '0.1.0');
  assert.equal(version.contract, 1);
  assert.equal(version.accepted, true);
  assert.equal(version.rejected, 'api_incompatible');

  const lifecycle = results.get('lifecycle');
  assert.deepEqual(lifecycle.suspended, {ok: true});
  assert.equal(lifecycle.lateOutcome, 'stale');
  assert.equal(lifecycle.hold, 'hold');
  assert.equal(lifecycle.committed, 'commit');
  assert.equal(lifecycle.draft.text, 'Generated draft');
  assert.equal(lifecycle.saved.length, 1);

  const i18n = results.get('i18n');
  assert.equal(i18n.zh.routeId, 'notes.navigation');
  assert.equal(i18n.en.routeId, 'notes.navigation');
  assert.equal(i18n.zh.label.text, '笔记');
  assert.equal(i18n.en.label.text, 'Notes');
  assert.equal(i18n.missing.fallback, 'key_missing');
});
