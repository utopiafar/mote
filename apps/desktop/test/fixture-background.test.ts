import { expect, test } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

test('Electron UI fixture entry points load the background policy before Electron and product modules', () => {
  // These Node-only orchestration scripts resolve Electron's executable, never its app API.
  const nodeDrivers = new Set(['apps/desktop/scripts/complex-app-driver.cjs']);
  const helpers = new Set(['scripts/fixture-background.cjs', 'scripts/fixture-language.cjs']);
  for (const directory of ['scripts', 'apps/desktop/scripts']) {
    for (const name of readdirSync(resolve(root, directory)).filter(name => name.endsWith('.cjs'))) {
      const path = `${directory}/${name}`;
      if (nodeDrivers.has(path) || helpers.has(path)) continue;
      const source = readFileSync(resolve(root, path), 'utf8');
      if (!/require\(['"]electron['"]\)/.test(source)) continue;
      // Screenshot fixtures may explicitly clear the visible-mode opt-in before policy loads.
      const bootstrap = source.replace(/^delete process\.env\.MOTE_TEST_SHOW_UI;\r?\n/, '');
      expect(bootstrap.split('\n')[0], path).toMatch(/^require\(['"].*fixture-background\.cjs['"]\);$/);
    }
  }
});

test.runIf(process.platform === 'darwin')('real hidden Electron windows preserve input, rendering and recreation without showing or focusing', () => {
  const require = createRequire(import.meta.url);
  const env = { ...process.env };
  delete env.MOTE_TEST_SHOW_UI; delete env.ELECTRON_RUN_AS_NODE;
  const stdout = execFileSync(require('electron'), ['scripts/test-background-ui.cjs'], {
    cwd: root, env, encoding: 'utf8', timeout: 30000,
  });
  const report = JSON.parse(stdout.trim());
  expect(report).toMatchObject({ ok: true, generatedFixtureOnly: true, windowsShown: 0, nativeWindowFocuses: 0,
    windowRecreation: true, keyboardAndWheel: true, pointerInput: true, animationFrames: true, generatedPageCapture: true, unexpectedPromptsRejected: true });
  const failed = spawnSync(require('electron'), ['scripts/test-background-ui.cjs', '--fail-on-start'], {
    cwd: root, env, encoding: 'utf8', timeout: 10000,
  });
  expect(failed.error).toBeUndefined();
  expect(failed.status).toBe(1);
  expect(failed.stderr).toContain('Generated fixture startup failure');
  // Electron's CLI logs its load error before dispatching to our handler. The
  // custom handler must still exit promptly instead of opening the default GUI.
  expect(failed.stderr).toContain('Background fixture failed:');
}, 35000);
