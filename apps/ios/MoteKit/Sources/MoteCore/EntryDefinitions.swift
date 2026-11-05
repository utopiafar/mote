import Foundation

public enum MoteEditorMode: String, Sendable {
    case note
    case photo
    case recording
}

public enum MoteEntryAction: Equatable, Sendable {
    case openEditor(MoteEditorMode)
    case openAsk
    case pause
}

public enum MoteEntry: String, CaseIterable, Equatable, Sendable {
    case record
    case photo
    case recording
    case ask
    case pauseSending

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .record: "记录"
        case .photo: "拍照"
        case .recording: "录音"
        case .ask: "问一问"
        case .pauseSending: "暂停发送"
        }
    }

    public var action: MoteEntryAction {
        switch self {
        case .record: .openEditor(.note)
        case .photo: .openEditor(.photo)
        case .recording: .openEditor(.recording)
        case .ask: .openAsk
        case .pauseSending: .pause
        }
    }

    public var deepLinkURL: URL? {
        URL(string: "mote://entry/\(rawValue)")
    }

    public var siriPhrases: [String] {
        switch self {
        case .record: ["用 Mote 记一下"]
        case .recording: ["用 Mote 录音"]
        case .ask: ["问 Mote"]
        case .photo, .pauseSending: []
        }
    }

    public init?(url: URL) {
        guard url.scheme == "mote", url.host == "entry", url.query == nil, url.fragment == nil,
              let entry = MoteEntry(rawValue: String(url.path.dropFirst())),
              entry.deepLinkURL == url
        else { return nil }
        self = entry
    }

    public static func resolve(_ url: URL) -> MoteEntry? {
        MoteEntry(url: url)
    }
}

public enum MoteCaptureShortcut: String, CaseIterable, Sendable {
    case screenshot
    case notification

    public var title: String {
        switch self {
        case .screenshot: "保存截图"
        case .notification: "保存通知"
        }
    }
}

public enum MoteSendPause {
    public static let defaultsKey = "sendPaused"

    public static func isPaused(defaults: UserDefaults? = UserDefaults(suiteName: MoteCore.appGroupIdentifier)) -> Bool {
        defaults?.bool(forKey: defaultsKey) ?? false
    }

    public static func pause(defaults: UserDefaults? = UserDefaults(suiteName: MoteCore.appGroupIdentifier)) {
        defaults?.set(true, forKey: defaultsKey)
    }
}
