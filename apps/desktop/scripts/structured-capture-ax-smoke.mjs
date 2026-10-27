// Real AX read against an isolated generated AppKit window. This explicitly
// requires foreground UI and existing AX permission. It never grants TCC and
// never targets Chrome, WeChat, user content or screenshots.
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const directory = await mkdtemp(join(tmpdir(), 'mote-structured-ax-'));
let fixture;
const fullScreen = process.env.MOTE_AX_FIXTURE_FULLSCREEN === '1';
async function stopFixture() {
  if (!fixture || fixture.exitCode !== null) return;
  const child=fixture;
  // Ask the generated app to leave its temporary full-screen Space before exit.
  if (child.stdin?.writable) child.stdin.end('EXIT\n');
  await new Promise(resolve=>{const timeout=setTimeout(()=>{child.kill();resolve();},3500);child.once('exit',()=>{clearTimeout(timeout);resolve();});});
}
try {
  const main = join(directory, 'main.swift');
  await writeFile(main, String.raw`import AppKit
import Foundation
let mode = CommandLine.arguments.dropFirst().first ?? ""
func emit(_ value: [String: Any]) { FileHandle.standardOutput.write(try! JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])) }
if mode == "permission" {
    emit(["available": AXIsProcessTrusted()]); exit(0)
}
if mode == "app" {
    let app = NSApplication.shared; app.setActivationPolicy(.regular)
    let window = NSWindow(contentRect: NSRect(x: 100, y: 100, width: 800, height: 600), styleMask: [.titled, .closable], backing: .buffered, defer: false)
    let fullScreen = CommandLine.arguments.contains("fullscreen")
    if fullScreen { window.styleMask.insert(.resizable); window.collectionBehavior = [.fullScreenPrimary] }
    window.title = "Generated Mote AX fixture"
    let content = NSView(frame: NSRect(x: 0, y: 0, width: 800, height: 600)); content.setAccessibilityElement(true); content.setAccessibilityRole(.group)
    let title = NSTextField(labelWithString: "Generated conversation"); title.frame = NSRect(x: 100, y: 540, width: 400, height: 24); title.setAccessibilityIdentifier("current_chat_name_label")
    let list = NSView(frame: NSRect(x: 100, y: 120, width: 600, height: 380)); list.setAccessibilityElement(true); list.setAccessibilityRole(.list); list.setAccessibilityIdentifier("chat_message_list")
    let bubble = NSView(frame: NSRect(x: 10, y: 250, width: 450, height: 40)); bubble.setAccessibilityElement(true); bubble.setAccessibilityRole(.group); bubble.setAccessibilityIdentifier("chat_bubble_item_view")
    let message = NSTextField(labelWithString: "Generated AX message"); message.frame = NSRect(x: 5, y: 5, width: 400, height: 24); message.setAccessibilityIdentifier("fixture-message"); bubble.addSubview(message); bubble.setAccessibilityChildren([message])
    let leaf = NSView(frame: NSRect(x: 10, y: 180, width: 450, height: 40)); leaf.setAccessibilityElement(true); leaf.setAccessibilityRole(.group); leaf.setAccessibilityIdentifier("chat_bubble_item_view"); leaf.setAccessibilityLabel("Generated AX leaf description"); leaf.setAccessibilityChildren([])
    let input = NSTextField(string: "Generated input must be excluded"); input.frame = NSRect(x: 10, y: 100, width: 450, height: 40); input.setAccessibilityIdentifier("chat_input_field")
    list.addSubview(bubble); list.addSubview(leaf); list.addSubview(input); list.setAccessibilityChildren([bubble, leaf, input])
    let sidebar = NSTextField(labelWithString: "Generated sidebar must be excluded"); sidebar.frame = NSRect(x: 5, y: 300, width: 90, height: 40); sidebar.setAccessibilityIdentifier("session_item_generated")
    content.addSubview(title); content.addSubview(list); content.addSubview(sidebar); content.setAccessibilityChildren([sidebar, title, list])
    window.contentView = content; window.makeKeyAndOrderFront(nil); app.activate(ignoringOtherApps: true)
    FileHandle.standardInput.readabilityHandler = { handle in
        if handle.availableData.isEmpty { return }
        DispatchQueue.main.async {
            if window.styleMask.contains(.fullScreen) {
                window.toggleFullScreen(nil)
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { app.terminate(nil) }
            } else { app.terminate(nil) }
        }
    }
    if fullScreen { DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { window.toggleFullScreen(nil) } }
    func ready(_ remaining: Int) {
        if app.isActive && window.isKeyWindow && (!fullScreen || window.styleMask.contains(.fullScreen)) { print("READY"); fflush(stdout); return }
        if remaining <= 0 { print("ACTIVATION_FAILED"); fflush(stdout); app.terminate(nil); return }
        window.makeKeyAndOrderFront(nil); app.activate(ignoringOtherApps: true)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { ready(remaining - 1) }
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { ready(100) }
    DispatchQueue.main.asyncAfter(deadline: .now() + 20) { app.terminate(nil) }
    app.run(); exit(0)
}
guard mode == "inspect", let pid = Int32(CommandLine.arguments.last ?? ""), AXIsProcessTrusted(),
      let application = NSRunningApplication(processIdentifier: pid), application.bundleIdentifier == "dev.mote.generated.structured-ax",
      NSWorkspace.shared.frontmostApplication?.processIdentifier == pid else { emit(["ok": false, "reason": "fixture_not_foreground_or_ax_denied"]); exit(2) }
let root = AXUIElementCreateApplication(pid); AXUIElementSetMessagingTimeout(root, 0.1)
var focused: CFTypeRef?
guard AXUIElementCopyAttributeValue(root, kAXFocusedWindowAttribute as CFString, &focused) == .success, let focused = focused, CFGetTypeID(focused) == AXUIElementGetTypeID() else { emit(["ok": false, "reason": "fixture_window_unavailable"]); exit(2) }
let window = unsafeBitCast(focused, to: AXUIElement.self)
let reader = captureReader()
guard let bounds = reader.describe(window).bounds,
      let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]],
      let proof = captureWindowProof(windows, pid: pid, focused: bounds, screen: CGDisplayBounds(CGMainDisplayID())) else { emit(["ok": false, "reason": "fixture_geometry_unavailable"]); exit(2) }
func windowBoundsFullScreen(_ bounds: CGRect) -> Bool { bounds == CGDisplayBounds(CGMainDisplayID()) }
let actual = sanitizedWechatNodes(window, reader: reader, proof: proof, masks: [], deadline: Date().addingTimeInterval(3))
let actualJSON = String(data: try! JSONSerialization.data(withJSONObject: actual.nodes), encoding: .utf8)!
let obscured = !proof.occlusions.isEmpty
if obscured {
    guard !actualJSON.contains("Generated AX message"), !actualJSON.contains("Generated conversation"), !actualJSON.contains("Generated AX leaf description") else { emit(["ok": false, "reason": "occlusion_not_enforced"]); exit(3) }
}
// The target is exclusively this generated application. This component check
// reads real AX attributes with a synthetic clear geometry proof; it cannot be
// presented as a successful real foreground/occlusion admission check.
var componentProof = proof; componentProof.occlusions = []
let output = obscured ? sanitizedWechatNodes(window, reader: reader, proof: componentProof, masks: [], deadline: Date().addingTimeInterval(3)) : actual
let encoded = String(data: try! JSONSerialization.data(withJSONObject: output.nodes), encoding: .utf8)!
guard output.status == "ok", !output.truncated, encoded.contains("Generated AX message"), encoded.contains("Generated conversation"), encoded.contains("Generated AX leaf description"), !encoded.contains("Generated input must be excluded"), !encoded.contains("Generated sidebar must be excluded") else {
    emit(["ok": false, "reason": "fixture_assertion", "status": output.status, "truncated": output.truncated, "nodes": output.nodes]); exit(3)
}
var result: [String: Any] = ["ok": true, "generatedNativeAXOnly": true, "scopeAndInputExclusion": true, "readableMessageLeaves": true, "readableLeafDescription": true, "nodes": output.nodes.count, "fixtureFullScreen": windowBoundsFullScreen(bounds), "realGeometryAdmission": !obscured, "actualOcclusionRefused": obscured, "componentTextCheckUsesSyntheticClearGeometry": obscured]
if obscured {
    result["occlusions"] = proof.occlusions.map(captureRectJSON)
    result["dockSystemOverlayNames"] = windows.compactMap { w -> String? in
        guard let owner = w[kCGWindowOwnerPID as String] as? Int32,
              NSRunningApplication(processIdentifier: owner)?.bundleIdentifier == "com.apple.dock",
              let d = w[kCGWindowBounds as String] as? NSDictionary, let r = CGRect(dictionaryRepresentation: d), proof.occlusions.contains(r) else { return nil }
        return w[kCGWindowName as String] as? String ?? "name-unavailable"
    }
}
emit(result)
`);
  const app = join(directory, 'GeneratedStructuredAX.app');
  await mkdir(join(app, 'Contents/MacOS'), { recursive: true });
  await writeFile(join(app, 'Contents/Info.plist'), `<?xml version="1.0"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>dev.mote.generated.structured-ax</string><key>CFBundleExecutable</key><string>fixture</string><key>CFBundleName</key><string>Generated Mote AX fixture</string><key>NSHighResolutionCapable</key><true/></dict></plist>`);
  const binary = join(app, 'Contents/MacOS/fixture');
  execFileSync('swiftc', [join(root, 'native/StructuredCapture.swift'), join(root, 'native/CaptureSystemOverlay.swift'), main, '-module-cache-path', join(root, 'native/bin/swift-module-cache'), '-o', binary], { stdio: 'pipe' });
  const permission = JSON.parse(execFileSync(binary, ['permission'], { encoding: 'utf8' }));
  if (!permission.available) {
    process.stdout.write(JSON.stringify({ skipped: true, reason: 'existing_ax_permission_required', generatedNativeAXOnly: true }) + '\n');
  } else {
    // Save only the previous PID for focus restoration; never read its windows.
    const restoreSource = join(directory, 'focus.swift');
    await writeFile(restoreSource, 'import AppKit\nif let pid = CommandLine.arguments.dropFirst().first.flatMap({ Int32($0) }) { NSRunningApplication(processIdentifier: pid)?.activate(options: []) } else { print(NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0) }\n');
    const restore = join(directory, 'focus');
    execFileSync('swiftc', [restoreSource, '-module-cache-path', join(root, 'native/bin/swift-module-cache'), '-o', restore]);
    const previousPid = execFileSync(restore, { encoding: 'utf8' }).trim();
    try {
      fixture = spawn(binary, ['app', ...(fullScreen ? ['fullscreen'] : [])], { stdio: ['pipe', 'pipe', 'pipe'] });
      await new Promise((resolve, reject) => {
        let out = '';
        const timeout = setTimeout(() => reject(new Error('Generated AX app startup timed out')), 10000);
        fixture.stdout.on('data', chunk => { out += chunk; if (out.includes('READY')) { clearTimeout(timeout); resolve(); } });
        fixture.once('error', error => { clearTimeout(timeout); reject(error); });
        fixture.once('exit', code => { clearTimeout(timeout); reject(new Error('Generated AX app exited: ' + code)); });
      });
      // A few AX reads can precede application activation; retry boundedly only
      // for explicit focus readiness, never after a policy assertion failure.
      let outcome;
      for (let attempt = 0; attempt < 10; attempt++) {
        try { outcome = execFileSync(binary, ['inspect', String(fixture.pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); break; }
        catch (error) {
          if (!String(error.stdout).includes('fixture_not_foreground_or_ax_denied') || attempt === 9) throw error;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
      process.stdout.write(outcome + '\n');
    } finally {
      await stopFixture();
      if (previousPid !== '0') execFileSync(restore, [previousPid]);
    }
  }
} finally {
  await stopFixture();
  await rm(directory, { recursive: true, force: true });
}
