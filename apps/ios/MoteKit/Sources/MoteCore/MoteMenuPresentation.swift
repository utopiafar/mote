public enum MoteMenuStatusTone: String, Equatable, Sendable {
    case neutral
    case warning
}

/// The one trailing status the "我的 Mote" menu shows for 采集与同步.
public struct MoteMenuStatus: Equatable, Sendable {
    public let title: String
    public let tone: MoteMenuStatusTone

    public init(title: String, tone: MoteMenuStatusTone) {
        self.title = title
        self.tone = tone
    }
}

/// Projects the shared capture status into the menu row. Normal states stay
/// silent; a status without a home sentence (local only, disconnected) does
/// not belong in this row either.
public struct MoteMenuPresentation: Equatable, Sendable {
    public let captureStatus: MoteMenuStatus?

    public init(facts: CaptureStatusFacts) {
        let status = CaptureStatusMapping.status(for: facts)
        guard status.level != .normal, let title = status.home?.titleKey else {
            self.captureStatus = nil
            return
        }
        self.captureStatus = MoteMenuStatus(
            title: title,
            tone: status.level == .needsAction ? .warning : .neutral
        )
    }
}
