import Foundation
import MoteCore

public enum MoteStorageError: Error, Equatable {
    case appGroupUnavailable
}

public enum MoteStorage {
    public static let moduleName = "MoteStorage"

    public static func draftStore(fileManager: FileManager = .default) throws -> DraftStore {
        DraftStore(directoryURL: try containerURL(fileManager: fileManager).appendingPathComponent("Draft", isDirectory: true))
    }

    public static func sendQueue(fileManager: FileManager = .default) throws -> SendQueue {
        SendQueue(directoryURL: try containerURL(fileManager: fileManager).appendingPathComponent("SendQueue", isDirectory: true))
    }

    public static func connectionStore(fileManager: FileManager = .default) throws -> ConnectionStore {
        ConnectionStore(directoryURL: try containerURL(fileManager: fileManager).appendingPathComponent("Connection", isDirectory: true))
    }

    private static func containerURL(fileManager: FileManager) throws -> URL {
        guard let url = fileManager.containerURL(forSecurityApplicationGroupIdentifier: MoteCore.appGroupIdentifier) else {
            throw MoteStorageError.appGroupUnavailable
        }
        return url
    }
}

public final class DraftStore {
    private let fileURL: URL
    private let fileManager: FileManager
    private let lock = NSLock()

    public init(directoryURL: URL, fileManager: FileManager = .default) {
        self.fileURL = directoryURL.appendingPathComponent("draft.json")
        self.fileManager = fileManager
    }

    public func read<Draft: Decodable>(_ type: Draft.Type) throws -> Draft? {
        lock.lock()
        defer { lock.unlock() }
        guard fileManager.fileExists(atPath: fileURL.path) else { return nil }
        return try JSONDecoder().decode(type, from: Data(contentsOf: fileURL))
    }

    public func save<Draft: Encodable>(_ draft: Draft) throws {
        lock.lock()
        defer { lock.unlock() }
        try createParentDirectory()
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        try encoder.encode(draft).write(to: fileURL, options: .atomic)
    }

    public func exists() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return fileManager.fileExists(atPath: fileURL.path)
    }

    public func clear() throws {
        lock.lock()
        defer { lock.unlock() }
        guard fileManager.fileExists(atPath: fileURL.path) else { return }
        try fileManager.removeItem(at: fileURL)
    }

    private func createParentDirectory() throws {
        try fileManager.createDirectory(at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
    }
}

public struct SendQueueItem: Codable, Equatable, Sendable {
    public let id: String
    public let payload: Data

    public init(id: String, payload: Data) {
        self.id = id
        self.payload = payload
    }
}

/// The one saved connection this device uses. Connection setup owns writing it;
/// the home screen only reads whether a connection exists.
public struct StoredConnection: Codable, Equatable, Sendable {
    public let serverUrl: String
    public let token: String
    public let credentialId: String
    public let scope: String

    public init(serverUrl: String, token: String, credentialId: String, scope: String) {
        self.serverUrl = serverUrl
        self.token = token
        self.credentialId = credentialId
        self.scope = scope
    }
}

public final class ConnectionStore {
    private let fileURL: URL
    private let fileManager: FileManager
    private let lock = NSLock()

    public init(directoryURL: URL, fileManager: FileManager = .default) {
        self.fileURL = directoryURL.appendingPathComponent("connection.json")
        self.fileManager = fileManager
    }

    public func read() throws -> StoredConnection? {
        lock.lock()
        defer { lock.unlock() }
        guard fileManager.fileExists(atPath: fileURL.path) else { return nil }
        return try JSONDecoder().decode(StoredConnection.self, from: Data(contentsOf: fileURL))
    }

    public func save(_ connection: StoredConnection) throws {
        lock.lock()
        defer { lock.unlock() }
        try fileManager.createDirectory(at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        try encoder.encode(connection).write(to: fileURL, options: .atomic)
    }

    public func clear() throws {
        lock.lock()
        defer { lock.unlock() }
        guard fileManager.fileExists(atPath: fileURL.path) else { return }
        try fileManager.removeItem(at: fileURL)
    }
}

public final class SendQueue {
    private let fileURL: URL
    private let fileManager: FileManager
    private let lock = NSLock()

    public init(directoryURL: URL, fileManager: FileManager = .default) {
        self.fileURL = directoryURL.appendingPathComponent("queue.json")
        self.fileManager = fileManager
    }

    @discardableResult
    public func enqueue(_ payload: Data, id: String = UUID().uuidString) throws -> SendQueueItem {
        lock.lock()
        defer { lock.unlock() }
        let item = SendQueueItem(id: id, payload: payload)
        try write(try readItems() + [item])
        return item
    }

    public func pending() throws -> [SendQueueItem] {
        lock.lock()
        defer { lock.unlock() }
        return try readItems()
    }

    public func acknowledge(id: String) throws {
        lock.lock()
        defer { lock.unlock() }
        let items = try readItems()
        let remaining = items.filter { $0.id != id }
        if remaining.count != items.count {
            try write(remaining)
        }
    }

    private func readItems() throws -> [SendQueueItem] {
        guard fileManager.fileExists(atPath: fileURL.path) else { return [] }
        return try JSONDecoder().decode([SendQueueItem].self, from: Data(contentsOf: fileURL))
    }

    private func write(_ items: [SendQueueItem]) throws {
        try fileManager.createDirectory(at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        try encoder.encode(items).write(to: fileURL, options: .atomic)
    }
}
