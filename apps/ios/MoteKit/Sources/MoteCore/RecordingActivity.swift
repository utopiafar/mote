import Foundation

/// A snapshot of the recorder, not an independent source of recording state.
public struct RecordingActivitySnapshot: Equatable, Sendable {
    public let recordingID: UUID
    public let elapsed: TimeInterval
    public let isPaused: Bool

    public init(recordingID: UUID, elapsed: TimeInterval, isPaused: Bool) {
        self.recordingID = recordingID
        self.elapsed = max(0, elapsed)
        self.isPaused = isPaused
    }
}

/// The platform adapter owns ActivityKit objects; the recorder remains the authority.
@MainActor
public protocol RecordingActivityBackend: AnyObject {
    func endOrphanedActivities() async
    func start(_ snapshot: RecordingActivitySnapshot) async -> Bool
    func update(_ snapshot: RecordingActivitySnapshot) async
    func end() async
}

/// Serializes system activity changes even when the recorder changes while an
/// earlier ActivityKit operation is suspended.
@MainActor
public final class RecordingActivityCoordinator {
    private let backend: any RecordingActivityBackend
    private var tail: Task<Void, Never>?
    private var currentID: UUID?

    public init(backend: any RecordingActivityBackend) {
        self.backend = backend
        enqueue { [backend] in await backend.endOrphanedActivities() }
    }

    public func recordingChanged(_ snapshot: RecordingActivitySnapshot?) {
        enqueue { [self] in
            guard let snapshot else {
                if currentID != nil {
                    await backend.end()
                    currentID = nil
                }
                return
            }
            if currentID != snapshot.recordingID {
                if currentID != nil { await backend.end() }
                currentID = await backend.start(snapshot) ? snapshot.recordingID : nil
            } else {
                await backend.update(snapshot)
            }
        }
    }

    /// Used by an App Intent to wait until the resulting system UI is updated.
    public func waitForUpdates() async {
        await tail?.value
    }

    private func enqueue(_ operation: @escaping @MainActor () async -> Void) {
        let previous = tail
        tail = Task { @MainActor in
            await previous?.value
            await operation()
        }
    }
}
