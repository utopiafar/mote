@preconcurrency import ActivityKit
import Foundation
import MoteCore

@MainActor
enum RecordingLiveActivity {
    enum Command { case pause, resume, stop }

    private static let coordinator = RecordingActivityCoordinator(backend: ActivityKitBackend())
    private static weak var controller: RecordingController?

    static func initialize() { _ = coordinator }

    static func started(_ recorder: RecordingController) {
        controller = recorder
        changed(recorder)
    }

    static func changed(_ recorder: RecordingController) {
        guard controller === recorder, let id = recorder.activityRecordingID else { return }
        coordinator.recordingChanged(RecordingActivitySnapshot(
            recordingID: id, elapsed: recorder.elapsed, updatedAt: .now, isPaused: recorder.isPaused
        ))
    }

    static func stopped(_ recorder: RecordingController) {
        guard controller === recorder else { return }
        controller = nil
        coordinator.recordingChanged(nil)
    }

    static func perform(_ command: Command, recordingID: String) async {
        guard let recorder = controller, recorder.activityRecordingID?.uuidString == recordingID else { return }
        switch command {
        case .pause: recorder.pause()
        case .resume: recorder.resume()
        case .stop: recorder.stop()
        }
        await coordinator.waitForUpdates()
    }
}

@MainActor
private final class ActivityKitBackend: RecordingActivityBackend {
    private var activityID: String?

    func endOrphanedActivities() async {
        for activity in Activity<RecordingActivityAttributes>.activities {
            await activity.end(nil, dismissalPolicy: .immediate)
        }
    }

    func start(_ snapshot: RecordingActivitySnapshot) async -> Bool {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return false }
        do {
            let activity = try Activity.request(
                attributes: RecordingActivityAttributes(recordingID: snapshot.recordingID.uuidString),
                content: ActivityContent(state: content(snapshot), staleDate: nil),
                pushType: nil
            )
            activityID = activity.id
            return true
        } catch {
            return false
        }
    }

    func update(_ snapshot: RecordingActivitySnapshot) async {
        guard let id = activityID,
              let activity = Activity<RecordingActivityAttributes>.activities.first(where: { $0.id == id }) else { return }
        await activity.update(ActivityContent(state: content(snapshot), staleDate: nil))
    }

    func end() async {
        guard let id = activityID else { return }
        activityID = nil
        if let activity = Activity<RecordingActivityAttributes>.activities.first(where: { $0.id == id }) {
            await activity.end(nil, dismissalPolicy: .immediate)
        }
    }

    private func content(_ snapshot: RecordingActivitySnapshot) -> RecordingActivityAttributes.ContentState {
        .init(timerStart: snapshot.timerStart, elapsed: snapshot.elapsed, isPaused: snapshot.isPaused)
    }
}
