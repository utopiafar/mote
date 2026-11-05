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
        .sheet(item: sheetDestination, onDismiss: {
            Task { await model.refresh() }
        }) { destination in
            HomeDestinationView(
                destination: destination,
                onAsk: { router.destination = .ask($0) },
                onClearScope: { router.destination = .ask(nil) }
            )
        }
        .fullScreenCover(isPresented: connectionPresented, onDismiss: {
            Task { await model.refresh() }
        }) {
            ConnectionView()
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

    private var sheetDestination: Binding<HomeDestination?> {
        Binding(
            get: { router.destination == .connection ? nil : router.destination },
            set: { router.destination = $0 }
        )
    }

    private var connectionPresented: Binding<Bool> {
        Binding(
            get: { router.destination == .connection },
            set: { if !$0 { router.destination = nil } }
        )
    }
}
