import Foundation

#if os(iOS)
import UserNotifications
#endif

public struct AttentionPost: Equatable, Sendable {
    public let identifier: String
    public let status: CaptureStatusID
    public let operation: CaptureStatusOperation
    public let text: String
}

/// One local notification per issue: the same needs-action status alerts once
/// while it stays current, and the next occurrence alerts again only after the
/// status left the needs-action set.
public struct AttentionDedup: Codable, Equatable, Sendable {
    public private(set) var notified: CaptureStatusID?

    public init(notified: CaptureStatusID? = nil) {
        self.notified = notified
    }

    public mutating func update(_ status: CaptureStatusRow, platform: CaptureStatusPlatform = .ios) -> AttentionPost? {
        guard let notification = status.notification, notification.platforms.contains(platform) else {
            notified = nil
            return nil
        }
        guard status.id != notified else { return nil }
        notified = status.id
        return AttentionPost(
            identifier: "\(MoteCore.bundleIdentifier).attention.\(status.id.rawValue)",
            status: status.id,
            operation: notification.operation,
            text: notification.titleKey
        )
    }
}

public final class AttentionNotifier {
    private var dedup: AttentionDedup
    private let stateFileURL: URL?
    private let platform: CaptureStatusPlatform
    private let poster: (AttentionPost) -> Void
    private let fileManager: FileManager
    private let lock = NSLock()

    public init(
        stateFileURL: URL? = nil,
        platform: CaptureStatusPlatform = .ios,
        fileManager: FileManager = .default,
        poster: @escaping (AttentionPost) -> Void
    ) {
        self.stateFileURL = stateFileURL
        self.platform = platform
        self.fileManager = fileManager
        self.poster = poster
        self.dedup = Self.load(from: stateFileURL)
    }

    @discardableResult
    public func update(facts: CaptureStatusFacts) -> AttentionPost? {
        update(status: CaptureStatusMapping.status(for: facts))
    }

    @discardableResult
    public func update(status: CaptureStatusRow) -> AttentionPost? {
        lock.lock()
        let previous = dedup
        let post = dedup.update(status, platform: platform)
        if dedup != previous { try? persist() }
        lock.unlock()
        if let post { poster(post) }
        return post
    }

    private static func load(from url: URL?) -> AttentionDedup {
        guard let url, let data = try? Data(contentsOf: url) else { return AttentionDedup() }
        return (try? JSONDecoder().decode(AttentionDedup.self, from: data)) ?? AttentionDedup()
    }

    private func persist() throws {
        guard let stateFileURL else { return }
        try fileManager.createDirectory(at: stateFileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        try encoder.encode(dedup).write(to: stateFileURL, options: .atomic)
    }
}

extension AttentionNotifier {
    public static func appGroupStateFileURL(fileManager: FileManager = .default) -> URL? {
        fileManager.containerURL(forSecurityApplicationGroupIdentifier: MoteCore.appGroupIdentifier)?
            .appendingPathComponent("AttentionNotifications", isDirectory: true)
            .appendingPathComponent("state.json")
    }
}

#if os(iOS)
public enum SystemAttentionPoster {
    public static func post(_ post: AttentionPost) {
        let center = UNUserNotificationCenter.current()
        center.requestAuthorization(options: [.alert, .sound]) { granted, _ in
            guard granted else { return }
            let content = UNMutableNotificationContent()
            content.title = post.text
            content.sound = .default
            content.threadIdentifier = "mote-attention"
            content.userInfo = ["status": post.status.rawValue, "operation": post.operation.rawValue]
            center.add(UNNotificationRequest(identifier: post.identifier, content: content, trigger: nil))
        }
    }
}
#endif
