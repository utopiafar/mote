import AppKit
import Foundation

// These pure policies are shared with generated-descriptor fixtures. Production
// reads content only after scope, geometry and editability have been checked.
struct CaptureAXDescriptor {
    var role: String
    var identifier: String
    var bounds: CGRect?
    var hidden = false
    var editable = false
    var childCount = 0
    var uncertain = false
}
struct CaptureAXReader<Element> {
    var describe: (Element) -> CaptureAXDescriptor
    var children: (Element, Int) -> [Element]?
    var text: (Element, String) -> String?
    var valid: () -> Bool = { true }
}
struct CaptureWindowProof {
    var bounds: CGRect
    var screen: CGRect
    var occlusions: [CGRect]
    var windowID: Int
    var stack: [String] = []
}
func captureRectJSON(_ r: CGRect) -> [String: Double] {
    ["x": r.minX, "y": r.minY, "width": r.width, "height": r.height]
}
func captureRectSafe(_ r: CGRect) -> Bool {
    [r.minX, r.minY, r.width, r.height].allSatisfy { $0.isFinite } && r.width > 0 && r.height > 0
}
func captureTextAllowed(_ d: CaptureAXDescriptor) -> Bool {
    !d.hidden && !d.editable && !["AXTextField", "AXTextArea", "AXSecureTextField", "AXSearchField", "AXComboBox"].contains(d.role)
}
func captureWindowProof(_ windows: [[String: Any]], pid: Int32, focused: CGRect, screen: CGRect, focusedTitle: String? = nil, focusedTitleSuffix: String? = nil, transparentSystemWindows: Set<Int> = []) -> CaptureWindowProof? {
    guard captureRectSafe(focused), screen.contains(focused), windows.count <= 8192 else { return nil }
    // Match the actual focused window, not the first window owned by its PID:
    // same-application sheets and floating windows can cover captured content.
    var matching = windows.enumerated().filter { _, w in
        guard w[kCGWindowOwnerPID as String] as? Int32 == pid,
              (w[kCGWindowLayer as String] as? Int ?? 0) == 0,
              let dictionary = w[kCGWindowBounds as String] as? NSDictionary,
              let bounds = CGRect(dictionaryRepresentation: dictionary) else { return false }
        return bounds == focused && (w[kCGWindowAlpha as String] as? Double ?? 1) > 0
    }
    // Geometry is not a window identity when several Chrome windows are
    // maximized. Refine only with the exact focused AX title, never z-order.
    if matching.count > 1, let title = focusedTitle, !title.isEmpty {
        var titles = Set([title])
        // Chrome's AX title includes its application suffix, while WindowServer
        // exposes the document title. Both exact spellings remain candidates;
        // a document imitating the suffix must not resolve an ambiguity.
        if let suffix = focusedTitleSuffix, !suffix.isEmpty, title.hasSuffix(suffix), title.count > suffix.count { titles.insert(String(title.dropLast(suffix.count))) }
        matching = matching.filter { ($0.element[kCGWindowName as String] as? String).map(titles.contains) == true }
    }
    guard matching.count == 1, let target = matching.first,
          let number = target.element[kCGWindowNumber as String] as? Int else { return nil }
    var occlusions: [CGRect] = []
    for w in windows.prefix(target.offset) {
        if (w[kCGWindowAlpha as String] as? Double ?? 1) <= 0 { continue }
        guard let dictionary = w[kCGWindowBounds as String] as? NSDictionary,
              let bounds = CGRect(dictionaryRepresentation: dictionary), captureRectSafe(bounds) else { return nil }
        if bounds.intersects(focused), !transparentSystemWindows.contains(w[kCGWindowNumber as String] as? Int ?? -1) { occlusions.append(bounds) }
    }
    let stack = windows.prefix(target.offset + 1).filter { window in
        guard let raw = window[kCGWindowBounds as String] as? NSDictionary, let bounds = CGRect(dictionaryRepresentation: raw) else { return true }
        return bounds.intersects(focused) && (window[kCGWindowAlpha as String] as? Double ?? 1) > 0
    }.map { window -> String in
        let keys = [kCGWindowNumber, kCGWindowOwnerPID, kCGWindowLayer, kCGWindowBounds, kCGWindowAlpha, kCGWindowName]
        let fields = Dictionary(uniqueKeysWithValues: keys.compactMap { key -> (String, Any)? in
            window[key as String].map { (key as String, $0) }
        })
        return (try? JSONSerialization.data(withJSONObject: fields, options: [.sortedKeys])).flatMap { String(data: $0, encoding: .utf8) } ?? "invalid"
    }
    return CaptureWindowProof(bounds: focused, screen: screen, occlusions: occlusions, windowID: number, stack: stack)
}
// Full-display screenshots need a policy for every browser window, including
// windows behind the foreground one. Native metadata has no tab/site permission
// for those windows, so more than one (or unidentified relevant window) blocks
// screenshots without blocking the bound main-frame DOM observation.
func visibleBrowserWindowCount(_ windows: [[String: Any]], within screen: CGRect, resolveBundle: (Int32) -> String?) -> Int {
    var count = 0
    for window in windows {
        if (window[kCGWindowAlpha as String] as? Double ?? 1) <= 0 { continue }
        guard let dictionary = window[kCGWindowBounds as String] as? NSDictionary,
              let bounds = CGRect(dictionaryRepresentation: dictionary), captureRectSafe(bounds) else { count += 1; continue }
        if !bounds.intersects(screen) { continue }
        guard let pid = window[kCGWindowOwnerPID as String] as? Int32,
              let bundle = resolveBundle(pid), !bundle.isEmpty else { count += 1; continue }
        if bundle == "com.google.Chrome" { count += 1 }
    }
    return count
}
private func captureAttribute(_ e: AXUIElement, _ key: String) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(e, key as CFString, &value) == .success else { return nil }
    return value
}
private func captureBounds(_ e: AXUIElement, allowEmpty: Bool = false) -> CGRect? {
    guard let p = captureAttribute(e, kAXPositionAttribute), let s = captureAttribute(e, kAXSizeAttribute),
          CFGetTypeID(p) == AXValueGetTypeID(), CFGetTypeID(s) == AXValueGetTypeID() else { return nil }
    var point = CGPoint.zero; var size = CGSize.zero
    guard AXValueGetValue(unsafeBitCast(p, to: AXValue.self), .cgPoint, &point),
          AXValueGetValue(unsafeBitCast(s, to: AXValue.self), .cgSize, &size) else { return nil }
    let r = CGRect(origin: point, size: size)
    return captureRectSafe(r) || (allowEmpty && [r.minX, r.minY, r.width, r.height].allSatisfy { $0.isFinite } && r.width >= 0 && r.height >= 0) ? r : nil
}
private func captureFocusedWindow(_ root: AXUIElement) -> AXUIElement? {
    guard let value = captureAttribute(root, kAXFocusedWindowAttribute), CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
    return unsafeBitCast(value, to: AXUIElement.self)
}
private func captureLocked() -> Bool {
    (CGSessionCopyCurrentDictionary() as? [String: Any])?["CGSSessionScreenIsLocked"] as? Bool == true
}
private func captureWindows() -> [[String: Any]]? {
    CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]
}
private func captureProof(_ window: AXUIElement, _ pid: Int32) -> CaptureWindowProof? {
    guard let bounds = captureBounds(window), let windows = captureWindows() else { return nil }
    return captureWindowProof(windows, pid: pid, focused: bounds, screen: CGDisplayBounds(CGMainDisplayID()))
}
func captureReader() -> CaptureAXReader<AXUIElement> {
    var failed = false
    func read(_ e: AXUIElement, _ key: String) -> CFTypeRef? {
        var value: CFTypeRef?
        let status = AXUIElementCopyAttributeValue(e, key as CFString, &value)
        if status != .success && status != .attributeUnsupported && status != .noValue { failed = true }
        return status == .success ? value : nil
    }
    return CaptureAXReader(describe: { e in
        let role = read(e, kAXRoleAttribute) as? String ?? ""
        let subrole = read(e, kAXSubroleAttribute) as? String ?? ""
        var settable = DarwinBoolean(false)
        let setter = AXUIElementIsAttributeSettable(e, kAXValueAttribute as CFString, &settable)
        var count: CFIndex = 0
        let counted = AXUIElementGetAttributeValueCount(e, kAXChildrenAttribute as CFString, &count)
        return CaptureAXDescriptor(role: subrole == "AXSecureTextField" ? subrole : role,
            identifier: String((read(e, kAXIdentifierAttribute) as? String ?? "").prefix(300)), bounds: captureBounds(e, allowEmpty: true),
            hidden: read(e, "AXHidden") as? Bool == true || read(e, "AXVisible") as? Bool == false,
            editable: settable.boolValue || ![AXError.success, AXError.attributeUnsupported].contains(setter),
            childCount: counted == .success ? max(0, count) : counted == .attributeUnsupported ? 0 : -1, uncertain: role.isEmpty)
    }, children: { e, limit in
        if limit <= 0 { return [] }
        var values: CFArray?
        guard AXUIElementCopyAttributeValues(e, kAXChildrenAttribute as CFString, 0, limit, &values) == .success else { return nil }
        return values as? [AXUIElement]
    }, text: { e, attribute in
        guard let value = read(e, attribute) else { return nil }
        return attribute == "AXURL" ? ((value as? URL)?.absoluteString ?? value as? String) : value as? String
    }, valid: { !failed })
}
private struct ScannedCaptureNode<E> {
    var element: E
    var descriptor: CaptureAXDescriptor
    var parent: Int?
    var childIndex: Int
    var clip: CGRect
}
private func scanCaptureTree<E>(_ root: E, reader: CaptureAXReader<E>, window: CGRect, deadline: Date, stopAtWebArea: Bool = false) -> (nodes: [ScannedCaptureNode<E>], rejected: [CGRect], truncated: Bool) {
    var nodes: [ScannedCaptureNode<E>] = []; var rejected: [CGRect] = []; var truncated = false; var visited = 0
    func visit(_ e: E, parent: Int?, childIndex: Int, depth: Int, clip: CGRect) {
        if visited >= 4096 || depth > 24 || Date() > deadline { truncated = true; return }
        visited += 1
        let d = reader.describe(e)
        if d.uncertain { truncated = true }
        if stopAtWebArea && (d.hidden || ["AXTextField", "AXTextArea", "AXSecureTextField", "AXSearchField", "AXComboBox"].contains(d.role)) { return }
        if stopAtWebArea, d.childCount == 0, let bounds = d.bounds, bounds.isEmpty { return }
        guard let bounds = d.bounds, captureRectSafe(bounds) else { truncated = true; return }
        guard clip.intersects(bounds) else { return }
        // AX-only projection drops protected subtrees. Keep their geometry in
        // the separate proof so a whole-region OCR query cannot turn omitted
        // input/draft pixels into captured message text.
        // Chrome exposes its outer content group as value-settable. Identity
        // traversal reads only geometry/roles and the selected WebArea URL,
        // never container values or editable descendants' text.
        let identityContainer = stopAtWebArea && !d.hidden && ["AXGroup", "AXSplitGroup", "AXToolbar", "AXScrollArea", "AXWebArea"].contains(d.role)
        guard captureTextAllowed(d) || identityContainer else { rejected.append(bounds.intersection(clip)); return }
        let clipped = clip.intersection(bounds)
        let index = nodes.count
        nodes.append(ScannedCaptureNode(element: e, descriptor: d, parent: parent, childIndex: childIndex, clip: clipped))
        if stopAtWebArea && d.role == "AXWebArea" { return }
        guard d.childCount >= 0 else { truncated = true; return }
        let limit = min(d.childCount, max(0, 4096 - visited))
        if limit < d.childCount { truncated = true }
        guard limit > 0 else { return }
        guard let children = reader.children(e, limit), children.count == limit else { truncated = true; return }
        for (position, child) in children.enumerated() { visit(child, parent: index, childIndex: position, depth: depth + 1, clip: clipped) }
    }
    visit(root, parent: nil, childIndex: 0, depth: 0, clip: window)
    return (nodes, rejected, truncated || !reader.valid())
}

