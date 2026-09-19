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
    case "calendar-permission", "calendar-list", "calendar-scan", "calendar-create":
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
        if command == "calendar-create" {
            let input = FileHandle.standardInput.readDataToEndOfFile()
            guard input.count < 16384, let q = try JSONSerialization.jsonObject(with: input) as? [String: Any],
                  let id = q["id"] as? String, UUID(uuidString: id) != nil,
                  let calendarID = q["calendarId"] as? String, let calendar = store.calendar(withIdentifier: calendarID), calendar.allowsContentModifications,
                  let title = q["title"] as? String, !title.isEmpty, title.count <= 200,
                  let startValue = q["start"] as? String, let endValue = q["end"] as? String,
                  let zoneValue = q["timeZone"] as? String, let zone = TimeZone(identifier: zoneValue),
                  let allDay = q["allDay"] as? Bool else { throw NSError(domain: "Mote", code: 4) }
            func date(_ value: String) -> Date? {
                if allDay { let f = DateFormatter(); f.locale = Locale(identifier: "en_US_POSIX"); f.timeZone = zone; f.dateFormat = "yyyy-MM-dd"; f.isLenient = false; return f.date(from: value) }
                let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
                return f.date(from: value) ?? ISO8601DateFormatter().date(from: value)
            }
            guard let start = date(startValue), let end = date(endValue), end > start, end.timeIntervalSince(start) <= 366 * 86400 else { throw NSError(domain: "Mote", code: 4) }
            let marker = "[Mote:\(id)]"
            let found = store.events(matching: store.predicateForEvents(withStart: start.addingTimeInterval(-366 * 86400), end: end.addingTimeInterval(366 * 86400), calendars: [calendar])).filter { ($0.notes ?? "").contains(marker) }
            if found.count == 1 { try output(["externalId": found[0].calendarItemIdentifier]); break }
            guard found.isEmpty, q["createAllowed"] as? Bool == true, end > Date() else { throw NSError(domain: "Mote", code: 5) }
            let event = EKEvent(eventStore: store); event.calendar = calendar; event.title = title
            event.startDate = start; event.endDate = end; event.timeZone = zone; event.isAllDay = allDay
            event.location = q["location"] as? String; event.notes = q["description"] as? String
            guard (event.notes ?? "").contains(marker) else { throw NSError(domain: "Mote", code: 4) }
            try store.save(event, span: .thisEvent, commit: true)
            try output(["externalId": event.calendarItemIdentifier]); break
        }
        if command != "calendar-scan" {
            try output(["permission": "granted", "calendars": store.calendars(for: .event).map { ["id": $0.calendarIdentifier, "title": $0.title, "writable": $0.allowsContentModifications] }]); break
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
    case "ui-page":
        // Explicit host opt-in only; never requests permission or mutates the target app.
        let input = FileHandle.standardInput.readDataToEndOfFile()
        guard input.count <= 32768, let q = try JSONSerialization.jsonObject(with: input) as? [String: Any],
              let appId = q["appId"] as? String, let pid = q["pid"] as? Int32,
              let masks = q["masks"] as? [[String: Double]], AXIsProcessTrusted(),
              let app = NSWorkspace.shared.frontmostApplication, app.processIdentifier == pid, app.bundleIdentifier == appId,
              (CGSessionCopyCurrentDictionary() as? [String: Any])?["CGSSessionScreenIsLocked"] as? Bool != true else { try output(["status":"blocked"]); break }
        let version=app.bundleURL.flatMap{Bundle(url:$0)?.object(forInfoDictionaryKey:"CFBundleShortVersionString") as? String} ?? ""
        guard let versions=q["versions"] as? [String], versions.isEmpty || versions.contains(version) else {try output(["status":"unsupported"]);break}
        let root = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(root, 0.05)
        func attr(_ e: AXUIElement, _ key: String) -> CFTypeRef? { var v: CFTypeRef?; guard AXUIElementCopyAttributeValue(e, key as CFString, &v) == .success else { return nil }; return v }
        guard let windowValue = attr(root, kAXFocusedWindowAttribute), CFGetTypeID(windowValue) == AXUIElementGetTypeID() else { try output(["status":"unsupported"]); break }
        let window = unsafeBitCast(windowValue, to: AXUIElement.self)
        func rect(_ e: AXUIElement) -> CGRect? {
            guard let p = attr(e, kAXPositionAttribute), let s = attr(e, kAXSizeAttribute), CFGetTypeID(p) == AXValueGetTypeID(), CFGetTypeID(s) == AXValueGetTypeID() else { return nil }
            var point = CGPoint.zero; var size = CGSize.zero
            guard AXValueGetValue(unsafeBitCast(p, to: AXValue.self), .cgPoint, &point), AXValueGetValue(unsafeBitCast(s, to: AXValue.self), .cgSize, &size), size.width > 0, size.height > 0 else { return nil }
            return CGRect(origin: point, size: size)
        }
        let screenBounds = CGDisplayBounds(CGMainDisplayID())
        guard let windowBounds = rect(window), screenBounds.contains(windowBounds),
              let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly,.excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { try output(["status":"unsupported"]); break }
        var occlusions: [CGRect] = []
        for w in windows {
            if (w[kCGWindowOwnerPID as String] as? Int32) == pid { break }
            if let dict = w[kCGWindowBounds as String] as? NSDictionary, let r = CGRect(dictionaryRepresentation: dict) { occlusions.append(r) }
        }
        let masked = masks.compactMap { m -> CGRect? in
            guard let x=m["x"], let y=m["y"], let w=m["width"], let h=m["height"] else { return nil }
            return CGRect(x:screenBounds.minX+x*screenBounds.width,y:screenBounds.minY+y*screenBounds.height,width:w*screenBounds.width,height:h*screenBounds.height)
        }
        var nodes: [[String: Any]] = []; var count=0; var chars=0; var truncated=false
        let deadline=Date().addingTimeInterval(1)
        func visit(_ e: AXUIElement, _ parent: String?, _ depth: Int) {
            if count>=256 || depth>24 || Date()>deadline { truncated=true; return }; count += 1
            let role=attr(e,kAXRoleAttribute) as? String ?? ""
            let subrole=attr(e,kAXSubroleAttribute) as? String ?? ""
            var editable=DarwinBoolean(false)
            _ = AXUIElementIsAttributeSettable(e,kAXValueAttribute as CFString,&editable)
            if subrole=="AXSecureTextField" || role=="AXTextField" || role=="AXTextArea" || editable.boolValue { return }
            guard let bounds=rect(e), windowBounds.intersects(bounds) else { return }
            let id=String(count)
            var text=""
            if windowBounds.contains(bounds) && !masked.contains(where:{$0.intersects(bounds)}) && !occlusions.contains(where:{$0.intersects(bounds)}) && role=="AXStaticText" {
                text=attr(e,kAXValueAttribute) as? String ?? attr(e,kAXTitleAttribute) as? String ?? ""
                if text.utf16.count>2000 || chars+text.utf16.count>32000 { truncated=true; text="" }
                chars += text.utf16.count
            }
            var node: [String:Any] = ["id":id,"role":String(role.prefix(300)),"resourceId":String((attr(e,kAXIdentifierAttribute) as? String ?? "").prefix(300)),"text":text,"bounds":["x":bounds.minX,"y":bounds.minY,"width":bounds.width,"height":bounds.height]]
            if let parent=parent { node["parentId"]=parent }; nodes.append(node)
            var childCount: CFIndex=0
            if AXUIElementGetAttributeValueCount(e,kAXChildrenAttribute as CFString,&childCount) == .success && childCount>0 {
                var children: CFArray?
                let limit=min(childCount,256-count)
                if limit<childCount {truncated=true}
                if limit>0 && AXUIElementCopyAttributeValues(e,kAXChildrenAttribute as CFString,0,limit,&children) == .success, let children=children as? [AXUIElement] { for child in children {visit(child,id,depth+1)} }
            }
        }
        visit(window,nil,0)
        guard let currentWindow=attr(root,kAXFocusedWindowAttribute), CFEqual(window,currentWindow), rect(window)==windowBounds,
              NSWorkspace.shared.frontmostApplication?.processIdentifier==pid, AXIsProcessTrusted(),
              (CGSessionCopyCurrentDictionary() as? [String: Any])?["CGSSessionScreenIsLocked"] as? Bool != true else { try output(["status":"blocked"]); break }
        try output(["snapshot":["appId":appId,"appVersion":String(version.prefix(300)),"activity":"","nodes":nodes,"truncated":truncated]])
    case "notifications":
        guard AXIsProcessTrusted() else { try output(["available": false, "items": []]); return }
        guard let center = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.notificationcenterui").first else { try output(["available": true, "items": []]); return }
        let root = AXUIElementCreateApplication(center.processIdentifier)
        var nodes = 0
        func strings(_ element: AXUIElement, _ depth: Int) -> [String] {
            nodes += 1
            if depth > 12 || nodes > 1000 { return [] }
            var values: [String] = []
            for key in [kAXTitleAttribute, kAXValueAttribute, kAXDescriptionAttribute] {
                var value: CFTypeRef?
                if AXUIElementCopyAttributeValue(element, key as CFString, &value) == .success, let text = value as? String, !text.isEmpty { values.append(String(text.prefix(2000))) }
            }
            var children: CFTypeRef?
            if AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &children) == .success, let items = children as? [AXUIElement] {
                for child in items.prefix(100) { values += strings(child, depth + 1) }
            }
            return values
        }
        var windows: CFTypeRef?
        var items: [[String: String]] = []
        if AXUIElementCopyAttributeValue(root, kAXWindowsAttribute as CFString, &windows) == .success, let views = windows as? [AXUIElement] {
            for view in views.prefix(20) { let text = strings(view, 0).joined(separator: "\n"); if !text.isEmpty { items.append(["text": String(text.prefix(4000))]) } }
        }
        try output(["available": true, "items": items])
    case "calendar-status":
        let status = EKEventStore.authorizationStatus(for: .event)
        var label = "denied"
        if status == .notDetermined { label = "not-determined" }
        else if status == .authorized { label = "granted" }
        if #available(macOS 14.0, *), status == .fullAccess { label = "granted" }
        try output(["status": label])
    case "activity":
        // NSWorkspace application identity only: never enumerate windows, titles, or pixels.
        let application = NSWorkspace.shared.frontmostApplication
        let identity = foregroundIdentity(bundleID: application?.bundleIdentifier, name: application?.localizedName, pid: application?.processIdentifier)
        try output(["appId": identity.id, "appName": identity.name, "pid": identity.pid])
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
        let application = NSWorkspace.shared.frontmostApplication
        let identity = foregroundIdentity(bundleID: application?.bundleIdentifier, name: application?.localizedName, pid: application?.processIdentifier)
        let primaryBounds = CGDisplayBounds(CGMainDisplayID())
        guard let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else {
            throw NSError(domain: "Mote", code: 3, userInfo: nil)
        }
        let visible = visibleWindowIdentities(windows, within: primaryBounds) { pid in
            NSRunningApplication(processIdentifier: pid)?.bundleIdentifier
        }
        // Window titles are deliberately never requested or collected.
        try output([
            "appId": identity.id,
            "appName": identity.name,
            "pid": identity.pid,
            "visibleAppIds": visible.ids,
            "unknownVisibleWindows": visible.unknown
        ])
    case "power":
        guard let info = IOPSCopyPowerSourcesInfo()?.takeRetainedValue(),
              let sources = IOPSCopyPowerSourcesList(info)?.takeRetainedValue() as? [CFTypeRef] else { try output([:]); break }
        // Desktop Macs have no battery source entries but are externally powered.
        var result: [String: Any] = sources.isEmpty ? ["onBattery": false, "charging": false] : [:]
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
