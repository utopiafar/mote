import SwiftUI
import UIKit

final class MoteAppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication, handleEventsForBackgroundURLSession identifier: String,
                     completionHandler: @escaping () -> Void) {
        AppSendPipeline.shared.handleBackgroundEvents(identifier: identifier, completionHandler: completionHandler)
    }
}

@main
struct MoteApp: App {
    @UIApplicationDelegateAdaptor(MoteAppDelegate.self) private var appDelegate
    @Environment(\.scenePhase) private var scenePhase
    private let arguments = ProcessInfo.processInfo.arguments

    var body: some Scene {
        WindowGroup {
            Group {
                if arguments.contains("-MoteComponentPreview") {
                    ComponentPreview()
                        .preferredColorScheme(previewScheme)
                } else if arguments.contains("-MoteHomePreview") {
                    HomePreview()
                        .preferredColorScheme(previewScheme)
                } else if arguments.contains("-MoteReaderPreview") {
                    OriginalPreview()
                        .preferredColorScheme(previewScheme)
                } else if arguments.contains("-MoteCaptureSyncPreview") {
                    CaptureSyncPreview()
                        .preferredColorScheme(previewScheme)
                } else {
                    HomeRootView()
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
