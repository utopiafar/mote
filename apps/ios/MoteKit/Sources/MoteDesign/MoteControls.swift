import SwiftUI

public enum MoteCapsuleButtonStyle: Sendable {
    case primary
    case secondary
    case plain
    case danger
}

/// A pill button whose hit target is always at least 44pt high.
public struct MoteCapsuleButton: View {
    private let title: String
    private let icon: MoteIconName?
    private let style: MoteCapsuleButtonStyle
    private let fullWidth: Bool
    private let action: () -> Void

    public init(
        _ title: String,
        icon: MoteIconName? = nil,
        style: MoteCapsuleButtonStyle = .secondary,
        fullWidth: Bool = false,
        action: @escaping () -> Void
    ) {
        self.title = title
        self.icon = icon
        self.style = style
        self.fullWidth = fullWidth
        self.action = action
    }

    public var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                if let icon {
                    MoteIcon(icon, size: 20)
                }
                Text(title)
                    .font(MoteFont.action)
                    .lineLimit(1)
            }
            .foregroundStyle(foregroundColor)
            .padding(.horizontal, horizontalPadding)
            .frame(maxWidth: fullWidth ? .infinity : nil)
            .frame(minHeight: MoteMetrics.touchTarget)
            .background(backgroundColor, in: Capsule())
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
    }

    private var foregroundColor: Color {
        switch style {
        case .primary: MoteDesignTokens.primaryInk.color
        case .secondary, .plain: MoteDesignTokens.ink.color
        case .danger: MoteDesignTokens.danger.color
        }
    }

    private var backgroundColor: Color {
        switch style {
        case .primary: MoteDesignTokens.primaryBackground.color
        case .secondary: MoteDesignTokens.fill.color
        case .plain, .danger: .clear
        }
    }

    private var horizontalPadding: CGFloat {
        style == .plain || style == .danger ? 8 : 16
    }
}

public enum MoteIconButtonStyle: Sendable {
    case plain
    case filled
    case muted
    case solid
}

public struct MoteIconButton: View {
    private let icon: MoteIconName
    private let label: String
    private let style: MoteIconButtonStyle
    private let action: () -> Void

    /// `label` is required so every icon-only button has an accessibility name.
    public init(
        icon: MoteIconName,
        label: String,
        style: MoteIconButtonStyle = .plain,
        action: @escaping () -> Void
    ) {
        self.icon = icon
        self.label = label
        self.style = style
        self.action = action
    }

    public var body: some View {
        Button(action: action) {
            MoteIcon(icon, size: 24)
                .foregroundStyle(foregroundColor)
                .frame(width: MoteMetrics.touchTarget, height: MoteMetrics.touchTarget)
                .background(backgroundColor, in: Circle())
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text(label))
    }

    private var foregroundColor: Color {
        switch style {
        case .plain, .filled: MoteDesignTokens.ink.color
        case .muted: MoteDesignTokens.muted.color
        case .solid: MoteDesignTokens.primaryInk.color
        }
    }

    private var backgroundColor: Color {
        switch style {
        case .plain, .muted: .clear
        case .filled: MoteDesignTokens.fill.color
        case .solid: MoteDesignTokens.primaryBackground.color
        }
    }
}

public struct MoteSegmentedControl: View {
    private let options: [String]
    @Binding private var selection: String

    public init(options: [String], selection: Binding<String>) {
        self.options = options
        self._selection = selection
    }

    public var body: some View {
        HStack(spacing: 2) {
            ForEach(options, id: \.self) { option in
                let selected = option == selection
                Button {
                    selection = option
                } label: {
                    Text(option)
                        .font(MoteFont.smallAction)
                        .foregroundStyle(selected ? MoteDesignTokens.ink.color : MoteDesignTokens.muted.color)
                        .frame(maxWidth: .infinity)
                        .frame(height: 30)
                        .background {
                            if selected {
                                Capsule()
                                    .fill(MoteDesignTokens.surface.color)
                                    .overlay {
                                        Capsule()
                                            .strokeBorder(MoteDesignTokens.hair.color, lineWidth: 1)
                                    }
                            }
                        }
                        .frame(height: MoteMetrics.touchTarget)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(selected ? .isSelected : [])
            }
        }
        .padding(.horizontal, 2)
        .background(alignment: .center) {
            Capsule()
                .fill(MoteDesignTokens.surfaceHover.color)
                .frame(height: 34)
        }
        .frame(height: MoteMetrics.touchTarget)
        .accessibilityElement(children: .contain)
    }
}

/// A capsule text field with an accent ring while focused.
public struct MoteCapsuleField<Trailing: View>: View {
    private let placeholder: String
    private let icon: MoteIconName?
    @Binding private var text: String
    @FocusState private var focused: Bool
    private let trailing: Trailing

    public init(
        _ placeholder: String,
        text: Binding<String>,
        icon: MoteIconName? = nil,
        @ViewBuilder trailing: () -> Trailing
    ) {
        self.placeholder = placeholder
        self._text = text
        self.icon = icon
        self.trailing = trailing()
    }

    public var body: some View {
        HStack(spacing: 8) {
            if let icon {
                MoteIcon(icon, size: 20)
                    .foregroundStyle(MoteDesignTokens.muted.color)
            }
            TextField(
                "",
                text: $text,
                prompt: Text(placeholder).foregroundStyle(MoteDesignTokens.muted.color)
            )
            .font(MoteFont.body)
            .foregroundStyle(MoteDesignTokens.ink.color)
            .textFieldStyle(.plain)
            .focused($focused)
            .submitLabel(.send)
            .accessibilityLabel(Text(placeholder))
            trailing
        }
        .padding(.horizontal, 16)
        .frame(minHeight: MoteMetrics.touchTarget)
        .background(MoteDesignTokens.surface.color, in: Capsule())
        .overlay {
            Capsule()
                .strokeBorder(
                    focused ? MoteDesignTokens.accent.color : MoteDesignTokens.controlBorder.color,
                    lineWidth: 1
                )
        }
        .overlay {
            Capsule()
                .strokeBorder(MoteDesignTokens.accent.color, lineWidth: 1)
                .padding(-1)
                .opacity(focused ? 1 : 0)
        }
        .contentShape(Capsule())
        .onTapGesture { focused = true }
        .accessibilityElement(children: .contain)
    }
}

public extension MoteCapsuleField where Trailing == EmptyView {
    init(_ placeholder: String, text: Binding<String>, icon: MoteIconName? = nil) {
        self.init(placeholder, text: text, icon: icon) { EmptyView() }
    }
}

/// The square m mark used by the app bar and connection screens.
public struct MoteMark: View {
    public init() {}

    public var body: some View {
        Text("m")
            .font(.system(size: 23, weight: .semibold))
            .tracking(-1.5)
            .foregroundStyle(MoteDesignTokens.primaryInk.color)
            .padding(.trailing, 1)
            .padding(.bottom, 3)
            .frame(width: MoteMetrics.markSize, height: MoteMetrics.markSize)
            .background(MoteDesignTokens.primaryBackground.color)
            .clipShape(RoundedRectangle(cornerRadius: MoteMetrics.markRadius, style: .continuous))
            .accessibilityHidden(true)
    }
}
