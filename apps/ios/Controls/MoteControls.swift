import AppIntents
import MoteCore
import SwiftUI
import WidgetKit

@main
struct MoteControlsBundle: WidgetBundle {
    var body: some Widget {
        RecordControl()
        PhotoControl()
        RecordingControl()
        AskControl()
        PauseSendingControl()
    }
}

@MainActor
private func openControl(_ control: MoteSystemControl) -> some ControlWidgetConfiguration {
    StaticControlConfiguration(kind: control.kind) {
        ControlWidgetButton(action: OpenSystemControlIntent(control: control)) {
            Label {
                Text(control.entry.title)
            } icon: {
                Image(control.rawValue).renderingMode(.template)
            }
        }
    }
    .displayName(LocalizedStringResource(stringLiteral: control.entry.title))
}

struct RecordControl: ControlWidget {
    var body: some ControlWidgetConfiguration { openControl(.record) }
}

struct PhotoControl: ControlWidget {
    var body: some ControlWidgetConfiguration { openControl(.photo) }
}

struct RecordingControl: ControlWidget {
    var body: some ControlWidgetConfiguration { openControl(.recording) }
}

struct AskControl: ControlWidget {
    var body: some ControlWidgetConfiguration { openControl(.ask) }
}

struct PauseSendingControl: ControlWidget {
    private let control = MoteSystemControl.pauseSending

    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: control.kind) {
            ControlWidgetButton(action: PauseSystemControlIntent()) {
                Label {
                    Text(control.entry.title)
                } icon: {
                    Image(control.rawValue).renderingMode(.template)
                }
            }
        }
        .displayName("暂停发送")
    }
}
