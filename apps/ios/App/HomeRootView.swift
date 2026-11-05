import MoteStorage
import SwiftUI

/// The app's default root. The home owns reading local state; destinations
/// are handed to `HomeRouter` so later units can replace one placeholder at a
/// time without touching the home layout.
struct HomeRootView: View {
    @State private var model = HomeModel()
    @State private var router = HomeRouter()
    @Environment(\.scenePhase) private var scenePhase
    let arguments: [String]
    let editorStore: EditorDraftStore?

    var body: some View {
        HomeView(presentation: model.presentation) { action in
            router.open(action)
        }
        .sheet(item: sheetDestination, onDismiss: refresh) { destination in
            HomeDestinationView(destination: destination, editorStore: editorStore, arguments: arguments)
        }
        .fullScreenCover(item: editorDestination, onDismiss: refresh) { destination in
            HomeDestinationView(destination: destination, editorStore: editorStore, arguments: arguments)
        }
        .task {
            await model.refresh()
        }
        .onChange(of: scenePhase) { _, phase in
            guard phase == .active else { return }
            Task { await model.refresh() }
        }
    }

    /// The editor keeps the reference's full-screen presentation; the other
    /// destinations stay in the home's existing sheets.
    private var sheetDestination: Binding<HomeDestination?> {
        Binding(
            get: { router.destination?.isEditor == true ? nil : router.destination },
            set: { router.destination = $0 }
        )
    }

    private var editorDestination: Binding<HomeDestination?> {
        Binding(
            get: { router.destination?.isEditor == true ? router.destination : nil },
            set: { router.destination = $0 }
        )
    }

    private func refresh() {
        Task { await model.refresh() }
    }
}
