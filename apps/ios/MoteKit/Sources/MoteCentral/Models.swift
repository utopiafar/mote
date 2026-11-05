import Foundation

public enum CentralPlatform: String, Codable, Sendable {
    case macos, windows, linux, android, ios, `import`
}

public enum CaptureSource: String, Codable, Sendable {
    case screen, uiPage = "ui_page", activity, media, notification, deviceEvent = "device_event"
    case file, note, calendar, event, message, metric, memory
}

public enum JSONValue: Codable, Equatable, Sendable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object([String: JSONValue])
    case array([JSONValue])
    case null

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() { self = .null }
        else if let value = try? container.decode(Bool.self) { self = .bool(value) }
        else if let value = try? container.decode(Double.self) { self = .number(value) }
        else if let value = try? container.decode(String.self) { self = .string(value) }
        else if let value = try? container.decode([String: JSONValue].self) { self = .object(value) }
        else { self = .array(try container.decode([JSONValue].self)) }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .bool(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .null: try container.encodeNil()
        }
    }
}

public struct ConnectionInvitation: Codable, Equatable, Sendable {
    public static let maximumInputBytes = 8192

    public let format: String
    public let version: Int
    public let serverUrl: String
    public let code: String
    public let expiresAt: String

    public init(format: String = "mote.connection", version: Int = 1, serverUrl: String, code: String, expiresAt: String) {
        self.format = format
        self.version = version
        self.serverUrl = serverUrl
        self.code = code
        self.expiresAt = expiresAt
    }

    public static func parse(_ input: String, now: Date = Date()) throws -> ConnectionInvitation {
        guard input.utf8.count <= maximumInputBytes else { throw CentralError.invalidInvitation }
        var text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.hasPrefix("mote:") {
            let pattern = #"^mote://connect\?data=([A-Za-z0-9_-]+)$"#
            guard let match = text.range(of: pattern, options: .regularExpression) else {
                throw CentralError.invalidInvitation
            }
            let encoded = String(text[match].dropFirst("mote://connect?data=".count))
            var base64 = encoded.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
            base64 += String(repeating: "=", count: (4 - base64.count % 4) % 4)
            guard let bytes = Data(base64Encoded: base64),
                  let decoded = String(data: bytes, encoding: .utf8),
                  bytes.base64EncodedString().replacingOccurrences(of: "+", with: "-")
                    .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "") == encoded
            else { throw CentralError.invalidInvitation }
            text = decoded
        }
        guard text.utf8.count <= maximumInputBytes, let data = text.data(using: .utf8) else {
            throw CentralError.invalidInvitation
        }
        let object = try JSONSerialization.jsonObject(with: data)
        guard let dictionary = object as? [String: Any],
              Set(dictionary.keys) == ["format", "version", "serverUrl", "code", "expiresAt"]
        else { throw CentralError.invalidInvitation }
        let invitation = try JSONDecoder().decode(ConnectionInvitation.self, from: data)
        guard invitation.format == "mote.connection", invitation.version == 1,
              invitation.code.range(of: #"^[A-Za-z0-9_-]{43}$"#, options: .regularExpression) != nil,
              invitation.expiresAt.range(of: #"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$"#, options: .regularExpression) != nil,
              let expires = CentralTimestamp.parse(invitation.expiresAt)
        else { throw CentralError.invalidInvitation }
        guard expires > now else { throw CentralError.invitationExpired }
        guard expires <= now.addingTimeInterval(24 * 3600) else { throw CentralError.invalidInvitation }
        return ConnectionInvitation(serverUrl: try CentralEndpoint.normalize(invitation.serverUrl), code: invitation.code, expiresAt: invitation.expiresAt)
    }
}

public enum CentralEndpoint {
    public static func normalize(_ value: String) throws -> String {
        guard !value.isEmpty, value.count <= 2048, value == value.trimmingCharacters(in: .whitespacesAndNewlines),
              !value.contains(where: { $0.isWhitespace || $0 == "\\" }),
              !value.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) })
        else { throw CentralError.invalidEndpoint }
        guard let components = URLComponents(string: value), let scheme = components.scheme?.lowercased(),
              let host = components.host, !host.isEmpty, components.user == nil, components.password == nil,
              components.query == nil, components.fragment == nil, components.path.isEmpty || components.path == "/"
        else { throw CentralError.invalidEndpoint }
        let local = ["localhost", "127.0.0.1", "::1"].contains(host.lowercased())
        guard scheme == "https" || scheme == "http" && local else { throw CentralError.invalidEndpoint }
        var origin = components
        origin.path = ""
        guard let result = origin.string else { throw CentralError.invalidEndpoint }
        return result
    }
}

