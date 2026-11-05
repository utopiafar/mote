import SwiftUI

/// The app's default root. The home owns reading local state; destinations
/// are handed to `HomeRouter` so later units can replace one placeholder at a
/// time without touching the home layout.
struct HomeRootView: View {
    @State private var model = HomeModel()
    @State private var router = HomeRouter()
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        HomeView(presentation: model.presentation) { action in
            router.open(action)
        }
        .sheet(item: sheetDestination, onDismiss: {
            refresh()
        }) { destination in
            destinationView(destination)
        }
        .fullScreenCover(item: fullScreenDestination, onDismiss: {
            refresh()
        }) { destination in
            destinationView(destination)
        }
        .task {
            await model.refresh()
        }
        .onChange(of: scenePhase) { _, phase in
            guard phase == .active else { return }
            Task { await model.refresh() }
        }
    }

    /// The settings menu and capture screen fill the window like their
    /// reference designs; the remaining destinations keep the home sheet.
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
            onAsk: { router.destination = .ask($0) },
            onClearScope: { router.destination = .ask(nil) },
            onOpenConnection: { router.destination = .connection }
        )
    }

    private func refresh() {
        Task { await model.refresh() }
    }
}
