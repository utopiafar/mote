import MoteCore
import MoteStorage
import SwiftUI

/// The app's default root. The home owns reading local state; destinations
/// are handed to `HomeRouter` so later units can replace one placeholder at a
/// time without touching the home layout.
struct HomeRootView: View {
    @State private var model = HomeModel()
    @State private var router = HomeRouter()
    @StateObject private var recording: RecordingController
    @Environment(\.scenePhase) private var scenePhase
    var arguments: [String] = ProcessInfo.processInfo.arguments
    var editorStore: EditorDraftStore? = try? MoteStorage.editorDraftStore()

    init(arguments: [String] = ProcessInfo.processInfo.arguments, editorStore: EditorDraftStore? = try? MoteStorage.editorDraftStore()) {
        self.arguments = arguments
        self.editorStore = editorStore
        _recording = StateObject(wrappedValue: RecordingController(store: editorStore, arguments: arguments))
    }

    var body: some View {
        HomeView(
            presentation: model.presentation,
            recording: recording.isActive ? RecordingBarState(elapsed: recording.elapsed, paused: recording.isPaused) : nil,
            onRecordingStop: { recording.stop(); refresh() }
        ) { action in
            router.open(action)
        }
        .sheet(item: sheetDestination, onDismiss: refresh) { destination in
            destinationView(destination)
        }
        .fullScreenCover(item: fullScreenDestination, onDismiss: refresh) { destination in
            destinationView(destination)
        }
        .task {
            await model.refresh()
        }
        .onOpenURL { url in
            guard let entry = MoteEntry(url: url) else { return }
            router.open(entry)
        }
        .onChange(of: scenePhase) { _, phase in
            guard phase == .active else { return }
            Task { await model.refresh() }
        }
    }

    /// The editor, settings menu and capture screen fill the window like
    /// their reference designs; the remaining destinations keep the home sheet.
    private var sheetDestination: Binding<HomeDestination?> {
        Binding(
            get: { router.destination?.isFullScreen == true ? nil : router.destination },
            set: { router.destination = $0 }
        )
    }

    private var fullScreenDestination: Binding<HomeDestination?> {
        Binding(
            get: { router.destination?.isFullScreen == true ? router.destination : nil },
            set: { router.destination = $0 }
        )
    }

    private func destinationView(_ destination: HomeDestination) -> some View {
        HomeDestinationView(
            destination: destination,
            editorStore: editorStore,
            recording: recording,
            arguments: arguments,
            onAsk: { router.destination = .ask($0) },
            onClearScope: { router.destination = .ask(nil) },
            onOpenConnection: { router.destination = .connection }
        )
    }

    private func refresh() {
        Task { await model.refresh() }
    }
}
