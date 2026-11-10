import { build } from 'esbuild';
import { copyFile, cp, mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

await mkdir('dist', { recursive: true });
await build({entryPoints:['src/ui-bootstrap.ts'],outfile:'dist/ui-bundle.js',bundle:true,platform:'browser',target:'chrome130',format:'iife',charset:'utf8',minifyWhitespace:true,minifySyntax:true});
// A sandboxed preload cannot require arbitrary relative modules. Bundle the
// inventory-backed bridge so the channel constants stay one source while the
// renderer still receives only the declared owner API.
await build({entryPoints:['src/preload.ts'],outfile:'dist/preload.js',bundle:true,platform:'node',target:'node22',format:'cjs',charset:'utf8',external:['electron']});
for (const file of ['appearance-init.js', 'index.html', 'styles.css', 'design-tokens.css', 'permission-help.html', 'permission-help.css']) await copyFile(`src/${file}`, `dist/${file}`);
await cp('resources/tray', 'dist/resources/tray', { recursive: true });
await mkdir('native/bin', { recursive: true });
if (process.platform === 'darwin') {
  const result = spawnSync('swiftc', ['-O', '-target', `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macos13.3`, 'native/MoteHelper.swift', 'native/WindowIdentity.swift', 'native/StructuredCapture.swift', 'native/CaptureSystemOverlay.swift', '-module-cache-path', 'native/bin/swift-module-cache', '-o', 'native/bin/mote-helper'], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
  const updater = spawnSync('swiftc', ['-O', '-target', `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macos13.3`, 'native/MoteUpdater.swift', '-module-cache-path', 'native/bin/swift-module-cache', '-o', 'native/bin/mote-updater'], { stdio: 'inherit' });
  if (updater.status !== 0) process.exit(updater.status ?? 1);
  for (const [command, args] of [
    ['swift', ['-module-cache-path', 'native/bin/swift-module-cache', 'scripts/generate-brand-icons.swift', 'mac', 'native/bin/mote.iconset']],
    ['iconutil', ['-c', 'icns', '-o', 'native/bin/mote.icns', 'native/bin/mote.iconset']],
  ]) {
    const icon = spawnSync(command, args, { stdio: 'inherit' });
    if (icon.status !== 0) process.exit(icon.status ?? 1);
  }
} else {
  process.stdout.write('macOS native capture helper skipped; collection requires macOS in this MVP.\n');
}
