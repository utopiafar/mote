import { copyFile, mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

await mkdir('dist', { recursive: true });
for (const file of ['index.html', 'styles.css']) await copyFile(`src/${file}`, `dist/${file}`);
await mkdir('native/bin', { recursive: true });
if (process.platform === 'darwin') {
  const nativeBuild = spawnSync(process.execPath, ['scripts/build-qwen.mjs'], { stdio: 'inherit' });
  if (nativeBuild.status !== 0) process.exit(nativeBuild.status ?? 1);
  const result = spawnSync('swiftc', ['-O', '-target', `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macos13.3`, 'native/MoteHelper.swift', '-o', 'native/bin/mote-helper'], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
  for (const [command, args] of [
    ['swift', ['scripts/generate-icon.swift', 'native/bin/mote.iconset']],
    ['iconutil', ['-c', 'icns', '-o', 'native/bin/mote.icns', 'native/bin/mote.iconset']],
  ]) {
    const icon = spawnSync(command, args, { stdio: 'inherit' });
    if (icon.status !== 0) process.exit(icon.status ?? 1);
  }
} else {
  process.stdout.write('macOS native capture helper skipped; collection requires macOS in this MVP.\n');
}
