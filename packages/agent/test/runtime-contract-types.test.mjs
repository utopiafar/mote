import test from 'node:test';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';

test('runtime and Host declarations reject authority swaps and missing output dependencies', () => {
  const compiler = createRequire(import.meta.url).resolve('typescript/bin/tsc');
  execFileSync(process.execPath, [
    compiler, '--noEmit', '--strict', '--skipLibCheck', '--pretty', 'false',
    '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext',
    fileURLToPath(new URL('./runtime-contracts.types.ts', import.meta.url)),
  ], {timeout: 60000, stdio: 'pipe'});
});
