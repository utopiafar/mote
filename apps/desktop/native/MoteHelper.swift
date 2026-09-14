import AppKit
import IOKit.ps
import Foundation
import Vision
import ImageIO
import EventKit

func output(_ value: [String: Any]) throws {
    let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    FileHandle.standardOutput.write(data)
}

do {
    switch CommandLine.arguments.dropFirst().first ?? "" {
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
            if let modified = event.lastModifiedDate { value["modifiedAt"] = formatter.string(from: modified) }
            if query["includeText"] as? Bool == true, let location = event.location { value["text"] = String(((value["text"] as? String ?? "") + "\n" + location).prefix(100000)) }
            bytes += (try JSONSerialization.data(withJSONObject: value)).count
            if bytes > 8 * 1024 * 1024 { complete = false; break }
            events.append(value)
        }
        // Detect permission revocation during the query; never report an empty successful scan.
        if !fullAccess() { try output(["permission": "required", "calendars": []]); break }
        try output(["permission": "granted", "events": events, "complete": complete])
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
