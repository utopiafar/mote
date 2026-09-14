import AppKit
import IOKit.ps
import Foundation
import Vision
import ImageIO
import EventKit
import Darwin

func output(_ value: [String: Any]) throws {
    let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    FileHandle.standardOutput.write(data)
}

@main
struct MoteHelper {
static func main() {
do {
    switch CommandLine.arguments.dropFirst().first ?? "" {
    case "installed-apps":
        // Explicit settings picker only. Return app identities, never windows or screen content.
        let manager = FileManager.default
        let roots = [URL(fileURLWithPath: "/Applications"), URL(fileURLWithPath: "/System/Applications"), manager.homeDirectoryForCurrentUser.appendingPathComponent("Applications")]
        var applications: [String: String] = [:]
        let deadline = Date().addingTimeInterval(3)
        for root in roots {
            guard let entries = manager.enumerator(at: root, includingPropertiesForKeys: nil, options: [.skipsHiddenFiles, .skipsPackageDescendants]) else { continue }
            for case let url as URL in entries {
                if Date() > deadline || applications.count >= 2048 { break }
                guard url.pathExtension == "app", let bundle = Bundle(url: url), let id = bundle.bundleIdentifier, !id.isEmpty, id.count <= 256 else { continue }
                let name = (bundle.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String) ?? (bundle.object(forInfoDictionaryKey: "CFBundleName") as? String) ?? url.deletingPathExtension().lastPathComponent
                applications[id] = String(name.prefix(512))
            }
        }
        try output(["applications": applications.map { ["appId": $0.key, "appName": $0.value] }])
    case "calendar-permission", "calendar-list", "calendar-scan":
        let command = CommandLine.arguments[1]
        let store = EKEventStore()
        func fullAccess() -> Bool {
            if #available(macOS 14.0, *) { return EKEventStore.authorizationStatus(for: .event) == .fullAccess }
            return EKEventStore.authorizationStatus(for: .event) == .authorized
        }
        if command == "calendar-permission" && !fullAccess() {
            var completed = false
            // Only this explicit command can trigger TCC. Background scans never request access.
            if #available(macOS 14.0, *) {
                store.requestFullAccessToEvents { _, _ in DispatchQueue.main.async { completed = true } }
            } else {
                store.requestAccess(to: .event) { _, _ in DispatchQueue.main.async { completed = true } }
            }
            let deadline = Date().addingTimeInterval(110)
            while !completed && Date() < deadline { RunLoop.current.run(until: Date().addingTimeInterval(0.05)) }
        }
        guard fullAccess() else { try output(["permission": "required", "calendars": []]); break }
        if command != "calendar-scan" {
            try output(["permission": "granted", "calendars": store.calendars(for: .event).map { ["id": $0.calendarIdentifier, "title": $0.title] }]); break
        }
        let input = FileHandle.standardInput.readDataToEndOfFile()
        guard input.count < 16384,
              let query = try JSONSerialization.jsonObject(with: input) as? [String: Any],
              let calendarID = query["calendarId"] as? String,
              let startValue = query["start"] as? String, let endValue = query["end"] as? String else { throw NSError(domain: "Mote", code: 4) }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let start = formatter.date(from: startValue), let end = formatter.date(from: endValue), end > start,
              end.timeIntervalSince(start) <= 400 * 86400 else { throw NSError(domain: "Mote", code: 4) }
        guard let calendar = store.calendar(withIdentifier: calendarID) else { try output(["permission": "granted", "missingCalendar": true]); break }
        let found = store.events(matching: store.predicateForEvents(withStart: start, end: end, calendars: [calendar]))
        var events: [[String: Any]] = []
        var bytes = 0
        var complete = found.count <= 2000
        for event in found.prefix(2000) {
            let occurrence = event.occurrenceDate.map { formatter.string(from: $0) } ?? ""
            var value: [String: Any] = [
                "id": event.calendarItemIdentifier + ":" + occurrence,
                "title": String((event.title ?? "").prefix(2000)),
                "text": query["includeText"] as? Bool == true ? String((event.notes ?? "").prefix(90000)) : "",
                "start": formatter.string(from: event.startDate), "end": formatter.string(from: event.endDate),
                "allDay": event.isAllDay,
                "status": event.status == .canceled ? "cancelled" : (event.status == .tentative ? "tentative" : "confirmed")
            ]
            if let zone = event.timeZone { value["timeZone"] = zone.identifier }
            if let created = event.creationDate { value["createdAt"] = formatter.string(from: created) }
            if let modified = event.lastModifiedDate { value["modifiedAt"] = formatter.string(from: modified) }
            if query["includeText"] as? Bool == true, let location = event.location { value["text"] = String(((value["text"] as? String ?? "") + "\n" + location).prefix(100000)) }
            bytes += (try JSONSerialization.data(withJSONObject: value)).count
            if bytes > 8 * 1024 * 1024 { complete = false; break }
            events.append(value)
        }
        // Detect permission revocation during the query; never report an empty successful scan.
        if !fullAccess() { try output(["permission": "required", "calendars": []]); break }
        try output(["permission": "granted", "events": events, "complete": complete])
    case "screen-permission":
        // Only the explicit permissions button invokes this. No image or window list is requested.
        try output(["granted": CGRequestScreenCaptureAccess()])
    case "activity":
        // NSWorkspace application identity only: never enumerate windows, titles, or pixels.
        guard let application = NSWorkspace.shared.frontmostApplication,
              let bundleID = application.bundleIdentifier, !bundleID.isEmpty else { throw NSError(domain: "Mote", code: 1) }
        try output(["appId": bundleID, "appName": application.localizedName ?? bundleID, "pid": Int(application.processIdentifier)])
    case "device":
        func systemString(_ key: String) -> String? {
            var size = 0
            guard sysctlbyname(key, nil, &size, nil, 0) == 0, size > 1, size < 1024 else { return nil }
            var bytes = [CChar](repeating: 0, count: size)
            guard sysctlbyname(key, &bytes, &size, nil, 0) == 0 else { return nil }
            return String(cString: bytes)
        }
        let info = ProcessInfo.processInfo
        let version = info.operatingSystemVersion
        var device: [String: Any] = ["osVersion": "\(version.majorVersion).\(version.minorVersion).\(version.patchVersion)", "manufacturer": "Apple"]
        if let build = systemString("kern.osversion") { device["osBuild"] = build }
        if let model = systemString("hw.model") { device["model"] = model }
        var state: [String: Any] = ["powerSave": info.isLowPowerModeEnabled]
        switch info.thermalState {
        case .nominal: state["thermalState"] = "nominal"
        case .fair: state["thermalState"] = "fair"
        case .serious: state["thermalState"] = "serious"
        case .critical: state["thermalState"] = "critical"
        @unknown default: state["thermalState"] = "unknown"
        }
        try output(["device": device, "state": state])
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
        let visible = visibleWindowIdentities(windows, within: primaryBounds) { pid in
            NSRunningApplication(processIdentifier: pid)?.bundleIdentifier
        }
        // Window titles are deliberately never requested or collected.
        try output([
            "appId": bundleID,
            "appName": application.localizedName ?? bundleID,
            "pid": Int(application.processIdentifier),
            "visibleAppIds": visible.ids,
            "unknownVisibleWindows": visible.unknown
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
            if let charging = description[kIOPSIsChargingKey] as? Bool { result["charging"] = charging }
            if let state = description[kIOPSPowerSourceStateKey] as? String {
                if state == kIOPSBatteryPowerValue { result["onBattery"] = true }
                else if state == kIOPSACPowerValue { result["onBattery"] = false }
            }
            break
        }
        try output(result)
    case "qr":
        // Only a user-selected invitation image reaches this command. Never use screen capture.
        let data = FileHandle.standardInput.readDataToEndOfFile()
        guard data.count <= 8 * 1024 * 1024, let source = CGImageSourceCreateWithData(data as CFData, nil),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? Int, let height = properties[kCGImagePropertyPixelHeight] as? Int,
              width > 0, height > 0, width <= 4096, height <= 4096,
              let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { throw NSError(domain: "Mote", code: 5) }
        let request = VNDetectBarcodesRequest(); request.symbologies = [.qr]
        try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
        let payloads = (request.results ?? []).compactMap { $0.payloadStringValue }
        guard payloads.count == 1, payloads[0].utf8.count <= 8192 else { throw NSError(domain: "Mote", code: 5) }
        try output(["payloads": payloads])
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

}
}
