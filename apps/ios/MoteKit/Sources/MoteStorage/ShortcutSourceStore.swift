import Foundation
import MoteCore

public struct ShortcutSourceReceipt: Codable, Equatable, Sendable {
    public let id: String
    public let title: String
    public let appName: String?
    public let capturedAt: String

    public init(id: String, title: String, appName: String? = nil, capturedAt: String) {
        self.id = id
        self.title = title
        self.appName = appName
        self.capturedAt = capturedAt
    }
}

public struct ShortcutSourceSnapshot: Codable, Equatable, Sendable {
    public var settings: ShortcutSourceSettings
    public var received: [ShortcutSourceReceipt]

    public init(settings: ShortcutSourceSettings = ShortcutSourceSettings(), received: [ShortcutSourceReceipt] = []) {
        self.settings = settings
        self.received = received
    }
}

public final class ShortcutSourceStore: @unchecked Sendable {
    private static let lock = NSLock()
    private let fileURL: URL
    private let fileManager: FileManager

    public init(directoryURL: URL, fileManager: FileManager = .default) {
        self.fileURL = directoryURL.appendingPathComponent("shortcut-sources.json")
        self.fileManager = fileManager
    }

    public func snapshot(for kind: ShortcutSourceKind) throws -> ShortcutSourceSnapshot {
        Self.lock.lock()
        defer { Self.lock.unlock() }
        return try read()[kind.rawValue] ?? ShortcutSourceSnapshot()
    }

    public func saveSettings(_ settings: ShortcutSourceSettings, for kind: ShortcutSourceKind) throws {
        Self.lock.lock()
        defer { Self.lock.unlock() }
        var states = try read()
        var snapshot = states[kind.rawValue] ?? ShortcutSourceSnapshot()
        let setupPhase = snapshot.settings.setupPhase
        snapshot.settings = settings
        snapshot.settings.setupPhase = setupPhase
        states[kind.rawValue] = snapshot
        try write(states)
    }

    public func beginWaiting(for kind: ShortcutSourceKind) throws {
        Self.lock.lock()
        defer { Self.lock.unlock() }
        var states = try read()
        var snapshot = states[kind.rawValue] ?? ShortcutSourceSnapshot()
        snapshot.settings.setupPhase = .waiting
        snapshot.settings.isPaused = false
        states[kind.rawValue] = snapshot
        try write(states)
    }

    public func record(_ receipt: ShortcutSourceReceipt, for kind: ShortcutSourceKind) throws {
        Self.lock.lock()
        defer { Self.lock.unlock() }
        var states = try read()
        var snapshot = states[kind.rawValue] ?? ShortcutSourceSnapshot()
        guard snapshot.settings.setupPhase != .notEnabled else { return }
        snapshot.settings.setupPhase = .enabled
        if !snapshot.received.contains(where: { $0.id == receipt.id }) {
            snapshot.received.insert(receipt, at: 0)
        }
        states[kind.rawValue] = snapshot
        try write(states)
    }

    public func remove(_ kind: ShortcutSourceKind) throws {
        Self.lock.lock()
        defer { Self.lock.unlock() }
        var states = try read()
        states.removeValue(forKey: kind.rawValue)
        try write(states)
    }

    private func read() throws -> [String: ShortcutSourceSnapshot] {
        guard fileManager.fileExists(atPath: fileURL.path) else { return [:] }
        return try JSONDecoder().decode([String: ShortcutSourceSnapshot].self, from: Data(contentsOf: fileURL))
    }

    private func write(_ states: [String: ShortcutSourceSnapshot]) throws {
        try fileManager.createDirectory(at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        try encoder.encode(states).write(to: fileURL, options: .atomic)
    }
}
