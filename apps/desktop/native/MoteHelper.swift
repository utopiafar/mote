import AppKit
import IOKit.ps
import Foundation
import Vision
import ImageIO

func output(_ value: [String: Any]) throws {
    let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    FileHandle.standardOutput.write(data)
}

do {
    switch CommandLine.arguments.dropFirst().first ?? "" {
    case "active":
        guard let application = NSWorkspace.shared.frontmostApplication,
              let bundleID = application.bundleIdentifier,
              !bundleID.isEmpty else {
            throw NSError(domain: "Mote", code: 1, userInfo: nil)
        }
        let primaryBounds = CGDisplayBounds(CGMainDisplayID())
        guard let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else {
            throw NSError(domain: "Mote", code: 3, userInfo: nil)
        }
        var visibleAppIDs = Set<String>()
        var unknownVisibleWindows = false
        for window in windows {
            guard let boundsDictionary = window[kCGWindowBounds as String] as? NSDictionary,
                  let bounds = CGRect(dictionaryRepresentation: boundsDictionary),
                  bounds.width > 1, bounds.height > 1,
                  bounds.intersects(primaryBounds),
                  let pid = window[kCGWindowOwnerPID as String] as? Int32 else { continue }
            let alpha = window[kCGWindowAlpha as String] as? Double ?? 1
            let layer = window[kCGWindowLayer as String] as? Int ?? 0
            if alpha <= 0 || layer < 0 { continue }
            if let owner = NSRunningApplication(processIdentifier: pid), let bundleID = owner.bundleIdentifier {
                visibleAppIDs.insert(bundleID)
            } else if layer == 0 {
                // Unidentified normal application windows make exclusions unverifiable.
                // Nonzero unidentified system layers (cursor/menu/background) are not app windows.
                unknownVisibleWindows = true
            }
        }
        // Window titles are deliberately never requested or collected.
        try output([
            "appId": bundleID,
            "appName": application.localizedName ?? bundleID,
            "pid": Int(application.processIdentifier),
            "visibleAppIds": visibleAppIDs.sorted(),
            "unknownVisibleWindows": unknownVisibleWindows
        ])
    case "power":
        guard let info = IOPSCopyPowerSourcesInfo()?.takeRetainedValue(),
              let sources = IOPSCopyPowerSourcesList(info)?.takeRetainedValue() as? [CFTypeRef] else { try output([:]); break }
        var result: [String: Any] = [:]
        for source in sources {
            guard let description = IOPSGetPowerSourceDescription(info, source)?.takeUnretainedValue() as? [String: Any],
                  let current = description[kIOPSCurrentCapacityKey] as? Int,
                  let maximum = description[kIOPSMaxCapacityKey] as? Int, maximum > 0 else { continue }
            result["batteryPercent"] = min(100, max(0, Double(current) / Double(maximum) * 100))
            result["charging"] = description[kIOPSIsChargingKey] as? Bool ?? false
            result["onBattery"] = (description[kIOPSPowerSourceStateKey] as? String) == kIOPSBatteryPowerValue
            break
        }
        try output(result)
    case "ocr":
        // Input is the final masked JPEG over stdin. No temporary screenshots are written.
        let data = FileHandle.standardInput.readDataToEndOfFile()
        guard data.count <= 8 * 1024 * 1024,
              let source = CGImageSourceCreateWithData(data as CFData, nil),
              let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
            throw NSError(domain: "Mote", code: 2, userInfo: nil)
        }
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.recognitionLanguages = ["zh-Hans", "en-US"]
        request.usesLanguageCorrection = true
        if #available(macOS 13.0, *) { request.automaticallyDetectsLanguage = true }
        let handler = VNImageRequestHandler(cgImage: image, options: [:])
        try handler.perform([request])
        let lines = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }
        try output(["text": String(lines.joined(separator: "\n").prefix(100000))])
    default:
        try output(["error": "Expected active, power or ocr"])
        exit(2)
    }
} catch {
    // Never print recognized text, screenshots, or application metadata to stderr.
    FileHandle.standardError.write(Data("Mote native helper failed\n".utf8))
    exit(1)
}
