// Compile the exact production pure function against generated descriptors. No NSWorkspace/window/screen query.
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const directory = await mkdtemp(join(tmpdir(), 'mote-window-policy-'));
try {
  const main = join(directory, 'main.swift');
  await writeFile(main, `import AppKit
func window(_ pid: Int32?, _ layer: Int, _ alpha: Double = 1, _ bounds: CGRect = CGRect(x: 1, y: 1, width: 20, height: 20)) -> [String: Any] {
  var v: [String: Any] = [kCGWindowBounds as String: bounds.dictionaryRepresentation, kCGWindowLayer as String: layer, kCGWindowAlpha as String: alpha]
  if let pid = pid { v[kCGWindowOwnerPID as String] = pid }
  return v
}
let bounds = CGRect(x: 0, y: 0, width: 100, height: 100)
func resolve(_ pid: Int32) -> String? { return pid == 1 ? "dev.generated" : nil }
for layer in [0, 3, 100, -1] {
  let v = visibleWindowIdentities([window(1, 0), window(2, layer)], within: bounds, resolveBundle: resolve)
  precondition(v.unknown && v.ids == ["dev.generated"], "Unknown identity must fail closed regardless of layer")
}
precondition(visibleWindowIdentities([window(nil, 3)], within: bounds, resolveBundle: resolve).unknown)
precondition(visibleWindowIdentities([[:]], within: bounds, resolveBundle: resolve).unknown)
let ignored = visibleWindowIdentities([window(1, 0), window(2, 3, 0), window(2, 3, 1, CGRect(x: 200, y: 200, width: 10, height: 10))], within: bounds, resolveBundle: resolve)
precondition(!ignored.unknown && ignored.ids == ["dev.generated"])
print("{\\"ok\\":true,\\"syntheticDescriptorsOnly\\":true,\\"unknownFloatingAndNegativeLayersBlocked\\":true,\\"missingIdentityBlocked\\":true,\\"transparentAndOffscreenExcluded\\":true}")
`);
  const binary = join(directory, 'fixture');
  execFileSync('swiftc', [join(root, 'native/WindowIdentity.swift'), main, '-module-cache-path', join(root, 'native/bin/swift-module-cache'), '-o', binary], { stdio: 'pipe' });
  process.stdout.write(execFileSync(binary));
} finally { await rm(directory, { recursive: true, force: true }); }
