import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

await mkdir('dist', { recursive: true });
await build({entryPoints:['src/ui-bootstrap.ts'],outfile:'dist/ui-bundle.js',bundle:true,platform:'browser',target:'chrome130',format:'iife'});
for (const file of ['index.html', 'styles.css']) await copyFile(`src/${file}`, `dist/${file}`);
await mkdir('native/bin', { recursive: true });
if (process.platform === 'darwin') {
  const nativeBuild = spawnSync(process.execPath, ['scripts/build-qwen.mjs'], { stdio: 'inherit' });
  if (nativeBuild.status !== 0) process.exit(nativeBuild.status ?? 1);
  const result = spawnSync('swiftc', ['-O', '-target', `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macos13.3`, 'native/MoteHelper.swift', 'native/WindowIdentity.swift', '-module-cache-path', 'native/bin/swift-module-cache', '-o', 'native/bin/mote-helper'], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
  const updater = spawnSync('swiftc', ['-O', '-target', `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macos13.3`, 'native/MoteUpdater.swift', '-module-cache-path', 'native/bin/swift-module-cache', '-o', 'native/bin/mote-updater'], { stdio: 'inherit' });
  if (updater.status !== 0) process.exit(updater.status ?? 1);
  for (const [command, args] of [
    ['swift', ['-module-cache-path', 'native/bin/swift-module-cache', 'scripts/generate-icon.swift', 'native/bin/mote.iconset']],
    ['iconutil', ['-c', 'icns', '-o', 'native/bin/mote.icns', 'native/bin/mote.iconset']],
  ]) {
    const icon = spawnSync(command, args, { stdio: 'inherit' });
    if (icon.status !== 0) process.exit(icon.status ?? 1);
  }
} else {
  process.stdout.write('macOS native capture helper skipped; collection requires macOS in this MVP.\n');
}
