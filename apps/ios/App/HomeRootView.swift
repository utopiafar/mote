import MoteCore
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
        .sheet(item: $router.destination, onDismiss: {
            Task { await model.refresh() }
        }) { destination in
            HomeDestinationView(destination: destination)
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
}