public enum CentralTimestamp {
    public static func parse(_ value: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: value) { return date }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: value)
    }

    public static func string(_ date: Date = Date()) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }
}

public struct DeviceCredential: Codable, Equatable, Sendable {
    public let token: String
    public let credentialId: String
    public let scope: String
    public let serverUrl: String
}

public struct ConnectionIdentity: Codable, Equatable, Sendable {
    public struct Credential: Codable, Equatable, Sendable {
        public let id: String
        public let scope: String
        public let label: String
        public let serverUrl: String?
        public let deviceId: String?
        public let deviceName: String?
        public let platform: CentralPlatform?
    }
    public struct Node: Codable, Equatable, Sendable {
        public let version: String
        public let profile: String
        public let `protocol`: ProtocolRange
    }
    public struct Capabilities: Codable, Equatable, Sendable {
        public let ingest: Bool
        public let ingressVersion: Int
        public let ownSources: Bool
        public let archiveRead: Bool
    }
    public let credential: Credential
    public let node: Node
    public let capabilities: Capabilities
}

public struct ProtocolRange: Codable, Equatable, Sendable {
    public let min: Int
    public let max: Int

    public func supportsMote() -> Bool {
        min >= 1 && max >= min && Swift.max(min, 1) <= Swift.min(max, 1)
    }
}

public enum HeartbeatStatus: String, Codable, Sendable {
    case capturing, paused, permissionRequired = "permission_required", error, offline
}

public struct HeartbeatSync: Codable, Equatable, Sendable {
    public enum Mode: String, Codable, Sendable { case realtime, interval, batch, manual }
    public enum State: String, Codable, Sendable { case unconfigured, idle, waiting, uploading, error, manual }

    public let mode: Mode
    public let state: State
    public let intervalMinutes: Int
    public let batchSize: Int
    public let pendingRecords: Int
    public let blockedRecords: Int?
    public let awaitingOcrRecords: Int?
    public let retainedRecords: Int?
    public let lastUploadAt: String?
    public let nextUploadAt: String?

    public init(mode: Mode, state: State, intervalMinutes: Int, batchSize: Int, pendingRecords: Int,
                blockedRecords: Int? = nil, awaitingOcrRecords: Int? = nil, retainedRecords: Int? = nil,
                lastUploadAt: String? = nil, nextUploadAt: String? = nil) {
        self.mode = mode
        self.state = state
        self.intervalMinutes = intervalMinutes
        self.batchSize = batchSize
        self.pendingRecords = pendingRecords
        self.blockedRecords = blockedRecords
        self.awaitingOcrRecords = awaitingOcrRecords
        self.retainedRecords = retainedRecords
        self.lastUploadAt = lastUploadAt
        self.nextUploadAt = nextUploadAt
    }
}

public struct Heartbeat: Codable, Equatable, Sendable {
    public let deviceId: String
    public let deviceName: String
    public let platform: CentralPlatform
    public let status: HeartbeatStatus
    public let queueDepth: Int
    public let lastCaptureAt: String?
    public let error: String?
    public let metadata: RecordMetadata?
    public let sync: HeartbeatSync?

    public init(deviceId: String, deviceName: String, status: HeartbeatStatus, queueDepth: Int,
                lastCaptureAt: String? = nil, error: String? = nil, metadata: RecordMetadata? = nil, sync: HeartbeatSync? = nil) {
        self.deviceId = deviceId
        self.deviceName = deviceName
        self.platform = .ios
        self.status = status
        self.queueDepth = queueDepth
        self.lastCaptureAt = lastCaptureAt
        self.error = error
        self.metadata = metadata
        self.sync = sync
    }
}

public struct HeartbeatAcknowledgement: Codable, Equatable, Sendable {
    public let ok: Bool
}

public struct CollectorMetadata: Codable, Equatable, Sendable {
    public let version: String?
    public let method: String

    public init(version: String? = nil, method: String) {
        self.version = version
        self.method = method
    }
}

public enum NotificationAction: String, Codable, Sendable {
    case posted, updated, removed
}

public struct NotificationMetadata: Codable, Equatable, Sendable {
    public let action: NotificationAction
    public let notificationKey: String
    public let postedAt: String
    public let ongoing: Bool
    public let groupSummary: Bool
    public let category: String?
    public let channelId: String?
    public let title: String?
    public let text: String?
    public let bigText: String?
    public let subText: String?
    public let textLines: [String]?

    public init(action: NotificationAction, notificationKey: String, postedAt: String, ongoing: Bool = false,
                groupSummary: Bool = false, category: String? = nil, channelId: String? = nil,
                title: String? = nil, text: String? = nil, bigText: String? = nil,
                subText: String? = nil, textLines: [String]? = nil) {
        self.action = action
        self.notificationKey = notificationKey
        self.postedAt = postedAt
        self.ongoing = ongoing
        self.groupSummary = groupSummary
        self.category = category
        self.channelId = channelId
        self.title = title
        self.text = text
        self.bigText = bigText
        self.subText = subText
        self.textLines = textLines
    }
}

