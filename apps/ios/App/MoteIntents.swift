import AppIntents
import MoteCentral
import MoteCore
import MoteStorage
import UIKit

private enum MoteIntentError: LocalizedError {
    case entryUnavailable
    case deviceIdentityUnavailable
    case emptyScreenshot

    var errorDescription: String? {
        switch self {
        case .entryUnavailable: "入口不可用"
        case .deviceIdentityUnavailable: "本机设备身份不可用"
        case .emptyScreenshot: "截图内容为空"
        }
    }
}

@MainActor
private enum MoteIntentSupport {
    static func identity() throws -> (id: String, name: String) {
        guard let identifier = UIDevice.current.identifierForVendor else {
            throw MoteIntentError.deviceIdentityUnavailable
        }
        return (identifier.uuidString.lowercased(), UIDevice.current.name)
    }

    static func enqueue(_ capture: CaptureUpload, attachment: Data? = nil) async throws {
        let queue = try MoteStorage.sendQueue()
        try queue.enqueue(JSONEncoder().encode(capture), id: capture.id,
                          validatingAttachments: attachment.map { [$0] } ?? [])
        await AppSendPipeline.shared.reconcileAndSend()
    }

    static func settings(for kind: ShortcutSourceKind) throws -> ShortcutSourceSettings {
        try MoteStorage.shortcutSourceStore().snapshot(for: kind).settings
    }

    static func record(_ receipt: ShortcutSourceReceipt, for kind: ShortcutSourceKind) throws {
        try MoteStorage.shortcutSourceStore().record(receipt, for: kind)
    }
}

private func openURL(for entry: MoteEntry) throws -> URL {
    guard let url = entry.deepLinkURL else { throw MoteIntentError.entryUnavailable }
    return url
}

struct RecordIntent: AppIntent {
    static let title: LocalizedStringResource = "记录"

    func perform() async throws -> some IntentResult {
        .result(opensIntent: OpenURLIntent(try openURL(for: .record)))
    }
}

struct TakePhotoIntent: AppIntent {
    static let title: LocalizedStringResource = "拍照"

    func perform() async throws -> some IntentResult {
        .result(opensIntent: OpenURLIntent(try openURL(for: .photo)))
    }
}

struct RecordAudioIntent: AppIntent {
    static let title: LocalizedStringResource = "录音"

    func perform() async throws -> some IntentResult {
        .result(opensIntent: OpenURLIntent(try openURL(for: .recording)))
    }
}

struct AskMoteIntent: AppIntent {
    static let title: LocalizedStringResource = "问一问"

    func perform() async throws -> some IntentResult {
        .result(opensIntent: OpenURLIntent(try openURL(for: .ask)))
    }
}

struct PauseSendingIntent: AppIntent {
    static let title: LocalizedStringResource = "暂停发送"

    func perform() async throws -> some IntentResult {
        MoteSendPause.pause()
        return .result()
    }
}

struct SaveScreenshotIntent: AppIntent {
    static let title: LocalizedStringResource = "保存截图"

    @Parameter(title: "截图")
    var screenshot: IntentFile

    @Parameter(title: "截图文字")
    var recognizedText: String?

    func perform() async throws -> some IntentResult {
        let settings = try await MoteIntentSupport.settings(for: .screenshot)
        guard ShortcutSourceFilter.acceptsScreenshot(recognizedText: recognizedText, settings: settings) else {
            return .result()
        }
        let bytes = screenshot.data
        guard !bytes.isEmpty else { throw MoteIntentError.emptyScreenshot }
        let identity = try await MoteIntentSupport.identity()
        let capturedAt = CentralTimestamp.string()
        let capture = CaptureUpload(
            deviceId: identity.id,
            deviceName: identity.name,
            capturedAt: capturedAt,
            source: .screen,
            imageBase64: bytes.base64EncodedString(),
            privacy: CapturePrivacy(collection: .content),
            metadata: RecordMetadata(
                version: 1,
                observedAt: capturedAt,
                collector: CollectorMetadata(method: "shortcuts")
            )
        )
        try await MoteIntentSupport.enqueue(capture, attachment: bytes)
        let title = recognizedText?.split(whereSeparator: \.isNewline)
            .first.map { String($0).trimmingCharacters(in: .whitespacesAndNewlines) }
            .flatMap { $0.isEmpty ? nil : $0 } ?? "截图"
        try await MoteIntentSupport.record(
            ShortcutSourceReceipt(id: capture.id, title: title, capturedAt: capturedAt),
            for: .screenshot
        )
        return .result()
    }
}

struct SaveNotificationIntent: AppIntent {
    static let title: LocalizedStringResource = "保存通知"

    @Parameter(title: "应用标识")
    var appId: String

    @Parameter(title: "应用名称")
    var appName: String

    @Parameter(title: "标题")
    var title: String?

    @Parameter(title: "正文")
    var text: String?

    @Parameter(title: "分类")
    var category: String?

    @Parameter(title: "通知时间")
    var postedAt: Date?

    func perform() async throws -> some IntentResult {
        let settings = try await MoteIntentSupport.settings(for: .notification)
        let content = IOSNotificationContent(
            appId: appId,
            appName: appName,
            title: title,
            text: text,
            category: category
        )
        guard let content = ShortcutSourceFilter.notification(content, settings: settings) else {
            return .result()
        }
        let identity = try await MoteIntentSupport.identity()
        let capturedAt = CentralTimestamp.string(postedAt ?? Date())
        let capture = try IOSNotificationCapture.make(
            content: content,
            deviceId: identity.id,
            deviceName: identity.name,
            postedAt: capturedAt
        )
        try await MoteIntentSupport.enqueue(capture)
        let receiptTitle = [content.title, content.text, content.appName]
            .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
            .first { !$0.isEmpty } ?? "通知"
        try await MoteIntentSupport.record(
            ShortcutSourceReceipt(id: capture.id, title: receiptTitle, appName: content.appName, capturedAt: capturedAt),
            for: .notification
        )
        return .result()
    }
}

struct MoteAppShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: RecordIntent(),
            phrases: ["用 \(.applicationName) 记一下"],
            shortTitle: "记录",
            systemImageName: "square.and.pencil"
        )
        AppShortcut(
            intent: RecordAudioIntent(),
            phrases: ["用 \(.applicationName) 录音"],
            shortTitle: "录音",
            systemImageName: "mic"
        )
        AppShortcut(
            intent: AskMoteIntent(),
            phrases: ["问 \(.applicationName)"],
            shortTitle: "问一问",
            systemImageName: "bubble.left.and.bubble.right"
        )
    }
}
