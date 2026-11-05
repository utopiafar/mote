import Foundation

/// A system interruption never starts recording again without an explicit tap.
public struct RecordingState: Equatable, Sendable {
    public enum Phase: Equatable, Sendable {
        case idle
        case recording
        case paused
    }

    public private(set) var phase: Phase = .idle
    public private(set) var interrupted = false

    public init() {}

    public mutating func start() {
        guard phase == .idle else { return }
        phase = .recording
        interrupted = false
    }

    public mutating func pause(interrupted: Bool = false) {
        guard phase == .recording else { return }
        phase = .paused
        self.interrupted = interrupted
    }

    public mutating func resume() {
        guard phase == .paused else { return }
        phase = .recording
        interrupted = false
    }

    public mutating func interruptionEnded() {
        // Ending the interruption only makes a later user-initiated resume possible.
    }

    public mutating func stop() {
        phase = .idle
        interrupted = false
    }
}
