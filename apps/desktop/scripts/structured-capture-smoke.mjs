// Compile the production policies against generated trees only. Never inspects
// AX, screen, a user profile, Chrome or WeChat on the test machine.
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const directory = await mkdtemp(join(tmpdir(), 'mote-structured-policy-'));
try {
  const main = join(directory, 'main.swift');
  await writeFile(main, String.raw`import AppKit
final class GeneratedNode {
    var role: String; var identifier: String; var bounds: CGRect; var values: [String: String]; var children: [GeneratedNode]
    var hidden = false; var editable = false; var countOverride: Int?
    init(_ role: String, _ id: String, _ bounds: CGRect, _ values: [String: String] = [:], _ children: [GeneratedNode] = []) {
        self.role = role; identifier = id; self.bounds = bounds; self.values = values; self.children = children
    }
}
let full = CGRect(x: 0, y: 0, width: 1000, height: 800)
let box = CGRect(x: 120, y: 120, width: 100, height: 20)
func node(_ role: String = "AXStaticText", _ id: String = "", _ value: String = "", _ bounds: CGRect = box, _ children: [GeneratedNode] = []) -> GeneratedNode {
    GeneratedNode(role, id, bounds, [kAXValueAttribute: value], children)
}
var reads: [String] = []
var childReads: [String] = []
let reader = CaptureAXReader<GeneratedNode>(describe: { n in
    CaptureAXDescriptor(role: n.role, identifier: n.identifier, bounds: n.bounds, hidden: n.hidden, editable: n.editable, childCount: n.countOverride ?? n.children.count)
}, children: { n, count in childReads.append(n.identifier); return Array(n.children.prefix(count)) }, text: { n, key in
    reads.append(n.identifier + ":" + key)
    let value = n.values[key]
    precondition(value != "MUST_NOT_READ", "Unapproved attribute was read: " + n.identifier + ":" + key)
    return value
})
let proof = CaptureWindowProof(bounds: full, screen: full, occlusions: [], windowID: 10)
func snapshot(_ window: GeneratedNode, _ masks: [CGRect] = [], _ p: CaptureWindowProof = proof) -> (status: String, nodes: [[String: Any]], truncated: Bool) {
    reads = []; childReads = []
    return sanitizedWechatNodes(window, reader: reader, proof: p, masks: masks, deadline: Date().addingTimeInterval(5))
}
func list(_ children: [GeneratedNode]) -> GeneratedNode { node("AXList", "chat_message_list", "MUST_NOT_READ", CGRect(x: 100, y: 100, width: 600, height: 400), children) }
func window(_ children: [GeneratedNode]) -> GeneratedNode { node("AXWindow", "generated-window", "MUST_NOT_READ", full, children) }
let good = node("AXStaticText", "visible-message", "Generated message")
let bubble = node("AXGroup", "chat_bubble_item_view", "MUST_NOT_READ", CGRect(x: 110, y: 110, width: 300, height: 40), [good])
bubble.values[kAXDescriptionAttribute] = "MUST_NOT_READ"
let input = node("AXTextArea", "chat_input_field", "MUST_NOT_READ", box, [node("AXStaticText", "editable-descendant", "MUST_NOT_READ")])
let editable = node("AXGroup", "editable-group", "MUST_NOT_READ", box, [node("AXStaticText", "editable-group-descendant", "MUST_NOT_READ")]); editable.editable = true
let hidden = node("AXStaticText", "hidden-message", "MUST_NOT_READ"); hidden.hidden = true
let clipped = node("AXStaticText", "clipped-message", "MUST_NOT_READ", CGRect(x: 690, y: 120, width: 100, height: 20))
let description = node("AXGroup", "chat_bubble_item_view"); description.values = [kAXDescriptionAttribute: "Generated leaf description"]
let unscoped = node("AXGroup", "unknown-leaf"); unscoped.values = [kAXDescriptionAttribute: "MUST_NOT_READ", kAXValueAttribute: "MUST_NOT_READ"]
let title = node("AXStaticText", "current_chat_name_label", "Generated conversation", CGRect(x: 100, y: 50, width: 100, height: 20))
let sidebar = node("AXStaticText", "session_item_generated", "MUST_NOT_READ", CGRect(x: 10, y: 120, width: 60, height: 20))
let last = node("AXStaticText", "last-message", "Repeated generated message")
let tree = window([sidebar, title, list([bubble, input, editable, hidden, clipped, description, unscoped, last])])
let result = snapshot(tree)
precondition(result.status == "ok" && !result.truncated)
let encoded = String(data: try! JSONSerialization.data(withJSONObject: result.nodes), encoding: .utf8)!
precondition(encoded.contains("Generated message") && encoded.contains("Generated leaf description") && encoded.contains("Generated conversation"))
precondition(!encoded.contains("session_item_generated") && !encoded.contains("MUST_NOT_READ"))
precondition(!reads.contains(where: { $0.hasPrefix("unknown-leaf:") || $0.hasPrefix("clipped-message:") }))
precondition(result.nodes.first(where: { $0["resourceId"] as? String == "last-message" })?["childIndex"] as? Int == 7, "Excluded siblings must not renumber observed order")
precondition(result.nodes.first(where: { $0["resourceId"] as? String == "current_chat_name_label" })?["childIndex"] as? Int == 1)
let ids = Set(result.nodes.compactMap { $0["id"] as? String })
precondition(result.nodes.allSatisfy { $0["parentId"] == nil || ids.contains($0["parentId"] as! String) })
let masked = snapshot(tree, [box]); precondition(!reads.contains("visible-message:AXValue"))
precondition(!String(data: try! JSONSerialization.data(withJSONObject: masked.nodes), encoding: .utf8)!.contains("Generated message"))
var coveredProof = proof; coveredProof.occlusions = [box]
_ = snapshot(tree, [], coveredProof); precondition(!reads.contains("visible-message:AXValue"))
// A message-only overlay leaves the conversation title visible. AX can still
// report uncovered leaves, but this must not authorize OCR of the whole list.
reads = []
let ocrBlocked = sanitizedWechatNodes(tree, reader: reader, proof: coveredProof, masks: [], deadline: Date().addingTimeInterval(5), requireUnoccludedRegion: true)
precondition(ocrBlocked.status == "blocked" && ocrBlocked.nodes.isEmpty && reads.isEmpty)
// The mixed list above contains editable/secure-policy regions. Dropping them
// from AX evidence must never authorize whole-list OCR of their draft pixels.
reads = []
let ocrMixed = sanitizedWechatNodes(tree, reader: reader, proof: proof, masks: [], deadline: Date().addingTimeInterval(5), requireUnoccludedRegion: true)
precondition(ocrMixed.status == "blocked" && ocrMixed.nodes.isEmpty && reads.isEmpty)
let safeTree = window([title, list([bubble, description, last])])
let ocrClear = sanitizedWechatNodes(safeTree, reader: reader, proof: proof, masks: [], deadline: Date().addingTimeInterval(5), requireUnoccludedRegion: true)
precondition(ocrClear.status == "ok" && !ocrClear.nodes.isEmpty)
for protected in [input, editable, hidden, node("AXSecureTextField", "generated-secure-input", "MUST_NOT_READ")] {
    reads = []
    let protectedTree = window([title, list([protected])])
    let blocked = sanitizedWechatNodes(protectedTree, reader: reader, proof: proof, masks: [], deadline: Date().addingTimeInterval(5), requireUnoccludedRegion: true)
    precondition(blocked.status == "blocked" && blocked.nodes.isEmpty && reads.isEmpty)
    // The independent AX producer can still emit other safe message fields.
    let ordinary = snapshot(window([title, list([good, protected])]))
    precondition(ordinary.status == "ok" && String(data: try! JSONSerialization.data(withJSONObject: ordinary.nodes), encoding: .utf8)!.contains("Generated message"))
}
let outsideInput = node("AXTextArea", "outside-list-draft", "MUST_NOT_READ", CGRect(x: 10, y: 600, width: 100, height: 20))
let outside = sanitizedWechatNodes(window([outsideInput, title, list([good])]), reader: reader, proof: proof, masks: [], deadline: Date().addingTimeInterval(5), requireUnoccludedRegion: true)
precondition(outside.status == "ok", "A disjoint excluded input does not belong to the OCR rectangle")
func ocrRefused(_ value: GeneratedNode, _ using: CaptureAXReader<GeneratedNode> = reader, _ deadline: Date = Date().addingTimeInterval(5)) {
    reads = []
    let result = sanitizedWechatNodes(value, reader: using, proof: proof, masks: [], deadline: deadline, requireUnoccludedRegion: true)
    precondition(result.status != "ok" && result.nodes.isEmpty && reads.isEmpty)
}
let unknownCount = node("AXGroup", "unknown-child-count", "MUST_NOT_READ"); unknownCount.countOverride = -1
ocrRefused(window([list([unknownCount])]))
let manyForOcr = (0..<4200).map { node("AXGroup", "large-fixture-" + String($0), "MUST_NOT_READ") }
ocrRefused(window([list(manyForOcr)]))
ocrRefused(safeTree, reader, Date.distantPast)
var failedReader = reader; failedReader.valid = { false }
ocrRefused(safeTree, failedReader)
var failedChildrenReader = reader; failedChildrenReader.children = { n, count in n.identifier == "chat_message_list" ? nil : Array(n.children.prefix(count)) }
ocrRefused(safeTree, failedChildrenReader)
var missingBoundsReader = reader; missingBoundsReader.describe = { n in
    CaptureAXDescriptor(role: n.role, identifier: n.identifier, bounds: n.identifier == "visible-message" ? nil : n.bounds, hidden: n.hidden, editable: n.editable, childCount: n.children.count)
}
ocrRefused(safeTree, missingBoundsReader)
precondition(snapshot(window([title])).status == "unsupported" && reads.isEmpty)
precondition(snapshot(window([list([good]), list([good])])).status == "unsupported" && reads.isEmpty)
let many = (0..<400).map { node("AXStaticText", "generated-" + String($0), "Repeated fixture") }
let truncated = snapshot(window([list(many)])); precondition(truncated.truncated && truncated.nodes.count == 256)
let uncertain = node("AXStaticText", "uncertain-children", "MUST_NOT_READ"); uncertain.countOverride = -1
precondition(snapshot(window([list([uncertain])])).truncated)
let expired = sanitizedWechatNodes(tree, reader: reader, proof: proof, masks: [], deadline: Date.distantPast)
precondition(expired.status == "unsupported")

// Browser identity reads URL and geometry, never page text or descendants.
func web(_ url: String = "https://fixture.invalid/generated") -> GeneratedNode {
    let area = node("AXWebArea", "generated-page", "MUST_NOT_READ", CGRect(x: 0, y: 80, width: 1000, height: 720), [node("AXStaticText", "private-page-descendant", "MUST_NOT_READ")])
    area.values["AXURL"] = url; area.countOverride = 9000
    return area
}
func page(_ root: GeneratedNode, _ p: CaptureWindowProof = proof) -> BrowserCapturePage<GeneratedNode>? {
    reads = []; childReads = []
    return browserCapturePage(root, reader: reader, proof: p, deadline: Date().addingTimeInterval(5))
}
let area = web(); let browser = window([area])
precondition(page(browser)?.url == "https://fixture.invalid/generated")
precondition(reads == ["generated-page:AXURL"] && !childReads.contains("generated-page"))
let settableChromeWrapper = node("AXGroup", "chrome-content-wrapper", "MUST_NOT_READ", full, [web()]); settableChromeWrapper.editable = true
precondition(page(window([settableChromeWrapper]))?.url == "https://fixture.invalid/generated")
precondition(reads == ["generated-page:AXURL"] && !childReads.contains("generated-page"))
let browserInput = node("AXTextArea", "browser-input", "MUST_NOT_READ", full, [web()]); browserInput.editable = true
precondition(page(window([browserInput])) == nil && reads.isEmpty)
let emptyToolbarIcon = node("AXImage", "empty-toolbar-icon", "MUST_NOT_READ", .zero)
precondition(page(window([emptyToolbarIcon, web()]))?.url == "https://fixture.invalid/generated")
precondition(reads == ["generated-page:AXURL"])
let uncertainEmptyBranch = node("AXGroup", "empty-branch", "MUST_NOT_READ", .zero, [web()])
precondition(page(window([uncertainEmptyBranch, web()])) == nil)
precondition(page(window([web(), web()])) == nil && reads.isEmpty)
precondition(page(window([web()]), coveredProof) == nil && reads.isEmpty)
let hiddenArea = web(); hiddenArea.hidden = true; precondition(page(window([hiddenArea])) == nil && reads.isEmpty)
let clippedArea = web(); clippedArea.bounds = CGRect(x: -1, y: 80, width: 1001, height: 720)
precondition(page(window([clippedArea])) == nil && reads.isEmpty)
for url in ["chrome-extension://generated/page", "file:///tmp/generated", "https://owner:secret@fixture.invalid/", "https://fixture.invalid/a\nb", "http://", String(repeating: "x", count: 2001)] {
    precondition(page(window([web(url)])) == nil)
}

// Same-app overlays must be treated as occlusion; missing or ambiguous OS
// descriptors never yield a geometry proof.
func cg(_ pid: Int32, _ id: Int, _ r: CGRect, _ alpha: Double = 1) -> [String: Any] {
    [kCGWindowOwnerPID as String: pid, kCGWindowNumber as String: id, kCGWindowLayer as String: 0, kCGWindowBounds as String: r.dictionaryRepresentation, kCGWindowAlpha as String: alpha]
}
let target = cg(7, 10, full), overlay = cg(7, 11, box)
precondition(captureWindowProof([target], pid: 7, focused: full, screen: full)?.windowID == 10)
precondition(captureWindowProof([overlay, target], pid: 7, focused: full, screen: full)?.occlusions == [box])
precondition(captureWindowProof([cg(8, 11, box, 0), target], pid: 7, focused: full, screen: full)?.occlusions.isEmpty == true)
precondition(captureWindowProof([[:], target], pid: 7, focused: full, screen: full) == nil)
precondition(captureWindowProof([target, target], pid: 7, focused: full, screen: full) == nil)
precondition(captureWindowProof([target], pid: 8, focused: full, screen: full) == nil)
precondition(captureWindowProof([target], pid: 7, focused: full, screen: box) == nil)
var titled = target; titled[kCGWindowName as String] = "Selected public article"
var otherTitle = cg(7, 12, full); otherTitle[kCGWindowName as String] = "Another window"
precondition(captureWindowProof([titled, otherTitle], pid: 7, focused: full, screen: full, focusedTitle: "Selected public article")?.windowID == 10)
precondition(captureWindowProof([otherTitle, titled], pid: 7, focused: full, screen: full, focusedTitle: "Selected public article")?.occlusions == [full])
precondition(captureWindowProof([titled, titled], pid: 7, focused: full, screen: full, focusedTitle: "Selected public article") == nil)
precondition(captureWindowProof([titled, otherTitle], pid: 7, focused: full, screen: full, focusedTitle: "") == nil)
precondition(captureWindowProof([titled, otherTitle], pid: 7, focused: full, screen: full, focusedTitle: "Selected public article - Google Chrome", focusedTitleSuffix: " - Google Chrome")?.windowID == 10)
var imitatedSuffix = otherTitle; imitatedSuffix[kCGWindowName as String] = "Selected public article - Google Chrome"
precondition(captureWindowProof([titled, imitatedSuffix], pid: 7, focused: full, screen: full, focusedTitle: "Selected public article - Google Chrome", focusedTitleSuffix: " - Google Chrome") == nil)
let beforeStack = captureWindowProof([overlay, titled], pid: 7, focused: full, screen: full)!.stack
let swappedStack = captureWindowProof([cg(7, 99, box), titled], pid: 7, focused: full, screen: full)!.stack
precondition(beforeStack != swappedStack)
// Read alpha only, including the outward-rounded edge of the overlap. A
// painted Dock outside the selected window is harmless; one alpha byte within
// it, an opaque/no-alpha image or a scaled/mismatched buffer must reject.
func alphaImage(_ values: [UInt8], alpha: CGImageAlphaInfo = .premultipliedFirst) -> CGImage {
    let bytes: [UInt8] = values.flatMap { [UInt8(0), UInt8(0), UInt8(0), $0] }
    let provider = CGDataProvider(data: Data(bytes) as CFData)!
    return CGImage(width: 2, height: 2, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: 8,
        space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGBitmapInfo(rawValue: alpha.rawValue).union(.byteOrder32Little),
        provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent)!
}
let surface = CGRect(x: 0, y: 0, width: 2, height: 2), upper = CGRect(x: 0, y: 0, width: 2, height: 1)
precondition(captureAlphaIsClear(alphaImage([0,0,255,255]), within: upper, surface: surface, scale: 1))
precondition(!captureAlphaIsClear(alphaImage([0,1,0,0]), within: upper, surface: surface, scale: 1))
precondition(!captureAlphaIsClear(alphaImage([0,0,255,0]), within: CGRect(x: 0, y: 0, width: 1, height: 1.01), surface: surface, scale: 1))
precondition(!captureAlphaIsClear(alphaImage([0,0,0,0], alpha: .noneSkipFirst), within: upper, surface: surface, scale: 1))
precondition(!captureAlphaIsClear(alphaImage([0,0,0,0]), within: upper, surface: surface, scale: 2))
// A second Chrome profile/window below the active one still belongs to the
// screenshot, even when it does not occlude the foreground DOM viewport.
func bundle(_ pid: Int32) -> String? { pid == 7 || pid == 8 ? "com.google.Chrome" : pid == 9 ? "dev.mote.fixture" : nil }
precondition(visibleBrowserWindowCount([target], within: full, resolveBundle: bundle) == 1)
precondition(visibleBrowserWindowCount([target, cg(8, 20, box)], within: full, resolveBundle: bundle) == 2)
precondition(visibleBrowserWindowCount([target, cg(9, 20, box)], within: full, resolveBundle: bundle) == 1)
precondition(visibleBrowserWindowCount([target, cg(10, 20, box)], within: full, resolveBundle: bundle) == 2)
precondition(visibleBrowserWindowCount([target, [:]], within: full, resolveBundle: bundle) == 2)
precondition(visibleBrowserWindowCount([target, cg(8, 20, box, 0), cg(8, 21, CGRect(x: 2000, y: 0, width: 10, height: 10))], within: full, resolveBundle: bundle) == 1)
print("{\"ok\":true,\"generatedDescriptorsOnly\":true,\"scopeAndLeafAttributes\":true,\"editableHiddenClippedMaskedOccludedExcluded\":true,\"originalChildOrder\":true,\"wholeOcrRegionProof\":true,\"browserIdentityWithoutText\":true,\"ambiguousContextsRejected\":true}")
`);
  const binary = join(directory, 'fixture');
  execFileSync('swiftc', [join(root, 'native/StructuredCapture.swift'), join(root, 'native/CaptureSystemOverlay.swift'), main, '-module-cache-path', join(root, 'native/bin/swift-module-cache'), '-o', binary], { stdio: 'pipe' });
  process.stdout.write(execFileSync(binary));
} finally { await rm(directory, { recursive: true, force: true }); }
