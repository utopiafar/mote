import AppKit
import ScreenCaptureKit

// This is visibility evidence, never a source image. Inspect only alpha from
// the verified OS Dock surface; never acquire an unselected application image.
func captureAlphaIsClear(_ image: CGImage, within region: CGRect, surface: CGRect, scale: CGFloat) -> Bool {
    guard captureRectSafe(surface), scale.isFinite, scale >= 1, scale <= 4,
          scale.rounded() == scale, image.bitsPerComponent == 8, image.bitsPerPixel == 32,
          [.premultipliedFirst, .first].contains(image.alphaInfo),
          image.bitmapInfo.intersection(.byteOrderMask) == .byteOrder32Little,
          CGFloat(image.width) == surface.width * scale, CGFloat(image.height) == surface.height * scale,
          image.width <= 8192, image.height <= 8192, image.width * image.height <= 16_777_216,
          image.bytesPerRow >= image.width * 4, let data = image.dataProvider?.data,
          CFDataGetLength(data) >= image.bytesPerRow * image.height, let bytes = CFDataGetBytePtr(data) else { return false }
    let overlap = surface.intersection(region)
    guard !overlap.isNull, !overlap.isEmpty else { return true }
    let left = max(0, Int(floor((overlap.minX - surface.minX) * scale)))
    let right = min(image.width, Int(ceil((overlap.maxX - surface.minX) * scale)))
    let top = max(0, Int(floor((overlap.minY - surface.minY) * scale)))
    let bottom = min(image.height, Int(ceil((overlap.maxY - surface.minY) * scale)))
    for y in top..<bottom {
        for x in left..<right where bytes[y * image.bytesPerRow + x * 4 + 3] != 0 { return false }
    }
    return true
}

private final class CaptureReply<Value> {
    private let lock = NSLock()
    private var finished = false
    private var value: Value?
    func complete(_ next: Value?) { lock.lock(); value = next; finished = true; lock.unlock() }
    func read() -> (Bool, Value?) { lock.lock(); defer { lock.unlock() }; return (finished, value) }
}
private func captureAwait<Value>(_ start: (@escaping (Value?) -> Void) -> Void) -> Value? {
    let reply = CaptureReply<Value>()
    start { reply.complete($0) }
    let deadline = Date().addingTimeInterval(0.75)
    while Date() < deadline {
        let (finished, value) = reply.read()
        if finished { return value }
        RunLoop.current.run(until: min(deadline, Date().addingTimeInterval(0.005)))
    }
    return nil
}

func captureTransparentDockWindows(_ windows: [[String: Any]], before windowID: Int, within region: CGRect, screen: CGRect) -> Set<Int> {
    guard #available(macOS 14.0, *), CGPreflightScreenCaptureAccess(),
          let target = windows.firstIndex(where: { $0[kCGWindowNumber as String] as? Int == windowID }) else { return [] }
    let candidates = windows.prefix(target).filter { window in
        guard window[kCGWindowName as String] as? String == "Dock",
              window[kCGWindowLayer as String] as? Int == 20,
              let pid = window[kCGWindowOwnerPID as String] as? Int32,
              let app = NSRunningApplication(processIdentifier: pid), app.bundleIdentifier == "com.apple.dock",
              app.bundleURL?.standardizedFileURL.path == "/System/Library/CoreServices/Dock.app",
              let raw = window[kCGWindowBounds as String] as? NSDictionary,
              let bounds = CGRect(dictionaryRepresentation: raw), bounds == screen,
              bounds.intersects(region), (window[kCGWindowAlpha as String] as? Double ?? 1) > 0 else { return false }
        return true
    }
    guard !candidates.isEmpty, candidates.count <= 2 else { return [] }
    // Initialize AppKit on this helper's main thread before ScreenCaptureKit.
    _ = NSApplication.shared
    guard let content: SCShareableContent = captureAwait({ done in
        SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: true) { value, error in done(error == nil ? value : nil) }
    }) else { return [] }
    var transparent = Set<Int>()
    for candidate in candidates {
        guard let number = candidate[kCGWindowNumber as String] as? Int,
              let pid = candidate[kCGWindowOwnerPID as String] as? Int32 else { continue }
        let matching = content.windows.filter { Int($0.windowID) == number && $0.owningApplication?.processID == pid &&
            $0.owningApplication?.bundleIdentifier == "com.apple.dock" && $0.title == "Dock" && $0.windowLayer == 20 && $0.isOnScreen && $0.frame == screen }
        guard matching.count == 1, let window = matching.first else { continue }
        let filter = SCContentFilter(desktopIndependentWindow: window)
        let scale = CGFloat(filter.pointPixelScale)
        guard filter.contentRect == screen, scale.isFinite, scale >= 1, scale <= 4, scale.rounded() == scale else { continue }
        let width = screen.width * scale, height = screen.height * scale
        guard width > 0, height > 0, width <= 8192, height <= 8192, width * height <= 16_777_216 else { continue }
        let config = SCStreamConfiguration()
        config.width = Int(width); config.height = Int(height)
        config.sourceRect = CGRect(origin: .zero, size: screen.size)
        config.destinationRect = CGRect(x: 0, y: 0, width: width, height: height)
        config.showsCursor = false; config.shouldBeOpaque = false
        // Keep shadows: even one painted alpha byte in the overlap rejects.
        guard let image: CGImage = captureAwait({ done in
            SCScreenshotManager.captureImage(contentFilter: filter, configuration: config) { value, error in done(error == nil ? value : nil) }
        }), captureAlphaIsClear(image, within: region, surface: screen, scale: scale) else { continue }
        transparent.insert(number)
    }
    return transparent
}
