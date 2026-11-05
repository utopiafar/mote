import CryptoKit
import Foundation

public struct IOSNotificationContent: Codable, Equatable, Sendable {
    public let appId: String
    public let appName: String
    public let title: String?
    public let text: String?
    public let category: String?

    public init(appId: String, appName: String, title: String? = nil, text: String? = nil, category: String? = nil) {
        self.appId = appId
        self.appName = appName
        self.title = title
        self.text = text
        self.category = category
    }
}

public enum IOSNotificationCapture {
    public static func make(content: IOSNotificationContent, deviceId: String, deviceName: String,
                            postedAt: String, id: UUID = UUID(), sessionId: UUID = UUID()) throws -> CaptureUpload {
        guard CentralTimestamp.parse(postedAt) != nil else { throw CentralError.invalidRequest }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let digest = SHA256.hash(data: try encoder.encode(content))
        let notificationKey = digest.map { String(format: "%02x", $0) }.joined()
        let notification = NotificationMetadata(action: .posted, notificationKey: notificationKey, postedAt: postedAt,
                                                category: content.category, title: content.title, text: content.text)
        let metadata = RecordMetadata(version: 1, observedAt: postedAt,
                                      collector: CollectorMetadata(method: "shortcuts"), notification: notification,
                                      observation: ObservationMetadata(sessionId: sessionId.uuidString.lowercased(), elapsedRealtimeMs: 0))
        return CaptureUpload(id: id, deviceId: deviceId, deviceName: deviceName, capturedAt: postedAt,
                             source: .notification, appId: content.appId, appName: content.appName,
                             privacy: CapturePrivacy(collection: .content), metadata: metadata)
    }
}
