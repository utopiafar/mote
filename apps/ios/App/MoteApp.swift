import SwiftUI

@main
struct MoteApp: App {
    private let arguments = ProcessInfo.processInfo.arguments

    var body: some Scene {
        WindowGroup {
            if arguments.contains("-MoteComponentPreview") {
                ComponentPreview()
                    .preferredColorScheme(previewScheme)
            } else {
                ConnectionView()
                    .preferredColorScheme(previewScheme)
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
