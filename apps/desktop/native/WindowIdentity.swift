import AppKit

// Pure window-description policy: no OS query and no title reads. Layer is deliberately irrelevant.
func visibleWindowIdentities(_ windows: [[String: Any]], within primaryBounds: CGRect, resolveBundle: (Int32) -> String?) -> (ids: [String], unknown: Bool) {
    var ids = Set<String>()
    var unknown = false
    for window in windows {
        guard let dictionary = window[kCGWindowBounds as String] as? NSDictionary,
              let bounds = CGRect(dictionaryRepresentation: dictionary) else { unknown = true; continue }
        let alpha = window[kCGWindowAlpha as String] as? Double ?? 1
        if bounds.width <= 0 || bounds.height <= 0 || !bounds.intersects(primaryBounds) || alpha <= 0 { continue }
        guard let pid = window[kCGWindowOwnerPID as String] as? Int32,
              let bundleID = resolveBundle(pid), !bundleID.isEmpty else { unknown = true; continue }
        ids.insert(bundleID)
    }
    return (ids.sorted(), unknown)
}
