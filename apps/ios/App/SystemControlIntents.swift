import AppIntents
import Foundation
import MoteCore
#if !MOTE_CONTROL_EXTENSION
import UIKit
#endif

enum SystemControlTarget: String, AppEnum {
    case record
    case photo
    case recording
    case ask

    static let typeDisplayRepresentation: TypeDisplayRepresentation = "Mote"
    static let caseDisplayRepresentations: [SystemControlTarget: DisplayRepresentation] = [
        .record: "记录",
        .photo: "拍照",
        .recording: "录音",
        .ask: "问一问",
    ]

    var entry: MoteEntry? { MoteSystemControl(rawValue: rawValue)?.entry }
}

private enum SystemControlError: LocalizedError {
    case entryUnavailable

    var errorDescription: String? { "入口不可用" }
}

@MainActor
private func openControlURL(_ url: URL) async throws {
    #if MOTE_CONTROL_EXTENSION
    throw SystemControlError.entryUnavailable
    #else
    guard await UIApplication.shared.open(url) else { throw SystemControlError.entryUnavailable }
    #endif
}

/// WidgetKit runs an OpenIntent in the main app, where the existing URL
/// handler routes the entry. OpenURLIntent itself only supports universal links.
struct OpenSystemControlIntent: OpenIntent {
    static let title: LocalizedStringResource = "Mote"
    static let isDiscoverable = false

    @Parameter(title: "Mote")
    var target: SystemControlTarget

    init() {}

    init(control: MoteSystemControl) {
        switch control {
        case .record: target = .record
        case .photo: target = .photo
        case .recording: target = .recording
        case .ask: target = .ask
        case .pauseSending: preconditionFailure("Pause is not an open control")
        }
    }

    @MainActor
    func perform() async throws -> some IntentResult {
        guard let entry = target.entry, entry.action != .pause, let url = entry.deepLinkURL else {
            throw SystemControlError.entryUnavailable
        }
        try await openControlURL(url)
        return .result()
    }
}

struct PauseSystemControlIntent: AppIntent {
    static let title: LocalizedStringResource = "暂停发送"
    static let isDiscoverable = false

    func perform() async throws -> some IntentResult {
        guard MoteSystemControl.pauseSending.entry.action == .pause else {
            throw SystemControlError.entryUnavailable
        }
        MoteSendPause.pause()
        return .result()
    }
}
