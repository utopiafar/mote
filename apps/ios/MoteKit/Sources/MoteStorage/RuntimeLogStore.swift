import Foundation

public enum RuntimeLogLevel: String, CaseIterable, Codable, Sendable {
    case debug, info, warn, error
    var priority: Int { Self.allCases.firstIndex(of: self)! }
}

public struct RuntimeLogPolicy: Codable, Equatable, Sendable {
    public var enabled: Bool
    public var level: RuntimeLogLevel
    public init(enabled: Bool, level: RuntimeLogLevel) { self.enabled = enabled; self.level = level }
}

/// Fixed codes only; no captured content, request URLs, tokens or exception messages.
public enum RuntimeLogEvent: String, Sendable {
    case appStarted = "app.started", requestStarted = "request.started", requestCompleted = "request.completed"
    case requestFailed = "request.failed", sendStarted = "send.started", sendCompleted = "send.completed"
    case sendFailed = "send.failed", backgroundRestoreFailed = "background.restore_failed"
    case backgroundUploadCompleted = "background.upload_completed", backgroundUploadFailed = "background.upload_failed"
    var level: RuntimeLogLevel {
        switch self {
        case .requestStarted, .sendStarted: .debug
        case .appStarted, .requestCompleted, .sendCompleted, .backgroundUploadCompleted: .info
        case .requestFailed, .sendFailed, .backgroundRestoreFailed, .backgroundUploadFailed: .error
        }
    }
}

public final class RuntimeLogStore: @unchecked Sendable {
    private static let lock = NSLock()
    public let directoryURL: URL
    private let maxBytes: Int
    private let development: Bool
    private let manager: FileManager

    public init(directoryURL: URL, development: Bool? = nil, maxBytes: Int = 2 * 1024 * 1024,
                fileManager: FileManager = .default) {
        self.directoryURL = directoryURL
        self.maxBytes = maxBytes
        self.manager = fileManager
        #if DEBUG
        self.development = development ?? true
        #else
        self.development = development ?? false
        #endif
    }

    private var settingsURL: URL { directoryURL.appendingPathComponent("settings.json") }
    private func logURL(_ index: Int) -> URL { directoryURL.appendingPathComponent("mote.\(index).log") }
    private func ensureDirectory() throws {
        try manager.createDirectory(at: directoryURL, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        var url = directoryURL
        var values = URLResourceValues(); values.isExcludedFromBackup = true
        try url.setResourceValues(values)
    }
    private func readPolicyUnlocked() throws -> RuntimeLogPolicy {
        guard manager.fileExists(atPath: settingsURL.path) else {
            return RuntimeLogPolicy(enabled: true, level: development ? .debug : .info)
        }
        return try JSONDecoder().decode(RuntimeLogPolicy.self, from: Data(contentsOf: settingsURL))
    }
    public func readPolicy() throws -> RuntimeLogPolicy { try Self.lock.withLock { try readPolicyUnlocked() } }
    public func savePolicy(_ policy: RuntimeLogPolicy) throws {
        try Self.lock.withLock {
            try ensureDirectory()
            try JSONEncoder().encode(policy).write(to: settingsURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        }
    }
    public func record(_ event: RuntimeLogEvent) throws {
        try Self.lock.withLock {
            let policy = try readPolicyUnlocked()
            guard policy.enabled, event.level.priority >= policy.level.priority else { return }
            let line = "\(ISO8601DateFormatter().string(from: Date())) \(event.level.rawValue.uppercased()) \(event.rawValue)\n"
            let data = Data(line.utf8)
            try ensureDirectory()
            let current = logURL(0)
            let size = (try? manager.attributesOfItem(atPath: current.path)[.size] as? NSNumber)?.intValue ?? 0
            if size + data.count > maxBytes {
                try? manager.removeItem(at: logURL(2))
                for index in stride(from: 1, through: 0, by: -1) where manager.fileExists(atPath: logURL(index).path) {
                    try manager.moveItem(at: logURL(index), to: logURL(index + 1))
                }
            }
            if !manager.fileExists(atPath: current.path) {
                guard manager.createFile(atPath: current.path, contents: nil, attributes: [.posixPermissions: 0o600, .protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]) else {
                    throw CocoaError(.fileWriteUnknown)
                }
            }
            let file = try FileHandle(forWritingTo: current)
            defer { try? file.close() }
            try file.seekToEnd(); try file.write(contentsOf: data)
        }
    }
    public func readLogs() throws -> String {
        try Self.lock.withLock {
            var text = ""
            for index in stride(from: 2, through: 0, by: -1) {
                let path = logURL(index)
                guard manager.fileExists(atPath: path.path) else { continue }
                let size = (try manager.attributesOfItem(atPath: path.path)[.size] as? NSNumber)?.intValue ?? 0
                guard size <= maxBytes + 1024 else { throw CocoaError(.fileReadTooLarge) }
                let bytes = try Data(contentsOf: path)
                guard bytes.count <= maxBytes + 1024 else { throw CocoaError(.fileReadTooLarge) }
                text += String(decoding: bytes, as: UTF8.self)
            }
            return text
        }
    }
}
