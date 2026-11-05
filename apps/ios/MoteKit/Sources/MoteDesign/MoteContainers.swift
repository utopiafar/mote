import SwiftUI

public enum MoteMetrics {
    /// The smallest allowed touch target on iOS.
    public static let touchTarget: CGFloat = 44
    public static let groupRadius = MoteDesignTokens.Dimens.radiusContainerMobile
    public static let fieldRadius = MoteDesignTokens.Dimens.radiusControlMobile
    public static let sheetRadius = MoteDesignTokens.Dimens.radiusPanelMobile
    public static let rowMinHeight = MoteMetrics.touchTarget
    public static let controlHeight = MoteMetrics.touchTarget
    public static let pageMargin: CGFloat = 16
    public static let markSize: CGFloat = 28
    public static let markRadius: CGFloat = 6
}

/// A contained list with hairline outline and dividers.
public struct MoteGroup<Content: View>: View {
    private let content: Content

    public init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    public var body: some View {
        VStack(spacing: 0) { content }
            .background(MoteDesignTokens.surface.color)
            .clipShape(RoundedRectangle(cornerRadius: MoteMetrics.groupRadius, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: MoteMetrics.groupRadius, style: .continuous)
                    .strokeBorder(MoteDesignTokens.hair.color, lineWidth: MoteDesignTokens.Dimens.borderWidth)
            }
            .accessibilityElement(children: .contain)
    }
}

/// A 44pt list row with an optional leading icon and a caller-provided accessory.
public struct MoteRow<Accessory: View>: View {
    private let icon: MoteIconName?
    private let title: String
    private let subtitle: String?
    private let topDivider: Bool
    private let action: (() -> Void)?
    private let accessory: Accessory

    public init(
        icon: MoteIconName? = nil,
        title: String,
        subtitle: String? = nil,
        topDivider: Bool = false,
        action: (() -> Void)? = nil,
        @ViewBuilder accessory: () -> Accessory
    ) {
        self.icon = icon
        self.title = title
        self.subtitle = subtitle
        self.topDivider = topDivider
        self.action = action
        self.accessory = accessory()
    }

    public var body: some View {
        Group {
            if let action {
                Button(action: action) { row }
                    .buttonStyle(.plain)
            } else {
                row
            }
        }
    }

