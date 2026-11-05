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

public enum SendQueueError: Error, Equatable {
    case attachmentTooLarge
}

public final class SendQueue: @unchecked Sendable {
    public static let maximumAttachmentBytes = 50 * 1024 * 1024

    private let fileURL: URL
    private let fileManager: FileManager
    private let lock = NSLock()

    public init(directoryURL: URL, fileManager: FileManager = .default) {
        self.fileURL = directoryURL.appendingPathComponent("queue.json")
        self.fileManager = fileManager
    }

    @discardableResult
    public func enqueue(_ payload: Data, id: String = UUID().uuidString) throws -> SendQueueItem {
        guard payload.count <= Self.maximumAttachmentBytes else { throw SendQueueError.attachmentTooLarge }
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
