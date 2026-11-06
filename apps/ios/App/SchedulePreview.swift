import MoteCentral
import MoteCore
import SwiftUI

/// Generated data for isolated UI checks; never reads the owner's profile.
struct SchedulePreview: View {
    @State private var showingSchedule = false
    private let arguments = ProcessInfo.processInfo.arguments
    private var state: String {
        arguments.firstIndex(of: "-MoteScheduleState").flatMap { arguments.indices.contains($0 + 1) ? arguments[$0 + 1] : nil } ?? "list"
    }
    var body: some View {
        Group {
            if state == "home" {
                HomeView(presentation: home) { action in
                    if case .highlight(.schedule, _) = action { showingSchedule = true }
                }
                .sheet(isPresented: $showingSchedule) { ScheduleScreen(fixture: "home") { showingSchedule = false } }
            } else {
                ScheduleScreen(fixture: state, onBack: {})
            }
        }.statusBarHidden()
    }
    private var home: HomePresentation {
        let actions = try! JSONDecoder().decode([CalendarAction].self, from: Data(ScheduleModel.actionJSON.utf8))
        let facts = CaptureStatusFacts(connection: .connected, captureEnabled: true, captureLive: true, syncState: .idle)
        let original = HomeOriginal(id: "generated", capturedAt: Date(), title: "和陈老师的电话", detail: "16:40 · 录音 12:40")
        return HomePresentation(facts: facts, hasDraft: false,
                                highlights: CalendarActionPolicy.homeHighlights(actions), originals: [original])
    }
}