public struct ObservationMetadata: Codable, Equatable, Sendable {
    public let sessionId: String
    public let elapsedRealtimeMs: Int

    public init(sessionId: String, elapsedRealtimeMs: Int) {
        self.sessionId = sessionId
        self.elapsedRealtimeMs = elapsedRealtimeMs
    }
}

public struct RecordMetadata: Codable, Equatable, Sendable {
    public let version: Int?
    public let observedAt: String?
    public let collector: CollectorMetadata?
    public let notification: NotificationMetadata?
    public let observation: ObservationMetadata?

    public init(version: Int? = nil, observedAt: String? = nil, collector: CollectorMetadata? = nil,
                notification: NotificationMetadata? = nil, observation: ObservationMetadata? = nil) {
        self.version = version
        self.observedAt = observedAt
        self.collector = collector
        self.notification = notification
        self.observation = observation
    }
}

public struct CapturePrivacy: Codable, Equatable, Sendable {
    public enum Collection: String, Codable, Sendable { case content, activity }

    public let excluded: Bool
    public let redacted: Bool
    public let mode: String
    public let reason: String?
    public let collection: Collection?

    public init(excluded: Bool = false, redacted: Bool = false, mode: String = "none",
                reason: String? = nil, collection: Collection? = nil) {
        self.excluded = excluded
        self.redacted = redacted
        self.mode = mode
        self.reason = reason
        self.collection = collection
    }
}

public struct CaptureUpload: Codable, Equatable, Sendable {
    public let id: String
    public let deviceId: String
    public let deviceName: String
    public let platform: CentralPlatform
    public let capturedAt: String
    public let durationMs: Int
    public let source: CaptureSource
    public let appId: String?
    public let appName: String?
    public let windowTitle: String?
    public let ocrText: String?
    public let imageBase64: String?
    public let mood: String?
    public let privacy: CapturePrivacy
    public let metadata: RecordMetadata?

    public init(id: UUID = UUID(), deviceId: String, deviceName: String, capturedAt: String,
                source: CaptureSource, appId: String? = nil, appName: String? = nil,
                windowTitle: String? = nil, ocrText: String? = nil, imageBase64: String? = nil,
                mood: String? = nil, privacy: CapturePrivacy = CapturePrivacy(), metadata: RecordMetadata? = nil) {
        self.id = id.uuidString.lowercased()
        self.deviceId = deviceId
        self.deviceName = deviceName
        self.platform = .ios
        self.capturedAt = capturedAt
        self.durationMs = 0
        self.source = source
        self.appId = appId
        self.appName = appName
        self.windowTitle = windowTitle
        self.ocrText = ocrText
        self.imageBase64 = imageBase64
        self.mood = mood
        self.privacy = privacy
        self.metadata = metadata
    }
}

public struct CaptureReceipt: Codable, Equatable, Sendable {
    public let id: String
    public let duplicate: Bool
    public let blobHash: String?
    public let indexingStatus: String

    public init(id: String, duplicate: Bool, blobHash: String? = nil, indexingStatus: String = "pending") {
        self.id = id
        self.duplicate = duplicate
        self.blobHash = blobHash
        self.indexingStatus = indexingStatus
    }
}

public struct CaptureReconciliationRequest: Codable, Equatable, Sendable {
    public let deviceId: String
    public let ids: [String]

    public init(deviceId: String, ids: [String]) {
        self.deviceId = deviceId
        self.ids = ids
    }
}

public struct CaptureReconciliation: Codable, Equatable, Sendable {
    public enum State: String, Codable, Sendable {
        case present, unavailable
    }

    public struct Item: Codable, Equatable, Sendable {
        public let id: String
        public let state: State

        public init(id: String, state: State) {
            self.id = id
            self.state = state
        }
    }

    public let checkedAt: String
    public let items: [Item]

    public init(checkedAt: String, items: [Item]) {
        self.checkedAt = checkedAt
        self.items = items
    }
}

public struct OCRState: Codable, Equatable, Sendable {
    public let status: String
    public let reason: String?
    public let updatedAt: String?
}

public struct CapturePreview: Codable, Equatable, Sendable {
    public let id: String
    public let capturedAt: String
    public let deviceId: String
    public let deviceName: String
    public let platform: CentralPlatform
    public let source: CaptureSource
    public let appId: String?
    public let appName: String
    public let windowTitle: String
    public let durationMs: Int
    public let hasImage: Bool
    public let ocr: OCRState
    public let textPreview: String
    public let sizeBytes: Int?
}

