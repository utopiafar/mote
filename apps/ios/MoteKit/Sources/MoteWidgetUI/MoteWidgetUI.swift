import MoteCore
import MoteDesign
import SwiftUI

public enum MoteWidgetLayout: Sendable {
    case small
    case medium
}

/// The widget body shared by the WidgetKit extension and the in-app preview.
/// Every tile is a `MoteEntry`, so the widget only opens a link from the
/// unified entry definition and never invents its own action.
public struct MoteWidgetContent: View {
    public let layout: MoteWidgetLayout

    public init(layout: MoteWidgetLayout) {
        self.layout = layout
    }

    public var body: some View {
        Group {
            switch layout {
            case .small: small
            case .medium: medium
            }
        }
        .padding(14)
    }

    private var small: some View {
        VStack(spacing: 10) {
            HStack(spacing: 10) {
                ForEach(Array(MoteEntry.widgetSmall.prefix(2)), id: \.rawValue) { entry in
                    tile(entry, iconSize: 24)
                }
            }
            HStack(spacing: 10) {
                ForEach(Array(MoteEntry.widgetSmall.dropFirst(2)), id: \.rawValue) { entry in
                    tile(entry, iconSize: 24)
                }
            }
        }
    }

    private var medium: some View {
        VStack(spacing: 10) {
            tile(.widgetMediumPrimary, iconSize: 20, showsTitle: true)
                .frame(maxHeight: .infinity)
            HStack(spacing: 10) {
                ForEach(MoteEntry.widgetMediumActions, id: \.rawValue) { entry in
                    tile(entry, iconSize: 20, showsTitle: true)
                        .frame(maxWidth: .infinity)
                        .frame(height: 50)
                }
            }
        }
    }

    private func tile(_ entry: MoteEntry, iconSize: CGFloat, showsTitle: Bool = false) -> some View {
        Group {
            if let url = entry.deepLinkURL {
                Link(destination: url) {
                    tileLabel(entry, iconSize: iconSize, showsTitle: showsTitle)
                }
            } else {
                tileLabel(entry, iconSize: iconSize, showsTitle: showsTitle)
            }
        }
        .accessibilityLabel(entry.title)
        .accessibilityIdentifier("mote-widget-\(layout.accessibilityName)-\(entry.id)")
    }

    private func tileLabel(_ entry: MoteEntry, iconSize: CGFloat, showsTitle: Bool) -> some View {
        HStack(spacing: 6) {
            MoteIcon(entry.widgetIcon, size: iconSize)
            if showsTitle {
                Text(entry.title)
                    .font(.system(size: 14, weight: .medium))
                    .lineLimit(1)
            }
        }
        .foregroundStyle(MoteDesignTokens.ink.color)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(
            MoteDesignTokens.surfaceSunken.color,
            in: RoundedRectangle(cornerRadius: 14, style: .continuous)
        )
        .contentShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
    }
}

public extension MoteEntry {
    var widgetIcon: MoteIconName {
        switch self {
        case .record: .compose
        case .photo: .camera
        case .recording: .mic
        case .ask: .ask
        case .pauseSending: .pause
        }
    }
}

extension MoteWidgetLayout {
    var accessibilityName: String {
        switch self {
        case .small: "small"
        case .medium: "medium"
        }
    }
}
