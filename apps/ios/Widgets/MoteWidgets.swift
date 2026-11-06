import MoteDesign
import MoteWidgetUI
import SwiftUI
import WidgetKit

struct MoteWidgetEntry: TimelineEntry {
    let date: Date
}

struct MoteWidgetProvider: TimelineProvider {
    func placeholder(in context: Context) -> MoteWidgetEntry {
        MoteWidgetEntry(date: Date())
    }

    func getSnapshot(in context: Context, completion: @escaping (MoteWidgetEntry) -> Void) {
        completion(MoteWidgetEntry(date: Date()))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<MoteWidgetEntry>) -> Void) {
        completion(Timeline(entries: [MoteWidgetEntry(date: Date())], policy: .never))
    }
}

struct MoteWidgetEntryView: View {
    @Environment(\.widgetFamily) private var family

    var body: some View {
        MoteWidgetContent(layout: family == .systemMedium ? .medium : .small)
            .containerBackground(for: .widget) {
                MoteDesignTokens.surface.color
            }
    }
}

struct MoteWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "MoteWidget", provider: MoteWidgetProvider()) { _ in
            MoteWidgetEntryView()
        }
        .configurationDisplayName("Mote")
        .description("记录、拍照、录音和问一问")
        .supportedFamilies([.systemSmall, .systemMedium])
        .contentMarginsDisabled()
    }
}

@main
struct MoteWidgets: WidgetBundle {
    var body: some Widget {
        MoteWidget()
    }
}
