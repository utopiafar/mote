import Foundation
import XCTest
@testable import MoteCore

@MainActor
final class RecordingActivityTests: XCTestCase {
    func testRecordingPauseResumeAndStopKeepTheActivityInStep() async {
        let backend = ActivityBackend()
        let coordinator = RecordingActivityCoordinator(backend: backend)
        let id = UUID()
        let now = Date(timeIntervalSince1970: 1_000)
        coordinator.recordingChanged(snapshot(id, elapsed: 0, at: now))
        coordinator.recordingChanged(snapshot(id, elapsed: 134, at: now.addingTimeInterval(134), paused: true))
        coordinator.recordingChanged(snapshot(id, elapsed: 134, at: now.addingTimeInterval(200)))
        coordinator.recordingChanged(nil)
        await coordinator.waitForUpdates()

        XCTAssertEqual(backend.events, [.cleanup, .start, .update, .update, .end])
        XCTAssertEqual(backend.snapshots[1].elapsed, 134)
        XCTAssertTrue(backend.snapshots[1].isPaused)
        XCTAssertFalse(backend.snapshots[2].isPaused)
        XCTAssertEqual(backend.snapshots[2].timerStart, now.addingTimeInterval(66))
        XCTAssertNil(backend.active)
    }

    func testStopWhileActivityStartIsSuspendedCannotLeaveAnActivityRunning() async {
        let backend = ActivityBackend()
        backend.suspendStart = true
        let coordinator = RecordingActivityCoordinator(backend: backend)
        coordinator.recordingChanged(snapshot(UUID(), elapsed: 0, at: .now))
        while backend.startContinuation == nil { await Task.yield() }
        coordinator.recordingChanged(nil)
        backend.startContinuation?.resume()
        await coordinator.waitForUpdates()

        XCTAssertEqual(backend.events, [.cleanup, .start, .end])
        XCTAssertNil(backend.active)
    }

    func testRestartCleansOrphansAndFailedStartDoesNotCreateAnActivity() async {
        let backend = ActivityBackend()
        backend.active = snapshot(UUID(), elapsed: 20, at: .now)
        backend.allowStart = false
        let coordinator = RecordingActivityCoordinator(backend: backend)
        coordinator.recordingChanged(snapshot(UUID(), elapsed: 0, at: .now))
        coordinator.recordingChanged(nil)
        await coordinator.waitForUpdates()

        XCTAssertEqual(backend.events, [.cleanup, .start])
        XCTAssertNil(backend.active)
    }

    func testNewRecordingEndsPreviousActivityBeforeStarting() async {
        let backend = ActivityBackend()
        let coordinator = RecordingActivityCoordinator(backend: backend)
        let first = snapshot(UUID(), elapsed: 1, at: .now)
        let second = snapshot(UUID(), elapsed: 0, at: .now)
        coordinator.recordingChanged(first)
        coordinator.recordingChanged(second)
        await coordinator.waitForUpdates()
        XCTAssertEqual(backend.events, [.cleanup, .start, .end, .start])
        XCTAssertEqual(backend.active, second)
    }

    private func snapshot(_ id: UUID, elapsed: TimeInterval, at: Date, paused: Bool = false) -> RecordingActivitySnapshot {
        RecordingActivitySnapshot(recordingID: id, elapsed: elapsed, updatedAt: at, isPaused: paused)
    }
}

@MainActor
private final class ActivityBackend: RecordingActivityBackend {
    enum Event: Equatable { case cleanup, start, update, end }
    var events: [Event] = []
    var snapshots: [RecordingActivitySnapshot] = []
    var active: RecordingActivitySnapshot?
    var allowStart = true
    var suspendStart = false
    var startContinuation: CheckedContinuation<Void, Never>?

    func endOrphanedActivities() async { events.append(.cleanup); active = nil }
    func start(_ snapshot: RecordingActivitySnapshot) async -> Bool {
        events.append(.start)
        if suspendStart {
            await withCheckedContinuation { startContinuation = $0 }
        }
        guard allowStart else { return false }
        snapshots.append(snapshot)
        active = snapshot
        return true
    }
    func update(_ snapshot: RecordingActivitySnapshot) async { events.append(.update); snapshots.append(snapshot); active = snapshot }
    func end() async { events.append(.end); active = nil }
}
