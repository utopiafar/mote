import MoteCore
import MoteStorage
import SwiftUI

/// Isolated generated input for the recording screen's visual checks.
struct RecordingPreview: View {
    @StateObject private var recording: RecordingController
    @State private var inEditor: Bool
    @State private var didPrepare = false
    @Environment(\.scenePhase) private var scenePhase
    private let store: EditorDraftStore
    private let arguments: [String]
    private let interrupted: Bool
    private let previewElapsed: TimeInterval

    init(arguments: [String]) {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("mote-recording-preview-\(UUID().uuidString)", isDirectory: true)
        let store = EditorDraftStore(directoryURL: directory)
        self.store = store
        self.arguments = arguments
        let state = Self.argument("-MoteRecordingState", in: arguments) ?? "inApp"
        self.interrupted = state == "interrupted"
        self.previewElapsed = Self.argument("-MoteRecordingElapsed", in: arguments).flatMap(TimeInterval.init) ?? 134
        _inEditor = State(initialValue: state != "away")
        _recording = StateObject(wrappedValue: RecordingController(store: store, arguments: arguments))
    }

    var body: some View {
        Group {
            if inEditor {
                EditorFlowView(store: store, arguments: arguments + ["-MoteEditorFixture", "recording"], recording: recording) {
                    inEditor = false
                }
            } else {
                HomeView(
                    presentation: home,
                    recording: recording.isActive ? RecordingBarState(elapsed: recording.elapsed, paused: recording.isPaused) : nil,
                    onRecordingStop: { recording.stop() }
                ) { action in
                    if action == .record { inEditor = true }
                }
                .statusBarHidden()
            }
        }
        .task(id: scenePhase) {
            guard scenePhase == .active, !didPrepare else { return }
            didPrepare = true
            recording.model?.load(fixtureName: "recording", descriptionExpanded: false)
            await recording.preparePreview(interrupted: interrupted, elapsed: previewElapsed)
        }
    }

    private var home: HomePresentation {
        let calendar = Calendar.current
        let today = calendar.startOfDay(for: Date())
        func time(_ hour: Int, _ minute: Int) -> Date {
            calendar.date(bySettingHour: hour, minute: minute, second: 0, of: today)!
        }
        let facts = CaptureStatusFacts(connection: .connected, captureEnabled: true, captureLive: true, syncState: .idle)
        return HomePresentation(facts: facts, hasDraft: true, highlights: [], originals: [
            HomeOriginal(id: "board", capturedAt: time(18, 2), title: "白板：第三季度路线图", detail: "18:02 · 照片"),
            HomeOriginal(id: "call", capturedAt: time(16, 40), title: "和陈老师的电话", detail: "16:40 · 录音 12:40"),
            HomeOriginal(id: "link", capturedAt: time(11, 5), title: "低温慢烤牛肋排的时间表", detail: "11:05 · seriouseats.com"),
        ], calendar: calendar)
    }

    private static func argument(_ key: String, in arguments: [String]) -> String? {
        guard let index = arguments.firstIndex(of: key), arguments.indices.contains(index + 1) else { return nil }
        return arguments[index + 1]
    }
}
