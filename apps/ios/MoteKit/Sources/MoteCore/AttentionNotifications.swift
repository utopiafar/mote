import Foundation

#if os(iOS)
import UserNotifications
#endif

public struct AttentionPost: Equatable, Sendable {
    public let identifier: String
    public let status: CaptureStatusID
    public let operation: CaptureStatusOperation
    /// Notification title.
    public let text: String
    /// Notification body line; empty when the status has no detail to show.
    public let body: String
}

/// Values the notification bodies need beyond the status table itself.
public struct AttentionContext: Equatable, Sendable {
    /// Central host name only, never a scheme or path.
    public let centralHost: String?
    /// Names of the sources still waiting for capture permission.
    public let waitingSources: [String]

    public init(centralHost: String? = nil, waitingSources: [String] = []) {
        self.centralHost = centralHost
        self.waitingSources = waitingSources
    }

    /// Builds the context from the saved Central endpoint, keeping only its host.
    public init(centralEndpoint: String, waitingSources: [String] = []) {
        self.centralHost = URLComponents(string: centralEndpoint)?.host
        self.waitingSources = waitingSources
    }
}

/// One local notification per issue: the same needs-action status alerts once
/// while it stays current, and the next occurrence alerts again only after the
/// status left the needs-action set.
public struct AttentionDedup: Codable, Equatable, Sendable {
    public private(set) var notified: CaptureStatusID?

    public init(notified: CaptureStatusID? = nil) {
        self.notified = notified
    }

    public mutating func update(
        _ status: CaptureStatusRow,
        platform: CaptureStatusPlatform = .ios,
        context: AttentionContext = AttentionContext()
    ) -> AttentionPost? {
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
            text: notification.titleKey,
            body: Self.body(for: status.id, context: context)
        )
    }

    private static func body(for status: CaptureStatusID, context: AttentionContext) -> String {
        switch status {
        case .reconnect:
            return context.centralHost ?? ""
        case .storageFull:
            return "新的记录暂时无法保存"
        case .permission:
            return context.waitingSources.joined(separator: "、")
        case .sendAttention:
            return "发送失败"
        default:
            return ""
        }
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
    public func update(facts: CaptureStatusFacts, context: AttentionContext = AttentionContext()) -> AttentionPost? {
        update(status: CaptureStatusMapping.status(for: facts), context: context)
    }

    @discardableResult
    public func update(status: CaptureStatusRow, context: AttentionContext = AttentionContext()) -> AttentionPost? {
        lock.lock()
        let previous = dedup
        let post = dedup.update(status, platform: platform, context: context)
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
            content.body = post.body
            content.sound = .default
            content.threadIdentifier = "mote-attention"
            content.userInfo = ["status": post.status.rawValue, "operation": post.operation.rawValue]
            center.add(UNNotificationRequest(identifier: post.identifier, content: content, trigger: nil))
        }
    }
}
#endif