public struct OriginalRecord: Codable, Equatable, Sendable {
    public let id: String
    public let capturedAt: String
    public let receivedAt: String
    public let deviceId: String
    public let deviceName: String
    public let platform: CentralPlatform
    public let source: CaptureSource
    public let appId: String?
    public let appName: String
    public let windowTitle: String
    public let durationMs: Int
    public let ocrText: String
    public let summary: String?
    public let indexingStatus: String
    public let privacy: CapturePrivacy
    public let metadata: RecordMetadata?
    public let libraryVersion: String?
}

public struct CentralPage<Item: Codable & Sendable>: Codable, Sendable {
    public let items: [Item]
    public let nextCursor: String?
    public let totalCount: Int?
}

public struct ConversationScope: Codable, Equatable, Sendable {
    public let after: String?
    public let before: String?
    public let deviceId: String?
    public let timeZone: String?
    public let evidenceIds: [String]?
    public let anchorEvidenceIds: [String]?
    public let anchorMaterialRef: String?
}

public enum ConversationStatus: String, Codable, Sendable { case completed, failed }

public struct ConversationSummary: Codable, Equatable, Sendable {
    public let id: String
    public let title: String
    public let createdAt: String
    public let updatedAt: String
    public let turnCount: Int
    public let scope: ConversationScope
    public let status: ConversationStatus
}

public struct ConversationTurn: Codable, Equatable, Sendable {
    public struct Failure: Codable, Equatable, Sendable {
        public let code: String
        public let message: String
    }
    public struct Attachment: Codable, Equatable, Sendable {
        public let id: String
        public let name: String
        public let mimeType: String
    }

    public let id: String
    public let question: String
    public let scope: ConversationScope
    public let result: Answer?
    public let status: ConversationStatus
    public let error: Failure?
    public let createdAt: String
    public let evidenceDeleted: Bool?
    public let evidenceStale: Bool?
    public let evidenceUnavailable: Bool?
    public let unavailableEvidenceIds: [String]?
    public let attachments: [Attachment]?
}

public struct Conversation: Codable, Equatable, Sendable {
    public let id: String
    public let title: String
    public let createdAt: String
    public let updatedAt: String
    public let turnCount: Int
    public let scope: ConversationScope
    public let status: ConversationStatus
    public let turns: [ConversationTurn]
    public let revision: Int?
    public let nextCursor: String?
}

public struct Answer: Codable, Equatable, Sendable {
    public struct Citation: Codable, Equatable, Sendable {
        public let id: String
        public let capturedAt: String
        public let appName: String
        public let excerpt: String
        public let contentAt: String?
    }
    public struct Trace: Codable, Equatable, Sendable {
        public let tool: String
        public let arguments: JSONValue
        public let count: Int
    }

    public let answer: String
    public let runId: String
    public let citations: [Citation]
    public let trace: [Trace]
    public let createdAt: String?
    public let id: String?
}

public struct MemoryEvidence: Codable, Equatable, Sendable {
    public let id: String
    public let deviceId: String?
    public let sourceId: String?
    public let externalId: String?
    public let revision: String?
    public let capturedAt: String
    public let receivedAt: String
    public let recordedAt: String?
    public let occurredAt: String?
    public let offset: Int?
    public let length: Int?
    public let quote: String?
    public let contentHash: String
}

public struct MemorySummary: Codable, Equatable, Sendable {
    public let id: String
    public let version: Int
    public let title: String
    public let createdAt: String
    public let status: String
    public let domain: String
    public let tier: String
    public let kind: String
    public let revision: String
    public let evidenceCount: Int
    public let admission: MemoryRecord.Admission
    public let disclosure: MemoryRecord.Disclosure?
}

public struct MemoryRecord: Codable, Equatable, Sendable {
    public struct Admission: Codable, Equatable, Sendable {
        public let layer: String
        public let reason: String
        public let scope: String
        public let attribution: String
    }
    public struct Disclosure: Codable, Equatable, Sendable {
        public let detail: String
        public let evidence: String
        public let text: String
    }

    public let id: String
    public let version: Int
    public let title: String
    public let statement: String
    public let uncertainty: String
    public let evidenceIds: [String]
    public let evidence: [MemoryEvidence]
    public let createdAt: String
    public let updatedAt: String?
    public let status: String
    public let model: String
    public let runId: String
    public let skillVersion: String?
    public let fingerprint: String
    public let domain: String
    public let tier: String
    public let kind: String
    public let admission: Admission
    public let disclosure: Disclosure?
}

public struct MemoryEvidencePage: Codable, Equatable, Sendable {
    public let items: [OriginalRecord]
    public let status: String
}

public struct DeletionReceipt: Codable, Equatable, Sendable {
    public let deleted: Int
}
