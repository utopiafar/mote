import SwiftUI
import UIKit
import MoteDesign
import MoteStorage

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
    private let editorStore: EditorDraftStore?

    init() {
        editorStore = try? MoteStorage.editorDraftStore()
        RecordingLiveActivity.initialize()
    }

    var body: some Scene {
        WindowGroup {
            Group {
                if arguments.contains("-MoteComponentPreview") {
                    ComponentPreview()
                        .preferredColorScheme(previewScheme)
                } else if arguments.contains("-MoteHomePreview") {
                    HomePreview()
                        .preferredColorScheme(previewScheme)
                } else if arguments.contains("-MoteHistoryPreview") {
                    ConversationHistoryPreview()
                        .preferredColorScheme(previewScheme)
                } else if arguments.contains("-MoteConversationPreview") {
                    ConversationPreview()
                        .preferredColorScheme(previewScheme)
                } else if arguments.contains("-MoteEditorPreview") {
                    editorPreview
                        .preferredColorScheme(previewScheme)
                } else if arguments.contains("-MoteRecordingPreview") {
                    RecordingPreview(arguments: arguments)
                        .preferredColorScheme(previewScheme)
                } else if arguments.contains("-MoteReaderPreview") {
                    OriginalPreview()
                        .preferredColorScheme(previewScheme)
                } else if arguments.contains("-MoteConnectPreview") {
                    ConnectionView()
                        .preferredColorScheme(previewScheme)
                } else if arguments.contains("-MoteCaptureSyncPreview") {
                    CaptureSyncPreview()
                        .preferredColorScheme(previewScheme)
                } else if arguments.contains("-MoteSourcePreview") {
                    SourceDetailPreview()
                        .preferredColorScheme(previewScheme)
                } else if arguments.contains("-MoteShortcutSetupPreview") {
                    ShortcutSetupPreview()
                        .preferredColorScheme(previewScheme)
                } else if arguments.contains("-MoteProfilePreview") {
                    ProfileMenuPreview()
                        .preferredColorScheme(previewScheme)
                } else if arguments.contains("-MoteLibraryPreview") {
                    LibraryMemoriesPreview()
                        .preferredColorScheme(previewScheme)
                } else if arguments.contains("-MoteSearchPreview") {
                    SearchRecordsPreview()
                        .preferredColorScheme(previewScheme)
                } else if arguments.contains("-MoteMemoryDetailPreview") {
                    MemoryDetailPreview()
                        .preferredColorScheme(previewScheme)
                } else if arguments.contains("-MoteSharePreview") {
                    SharePreview()
                        .preferredColorScheme(previewScheme)
                } else if arguments.contains("-MoteWidgetPreview") {
                    WidgetPreview()
                        .preferredColorScheme(previewScheme)
                } else {
                    HomeRootView(arguments: arguments, editorStore: editorStore)
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

    @ViewBuilder
    private var editorPreview: some View {
        if let editorStore {
            EditorFlowView(store: editorStore, arguments: arguments)
        } else {
            Text("草稿未能打开")
                .foregroundStyle(MoteDesignTokens.danger.color)
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
