import SwiftUI
import MoteDesign
import MoteStorage

@main
struct MoteApp: App {
    private let arguments = ProcessInfo.processInfo.arguments
    private let editorStore: EditorDraftStore?

    init() {
        editorStore = try? MoteStorage.editorDraftStore()
    }

    var body: some Scene {
        WindowGroup {
            Group {
                if arguments.contains("-MoteComponentPreview") {
                    ComponentPreview()
                } else if let editorStore {
                    EditorFlowView(store: editorStore, arguments: arguments)
                } else {
                    Text("草稿未能打开")
                        .foregroundStyle(MoteDesignTokens.danger.color)
                }
            }
            .preferredColorScheme(previewScheme)
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
