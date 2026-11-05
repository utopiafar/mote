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

    public static func editorDraftStore(fileManager: FileManager = .default) throws -> EditorDraftStore {
        EditorDraftStore(directoryURL: try containerURL(fileManager: fileManager).appendingPathComponent("Draft", isDirectory: true))
    }

    public static func sendQueue(fileManager: FileManager = .default) throws -> SendQueue {
        SendQueue(directoryURL: try containerURL(fileManager: fileManager).appendingPathComponent("SendQueue", isDirectory: true))
    }

    public static func connectionStore(fileManager: FileManager = .default) throws -> ConnectionStore {
        #if DEBUG && targetEnvironment(simulator)
        if let service = ProcessInfo.processInfo.environment["MOTE_TEST_CONNECTION_SERVICE"] {
            let root = try fileManager.url(for: .applicationSupportDirectory, in: .userDomainMask,
                                           appropriateFor: nil, create: true)
            return ConnectionStore(directoryURL: root.appendingPathComponent("UITestConnection-\(service)", isDirectory: true),
                                   fileManager: fileManager)
        }
        #endif
        return ConnectionStore(directoryURL: try containerURL(fileManager: fileManager).appendingPathComponent("Connection", isDirectory: true))
    }

    private static func containerURL(fileManager: FileManager) throws -> URL {
        if let url = fileManager.containerURL(forSecurityApplicationGroupIdentifier: MoteCore.appGroupIdentifier) {
            return url
        }
        #if targetEnvironment(simulator)
        return fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Shared", isDirectory: true)
        #else
        throw MoteStorageError.appGroupUnavailable
        #endif
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
    public let deviceName: String?
    public let connectedAt: Date?

    public init(
        serverUrl: String,
        token: String,
        credentialId: String,
        scope: String,
        deviceName: String? = nil,
        connectedAt: Date? = nil
    ) {
        self.serverUrl = serverUrl
        self.token = token
        self.credentialId = credentialId
        self.scope = scope
        self.deviceName = deviceName
        self.connectedAt = connectedAt
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

public enum SendQueueError: Error, Equatable {
    case attachmentTooLarge
    case duplicateID
}

public final class SendQueue: @unchecked Sendable {
    public static let maximumAttachmentBytes = 50 * 1024 * 1024

    // The app delegate and the connection may reopen the same queue independently.
    private static let lock = NSLock()
    public let directoryURL: URL
    private let fileURL: URL
    private let fileManager: FileManager

    public init(directoryURL: URL, fileManager: FileManager = .default) {
        self.directoryURL = directoryURL.standardizedFileURL
        self.fileURL = directoryURL.appendingPathComponent("queue.json")
        self.fileManager = fileManager
    }

    public static func validateAttachment(_ bytes: Data) throws {
        guard bytes.count <= maximumAttachmentBytes else { throw SendQueueError.attachmentTooLarge }
    }

    @discardableResult
    public func enqueue(_ payload: Data, id: String = UUID().uuidString,
                        validatingAttachments attachments: [Data] = []) throws -> SendQueueItem {
        for attachment in attachments { try Self.validateAttachment(attachment) }
        Self.lock.lock()
        defer { Self.lock.unlock() }
        let items = try readItems()
        guard !items.contains(where: { $0.id == id }) else { throw SendQueueError.duplicateID }
        // A previous acknowledgment may have committed just before the process exited.
        let oldBody = bodyURL(id: id)
        if fileManager.fileExists(atPath: oldBody.path) { try fileManager.removeItem(at: oldBody) }
        let item = SendQueueItem(id: id, payload: payload)
        try write(items + [item])
        return item
    }

    public func pending() throws -> [SendQueueItem] {
        Self.lock.lock()
        defer { Self.lock.unlock() }
        return try readItems()
    }

    public func acknowledge(id: String) throws {
        Self.lock.lock()
        defer { Self.lock.unlock() }
        let items = try readItems()
        let remaining = items.filter { $0.id != id }
        if remaining.count != items.count {
            try write(remaining)
        }
        let body = bodyURL(id: id)
        if fileManager.fileExists(atPath: body.path) { try fileManager.removeItem(at: body) }
    }

    /// Returns nil if a completion or reconciliation already acknowledged the item.
    public func bodyFile(for item: SendQueueItem) throws -> URL? {
        Self.lock.lock()
        defer { Self.lock.unlock() }
        guard try readItems().contains(item) else { return nil }
        let url = bodyURL(id: item.id)
        if !fileManager.fileExists(atPath: url.path) {
            try fileManager.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try item.payload.write(to: url, options: .atomic)
        }
        return url
    }

    /// Recover from a process exit between writing the acknowledgment and deleting its body.
    public func removeAcknowledgedBodies() throws {
        Self.lock.lock()
        defer { Self.lock.unlock() }
        let directory = directoryURL.appendingPathComponent("Bodies", isDirectory: true)
        guard fileManager.fileExists(atPath: directory.path) else { return }
        let retained = Set(try readItems().map { bodyURL(id: $0.id).lastPathComponent })
        for url in try fileManager.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
        where !retained.contains(url.lastPathComponent) {
            try fileManager.removeItem(at: url)
        }
    }

    private func bodyURL(id: String) -> URL {
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_"))
        let name = id.addingPercentEncoding(withAllowedCharacters: allowed) ?? ""
        return directoryURL.appendingPathComponent("Bodies", isDirectory: true)
            .appendingPathComponent(name + ".json", isDirectory: false)
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
