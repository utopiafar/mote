import SwiftUI

@main
struct MoteApp: App {
    @Environment(\.scenePhase) private var scenePhase
    private let arguments = ProcessInfo.processInfo.arguments

    var body: some Scene {
        WindowGroup {
            Group {
                if arguments.contains("-MoteComponentPreview") {
                    ComponentPreview()
                        .preferredColorScheme(previewScheme)
                } else {
                    Color(uiColor: .systemBackground)
                        .ignoresSafeArea()
                }
            }
            .task {
                await AppSendPipeline.shared.reconcileAndSend()
            }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active {
                Task { await AppSendPipeline.shared.reconcileAndSend() }
            }
        }
    }

    private var previewScheme: ColorScheme? {
        guard let index = arguments.firstIndex(of: "-MoteAppearance"), arguments.indices.contains(index + 1) else {
            return nil
        }
        switch arguments[index + 1] {
        case "light": return .light
        case "dark": return .dark
        default: return nil
        }
    }
}