// No platform message ID, sender, direction or full timestamp is inferred here.
// A leaf bubble's AXDescription is allowed only for the observed exact identifier.
func sanitizedWechatNodes<E>(_ root: E, reader: CaptureAXReader<E>, proof: CaptureWindowProof, masks: [CGRect], deadline: Date, requireUnoccludedRegion: Bool = false) -> (status: String, nodes: [[String: Any]], truncated: Bool) {
    let tree = scanCaptureTree(root, reader: reader, window: proof.bounds, deadline: deadline)
    let lists = tree.nodes.indices.filter { tree.nodes[$0].descriptor.identifier == "chat_message_list" }
    guard lists.count == 1, let list = lists.first, let listBounds = tree.nodes[list].descriptor.bounds,
          proof.bounds.contains(listBounds) else { return ("unsupported", [], tree.truncated) }
    // OCR consumes the entire list rectangle, unlike AX which can withhold
    // individual covered leaves. A covered list must never authorize pixel OCR.
    if requireUnoccludedRegion && (tree.truncated || Date() > deadline ||
        proof.occlusions.contains(where: { $0.intersects(listBounds) }) ||
        tree.rejected.contains(where: { $0.intersects(listBounds) })) { return ("blocked", [], tree.truncated) }
    func underList(_ index: Int) -> Bool {
        var cursor: Int? = index
        while let current = cursor { if current == list { return true }; cursor = tree.nodes[current].parent }
        return false
    }
    let titles: Set<String> = ["current_chat_name_label", "current_chat_count_label"]
    var selected = Set(tree.nodes.indices.filter { underList($0) || titles.contains(tree.nodes[$0].descriptor.identifier) })
    for index in Array(selected) {
        var cursor = tree.nodes[index].parent
        while let current = cursor { selected.insert(current); cursor = tree.nodes[current].parent }
    }
    var output: [[String: Any]] = []; var chars = 0; var truncated = tree.truncated
    for index in tree.nodes.indices where selected.contains(index) {
        if output.count >= 256 || Date() > deadline { truncated = true; break }
        let n = tree.nodes[index], d = n.descriptor
        guard let bounds = d.bounds else { continue }
        let visible = n.clip.contains(bounds) && !masks.contains(where: { $0.intersects(bounds) }) && !proof.occlusions.contains(where: { $0.intersects(bounds) })
        var result: [String: Any] = ["id": String(index), "role": String(d.role.prefix(300)), "resourceId": d.identifier, "text": "", "bounds": captureRectJSON(bounds)]
        if let parent = n.parent { result["parentId"] = String(parent); result["childIndex"] = n.childIndex }
        let scopedLeaf = d.childCount == 0 && visible && (underList(index) || titles.contains(d.identifier))
        if scopedLeaf && (d.role == "AXStaticText" || d.identifier == "chat_bubble_item_view" || titles.contains(d.identifier)) {
            let value = reader.text(n.element, kAXValueAttribute) ?? reader.text(n.element, kAXTitleAttribute) ?? ""
            if value.utf16.count <= 2000 && chars + value.utf16.count <= 32000 {
                result["text"] = value; chars += value.utf16.count
            } else { truncated = true }
            if value.isEmpty && d.identifier == "chat_bubble_item_view", let description = reader.text(n.element, kAXDescriptionAttribute), !description.isEmpty {
                if description.utf16.count <= 2000 && chars + description.utf16.count <= 32000 { result["description"] = description; chars += description.utf16.count }
                else { truncated = true }
            }
        }
        output.append(result)
    }
    truncated = truncated || !reader.valid() || Date() > deadline
    if requireUnoccludedRegion && truncated { return ("blocked", [], true) }
    return ("ok", output, truncated)
}
func wechatCaptureSnapshot(_ input: Data) -> [String: Any] {
    guard input.count <= 32768, let q = try? JSONSerialization.jsonObject(with: input) as? [String: Any],
          let appId = q["appId"] as? String, appId == "com.tencent.xinWeChat", let pid = q["pid"] as? Int32,
          let masks = q["masks"] as? [[String: Double]], masks.count <= 100 else { return ["status": "blocked"] }
    if q["requireUnoccludedRegion"] != nil && !(q["requireUnoccludedRegion"] is Bool) { return ["status": "blocked"] }
    guard AXIsProcessTrusted() else { return ["status": "permission_required"] }
    guard !captureLocked(), let app = NSWorkspace.shared.frontmostApplication, app.processIdentifier == pid, app.bundleIdentifier == appId else { return ["status": "blocked"] }
    let version = app.bundleURL.flatMap { Bundle(url: $0)?.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String } ?? ""
    guard version == "4.1.15", let versions = q["versions"] as? [String], versions.isEmpty || versions.contains(version) else { return ["status": "unsupported"] }
    let root = AXUIElementCreateApplication(pid); AXUIElementSetMessagingTimeout(root, 0.05)
    guard let window = captureFocusedWindow(root), let proof = captureProof(window, pid) else { return ["status": "unsupported"] }
    var rectangles: [CGRect] = []
    for mask in masks {
        guard let x = mask["x"], let y = mask["y"], let width = mask["width"], let height = mask["height"],
              [x,y,width,height].allSatisfy({ $0.isFinite }), x >= 0, y >= 0, width > 0, height > 0, x + width <= 1, y + height <= 1 else { return ["status": "blocked"] }
        rectangles.append(CGRect(x: proof.screen.minX + x * proof.screen.width, y: proof.screen.minY + y * proof.screen.height, width: width * proof.screen.width, height: height * proof.screen.height))
    }
    let snapshot = sanitizedWechatNodes(window, reader: captureReader(), proof: proof, masks: rectangles, deadline: Date().addingTimeInterval(1), requireUnoccludedRegion: q["requireUnoccludedRegion"] as? Bool == true)
    guard snapshot.status == "ok" else { return ["status": snapshot.status] }
    guard AXIsProcessTrusted(), !captureLocked(), NSWorkspace.shared.frontmostApplication?.processIdentifier == pid,
          let current = captureFocusedWindow(root), CFEqual(window, current), let after = captureProof(current, pid),
          after.windowID == proof.windowID, after.bounds == proof.bounds, after.screen == proof.screen, after.occlusions == proof.occlusions else { return ["status": "stale"] }
    return ["status": "ok", "snapshot": ["appId": appId, "appVersion": version, "activity": "", "observedAt": ISO8601DateFormatter().string(from: Date()), "nodes": snapshot.nodes, "truncated": snapshot.truncated]]
}