    private var row: some View {
        HStack(spacing: 12) {
            if let icon {
                MoteIcon(icon, size: 20)
                    .foregroundStyle(MoteDesignTokens.muted.color)
            }
            VStack(alignment: .leading, spacing: 1) {
                Text(title)
                    .font(MoteFont.body)
                    .foregroundStyle(MoteDesignTokens.ink.color)
                if let subtitle {
                    Text(subtitle)
                        .font(MoteFont.secondary)
                        .foregroundStyle(MoteDesignTokens.muted.color)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            accessory
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 9)
        .frame(minHeight: MoteMetrics.rowMinHeight)
        .contentShape(Rectangle())
        .overlay(alignment: .top) {
            if topDivider {
                Rectangle()
                    .fill(MoteDesignTokens.hair.color)
                    .frame(height: MoteDesignTokens.Dimens.borderWidth)
            }
        }
    }
}

public extension MoteRow where Accessory == MoteChevron {
    init(
        icon: MoteIconName? = nil,
        title: String,
        subtitle: String? = nil,
        topDivider: Bool = false,
        action: (() -> Void)? = nil
    ) {
        self.init(icon: icon, title: title, subtitle: subtitle, topDivider: topDivider, action: action) {
            MoteChevron()
        }
    }
}

public struct MoteChevron: View {
    public init() {}

    public var body: some View {
        MoteIcon(.chev, size: 16)
            .foregroundStyle(MoteDesignTokens.muted.color)
    }
}

public enum MoteNoticeTone: Sendable, Equatable {
    case neutral
    case warning
    case danger
}

/// A capsule notice with at most one action.
public struct MoteNotice: View {
    private let tone: MoteNoticeTone
    private let icon: MoteIconName
    private let title: String
    private let actionTitle: String?
    private let action: (() -> Void)?

    public init(
        tone: MoteNoticeTone = .neutral,
        icon: MoteIconName,
        title: String,
        actionTitle: String? = nil,
        action: (() -> Void)? = nil
    ) {
        self.tone = tone
        self.icon = icon
        self.title = title
        self.actionTitle = actionTitle
        self.action = action
    }

    public var body: some View {
        HStack(spacing: 10) {
            MoteIcon(icon, size: 20)
                .foregroundStyle(iconColor)
            Text(title)
                .font(MoteFont.body)
                .foregroundStyle(MoteDesignTokens.ink.color)
                .lineLimit(1)
                .frame(maxWidth: .infinity, alignment: .leading)
            if let actionTitle, let action {
                Button(action: action) {
                    Text(actionTitle)
                        .font(MoteFont.smallAction)
                        .foregroundStyle(MoteDesignTokens.ink.color)
                        .padding(.horizontal, 12)
                        .frame(height: 34)
                        .background(MoteDesignTokens.fill.color, in: Capsule())
                        .frame(height: MoteMetrics.touchTarget)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.leading, 16)
        .padding(.trailing, 5)
        .frame(minHeight: MoteMetrics.touchTarget)
        .background(backgroundColor)
        .clipShape(Capsule())
        .overlay {
            if tone == .neutral {
                Capsule()
                    .strokeBorder(MoteDesignTokens.hair.color, lineWidth: MoteDesignTokens.Dimens.borderWidth)
            }
        }
        .accessibilityElement(children: .contain)
    }

    private var backgroundColor: Color {
        switch tone {
        case .neutral: MoteDesignTokens.surface.color
        case .warning: MoteDesignTokens.warningTint.color
        case .danger: MoteDesignTokens.dangerTint.color
        }
    }

    private var iconColor: Color {
        switch tone {
        case .neutral: MoteDesignTokens.muted.color
        case .warning: MoteDesignTokens.warning.color
        case .danger: MoteDesignTokens.danger.color
        }
    }
}

/// A capsule confirmation shown after the owner's own action.
public struct MoteToast: View {
    private let title: String
    private let actionTitle: String?
    private let action: (() -> Void)?

    public init(title: String, actionTitle: String? = nil, action: (() -> Void)? = nil) {
        self.title = title
        self.actionTitle = actionTitle
        self.action = action
    }

    public var body: some View {
        HStack(spacing: 8) {
            Text(title)
                .font(MoteFont.body)
                .foregroundStyle(MoteDesignTokens.primaryInk.color)
                .frame(maxWidth: .infinity, alignment: .leading)
            if let actionTitle, let action {
                Button(action: action) {
                    Text(actionTitle)
                        .font(MoteFont.action.weight(.semibold))
                        .foregroundStyle(MoteDesignTokens.primaryInk.color)
                        .padding(.horizontal, 8)
                        .frame(height: 34)
                        .frame(height: MoteMetrics.touchTarget)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.leading, 18)
        .padding(.trailing, 4)
        .frame(minHeight: MoteMetrics.touchTarget)
        .background(MoteDesignTokens.primaryBackground.color)
        .clipShape(Capsule())
        .accessibilityElement(children: .contain)
    }
}

public enum MoteBadgeTone: Sendable {
    case neutral
    case success
    case warning
    case danger
}

public struct MoteBadge: View {
    private let title: String
    private let tone: MoteBadgeTone

    public init(_ title: String, tone: MoteBadgeTone = .neutral) {
        self.title = title
        self.tone = tone
    }

    public var body: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(foregroundColor)
                .frame(width: 8, height: 8)
            Text(title)
                .font(MoteFont.badge)
                .foregroundStyle(foregroundColor)
        }
        .padding(.horizontal, 8)
        .frame(height: 22)
        .background(backgroundColor, in: Capsule())
    }

    private var foregroundColor: Color {
        switch tone {
        case .neutral: MoteDesignTokens.muted.color
        case .success: MoteDesignTokens.success.color
        case .warning: MoteDesignTokens.warning.color
        case .danger: MoteDesignTokens.danger.color
        }
    }

    private var backgroundColor: Color {
        switch tone {
        case .neutral: MoteDesignTokens.surfaceHover.color
        case .success: MoteDesignTokens.successTint.color
        case .warning: MoteDesignTokens.warningTint.color
        case .danger: MoteDesignTokens.dangerTint.color
        }
    }
}

/// A bottom sheet surface with only the top corners rounded.
public struct MoteBottomSheet<Content: View>: View {
    private let content: Content

    public init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    public var body: some View {
        VStack(spacing: 0) {
            Capsule()
                .fill(MoteDesignTokens.border.color)
                .frame(width: 36, height: 5)
                .padding(.top, 6)
                .padding(.bottom, 8)
            content
        }
        .frame(maxWidth: .infinity)
        .background(MoteDesignTokens.surfaceRaised.color)
        .clipShape(
            UnevenRoundedRectangle(
                topLeadingRadius: MoteMetrics.sheetRadius,
                topTrailingRadius: MoteMetrics.sheetRadius
            )
        )
        .accessibilityElement(children: .contain)
    }
}