struct BrowserCapturePage<E> {
    var element: E
    var url: String
    var viewport: CGRect
}
func browserCapturePage<E>(_ window: E, reader: CaptureAXReader<E>, proof: CaptureWindowProof, deadline: Date, failure: ((String) -> Void)? = nil) -> BrowserCapturePage<E>? {
    guard proof.occlusions.isEmpty else { return nil }
    let tree = scanCaptureTree(window, reader: reader, window: proof.bounds, deadline: deadline, stopAtWebArea: true)
    guard !tree.truncated else { failure?("web_tree_incomplete"); return nil }
    // Traversal stops at each main web area: no page text is read and embedded
    // frame trees cannot become alternative candidates or exhaust the budget.
    let areas = tree.nodes.indices.filter { tree.nodes[$0].descriptor.role == "AXWebArea" }
    guard areas.count == 1, let index = areas.first else { failure?("web_area_ambiguous"); return nil }
    guard let viewport = tree.nodes[index].descriptor.bounds, tree.nodes[index].clip.contains(viewport), proof.bounds.contains(viewport) else { failure?("web_area_geometry"); return nil }
    guard let url = reader.text(tree.nodes[index].element, "AXURL"), url.count <= 2000,
          !url.unicodeScalars.contains(where: { CharacterSet.whitespacesAndNewlines.contains($0) || CharacterSet.controlCharacters.contains($0) }),
          let parsed = URLComponents(string: url), ["http", "https"].contains(parsed.scheme?.lowercased() ?? ""),
          parsed.host?.isEmpty == false, parsed.user == nil, parsed.password == nil, reader.valid(), Date() <= deadline else { failure?("web_url_unavailable"); return nil }
    return BrowserCapturePage(element: tree.nodes[index].element, url: url, viewport: viewport)
}
func browserCaptureContext(_ input: Data) -> [String: Any] {
    guard input.count <= 4096, let q = try? JSONSerialization.jsonObject(with: input) as? [String: Any],
          q["appId"] as? String == "com.google.Chrome", let pid = q["pid"] as? Int32 else { return ["status": "blocked"] }
    guard AXIsProcessTrusted() else { return ["status": "permission_required"] }
    guard !captureLocked(), let app = NSWorkspace.shared.frontmostApplication, app.processIdentifier == pid, app.bundleIdentifier == "com.google.Chrome" else { return ["status": "blocked"] }
    let root = AXUIElementCreateApplication(pid); AXUIElementSetMessagingTimeout(root, 0.05)
    // Chromium enables its native accessibility tree when an assistive client
    // queries the application role. This reads identity, never page content.
    _ = captureAttribute(root, kAXRoleAttribute)
    guard let window = captureFocusedWindow(root), let bounds = captureBounds(window), let windows = captureWindows() else { return ["status": "unsupported", "reason": "focused_window_unavailable"] }
    let title = captureAttribute(window, kAXTitleAttribute) as? String
    let titleSuffix = " - \(app.localizedName ?? "Google Chrome")"
    let screen = CGDisplayBounds(CGMainDisplayID())
    guard let initial = captureWindowProof(windows, pid: pid, focused: bounds, screen: screen, focusedTitle: title, focusedTitleSuffix: titleSuffix) else { return ["status": "unsupported", "reason": "window_identity_ambiguous"] }
    let transparent = captureTransparentDockWindows(windows, before: initial.windowID, within: bounds, screen: screen)
    guard let proof = captureWindowProof(windows, pid: pid, focused: bounds, screen: screen, focusedTitle: title, focusedTitleSuffix: titleSuffix, transparentSystemWindows: transparent), proof.occlusions.isEmpty else { return ["status": "unsupported", "reason": "window_occluded"] }
    let browserWindows = visibleBrowserWindowCount(windows, within: proof.screen, resolveBundle: { NSRunningApplication(processIdentifier: $0)?.bundleIdentifier })
    let reader = captureReader()
    var reason = "web_area_unavailable"
    guard let page = browserCapturePage(window, reader: reader, proof: proof, deadline: Date().addingTimeInterval(1), failure: { reason = $0 }) else { return ["status": "unsupported", "reason": reason] }
    guard let current = captureFocusedWindow(root), let currentBounds = captureBounds(current), let currentWindows = captureWindows() else { return ["status": "stale"] }
    let afterTransparent = captureTransparentDockWindows(currentWindows, before: proof.windowID, within: currentBounds, screen: screen)
    // Alpha acquisition is asynchronous. Re-read focus and the entire relevant
    // stack after it; a new/changed overlay must not escape through an old list.
    guard AXIsProcessTrusted(), !captureLocked(), NSWorkspace.shared.frontmostApplication?.processIdentifier == pid,
          let finalWindow = captureFocusedWindow(root), CFEqual(window, finalWindow), let finalBounds = captureBounds(finalWindow), finalBounds == currentBounds,
          captureAttribute(finalWindow, kAXTitleAttribute) as? String == title, let finalWindows = captureWindows(),
          let requested = captureWindowProof(currentWindows, pid: pid, focused: currentBounds, screen: screen, focusedTitle: title, focusedTitleSuffix: titleSuffix, transparentSystemWindows: afterTransparent),
          let after = captureWindowProof(finalWindows, pid: pid, focused: finalBounds, screen: CGDisplayBounds(CGMainDisplayID()), focusedTitle: title, focusedTitleSuffix: titleSuffix, transparentSystemWindows: afterTransparent),
          requested.stack == after.stack,
          after.windowID == proof.windowID, after.bounds == proof.bounds, after.screen == proof.screen, after.occlusions.isEmpty,
          after.stack == proof.stack,
          visibleBrowserWindowCount(finalWindows, within: after.screen, resolveBundle: { NSRunningApplication(processIdentifier: $0)?.bundleIdentifier }) == browserWindows,
          captureBounds(page.element) == page.viewport, reader.text(page.element, "AXURL") == page.url else { return ["status": "stale"] }
    return ["status": "ok", "appId": "com.google.Chrome", "pid": Int(pid), "url": page.url, "window": captureRectJSON(proof.bounds), "viewport": captureRectJSON(page.viewport), "screen": captureRectJSON(proof.screen), "windowId": proof.windowID, "visibleBrowserWindows": browserWindows]
}
