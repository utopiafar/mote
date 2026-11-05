import MoteCore
import MoteDesign
import SwiftUI

/// 采集与同步：来源、发送与本机存储。
struct CaptureSyncView: View {
    let presentation: CaptureSyncPresentation
    let onBack: (() -> Void)?
    let onAction: (CaptureSyncAction) -> Void

    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme
    @State private var showingAddSource: Bool
    @State private var sendPaused: Bool

    init(
        presentation: CaptureSyncPresentation,
        initiallyShowingAddSource: Bool = false,
        onBack: (() -> Void)? = nil,
        onAction: @escaping (CaptureSyncAction) -> Void = { _ in }
    ) {
        self.presentation = presentation
        self.onBack = onBack
        self.onAction = onAction
        self._showingAddSource = State(initialValue: initiallyShowingAddSource)
        self._sendPaused = State(initialValue: presentation.sendPaused)
    }

    var body: some View {
        ZStack(alignment: .bottom) {
            MoteDesignTokens.background.color
                .ignoresSafeArea()

            VStack(spacing: 0) {
                backBar
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        Text(CaptureSyncPresentation.title)
                            .font(MoteFont.title)
                            .tracking(-0.55)
                            .foregroundStyle(MoteDesignTokens.ink.color)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 20)
                            .padding(.bottom, 18)

                        sourceGroup
                        sendGroup.padding(.top, 24)
                        storageGroup.padding(.top, 24)
                    }
                    .padding(.bottom, 34)
                }
                .scrollIndicators(.hidden)
            }

            if showingAddSource {
                addSourceLayer
                    .transition(.opacity.combined(with: .move(edge: .bottom)))
            }
        }
        .animation(.easeOut(duration: 0.2), value: showingAddSource)
    }

    private var backBar: some View {
        HStack(spacing: 2) {
            MoteIconButton(icon: .back, label: "返回") {
                if let onBack {
                    onBack()
                } else {
                    dismiss()
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 6)
        .frame(height: 44)
    }

    private var sourceGroup: some View {
        MoteGroup {
            ForEach(Array(presentation.sources.enumerated()), id: \.element.id) { index, source in
                sourceRow(source, topDivider: index > 0)
            }
            addSourceRow(topDivider: !presentation.sources.isEmpty)
        }
        .padding(.horizontal, MoteMetrics.pageMargin)
    }

    @ViewBuilder
    private func sourceRow(_ source: CaptureSourcePresentation, topDivider: Bool) -> some View {
        if let actionTitle = source.actionTitle, let action = source.action {
            CaptureSyncRow(
                icon: icon(for: source.id),
                title: source.title,
                subtitle: nil,
                subtitleTone: source.tone,
                topDivider: topDivider,
                minHeight: 48,
                action: nil
            ) {
                HStack(spacing: 8) {
                    Text(source.detail)
                        .font(.system(size: 15))
                        .foregroundStyle(MoteDesignTokens.warning.color)
                        .lineLimit(1)
                        .fixedSize(horizontal: true, vertical: false)
                    CaptureActionPill(title: actionTitle) {
                        dispatch(action, source: source.id)
                    }
                }
                .fixedSize(horizontal: true, vertical: false)
            }
        } else {
            CaptureSyncRow(
                icon: icon(for: source.id),
                title: source.title,
                subtitle: nil,
                subtitleTone: source.tone,
                topDivider: topDivider,
                minHeight: 48,
                action: {
                    if let action = source.action {
                        dispatch(action, source: source.id)
                    }
                }
            ) {
                HStack(spacing: 8) {
                    if !source.detail.isEmpty {
                        Text(source.detail)
                            .font(.system(size: 15))
                            .foregroundStyle(MoteDesignTokens.muted.color)
                            .lineLimit(1)
                    }
                    MoteChevron()
                }
            }
        }
    }

    private var sendGroup: some View {
        let send = presentation.send(paused: sendPaused)
        return MoteGroup {
            CaptureSyncRow(
                icon: .send,
                title: send.host,
                subtitle: send.statusText,
                subtitleTone: send.tone,
                topDivider: false,
                minHeight: 60,
                action: nil
            ) {
                if let actionTitle = send.actionTitle, let action = send.action {
                    CaptureActionPill(title: actionTitle) {
                        onAction(action)
                    }
                }
            }

            CaptureSyncRow(
                icon: .clock,
                title: "发送方式",
                subtitle: nil,
                subtitleTone: .normal,
                topDivider: true,
                minHeight: 48,
                action: { onAction(.openSendMethod) }
            ) {
                HStack(spacing: 8) {
                    Text(presentation.sendMethod)
                        .font(.system(size: 15))
                        .foregroundStyle(MoteDesignTokens.muted.color)
                    MoteChevron()
                }
            }

            CaptureSyncRow(
                icon: .pause,
                title: "暂停发送",
                subtitle: nil,
                subtitleTone: .normal,
                topDivider: true,
                minHeight: 48,
                action: nil
            ) {
                CaptureSwitch(isOn: $sendPaused)
                    .onChange(of: sendPaused) { _, paused in
                        onAction(.setSendPaused(paused))
                    }
            }
        }
        .padding(.horizontal, MoteMetrics.pageMargin)
    }

    private var storageGroup: some View {
        MoteGroup {
            CaptureSyncRow(
                icon: .disk,
                title: "本机存储",
                subtitle: nil,
                subtitleTone: .normal,
                topDivider: false,
                minHeight: 48,
                action: { onAction(.openStorage) }
            ) {
                HStack(spacing: 8) {
                    if let storageText = presentation.storageText {
                        Text(storageText)
                            .font(.system(size: 15))
                            .foregroundStyle(MoteDesignTokens.muted.color)
                    }
                    MoteChevron()
                }
            }
        }
        .padding(.horizontal, MoteMetrics.pageMargin)
    }

    private func addSourceRow(topDivider: Bool) -> some View {
        CaptureSyncRow(
            icon: .plus,
            title: "添加来源",
            subtitle: nil,
            subtitleTone: .normal,
            topDivider: topDivider,
            minHeight: 48,
            action: { withAnimation(.easeOut(duration: 0.2)) { showingAddSource = true } },
            titleColor: MoteDesignTokens.accent.color,
            iconColor: MoteDesignTokens.accent.color
        ) {
            EmptyView()
        }
    }

    private var addSourceLayer: some View {
        ZStack(alignment: .bottom) {
            scrimColor
                .ignoresSafeArea()
                .contentShape(Rectangle())
                .onTapGesture {
                    withAnimation(.easeOut(duration: 0.2)) { showingAddSource = false }
                }
                .accessibilityHidden(true)

            MoteBottomSheet {
                HStack(spacing: 8) {
                    Text("添加来源")
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(MoteDesignTokens.ink.color)
                    Spacer(minLength: 0)
                    MoteIconButton(icon: .close, label: "关闭", style: .muted) {
                        withAnimation(.easeOut(duration: 0.2)) { showingAddSource = false }
                    }
                }
                .padding(.leading, 20)
                .padding(.trailing, 4)
                .frame(height: 44)

                MoteGroup {
                    ForEach(Array(presentation.addSourceKinds.enumerated()), id: \.element) { index, kind in
                        CaptureSyncRow(
                            icon: icon(for: kind),
                            title: kind.title,
                            subtitle: nil,
                            subtitleTone: .normal,
                            topDivider: index > 0,
                            minHeight: 48,
                            action: {
                                onAction(kind.opensExternal ? .openCentralSources : .addSource(kind))
                                withAnimation(.easeOut(duration: 0.2)) { showingAddSource = false }
                            }
                        ) {
                            MoteIcon(kind.opensExternal ? .external : .chev, size: 16)
                                .foregroundStyle(MoteDesignTokens.muted.color)
                        }
                    }
                }
                .padding(.horizontal, MoteMetrics.pageMargin)
                .padding(.top, 8)

                Color.clear
                    .frame(height: 40)
            }
            .ignoresSafeArea(edges: .bottom)
            .accessibilityAddTraits(.isModal)
        }
    }

    private var scrimColor: Color {
        colorScheme == .dark
            ? Color.black.opacity(0.55)
            : MoteDesignTokens.ink.color.opacity(0.36)
    }

    private func dispatch(_ action: CaptureSourceAction, source: CaptureSourceID) {
        switch action {
        case .openSource:
            onAction(.openSource(source))
        case .openShortcutSetup:
            onAction(.openShortcutSetup(source))
        case .handleMediaPermission:
            onAction(.handleMediaPermission)
        }
    }

    private func icon(for source: CaptureSourceID) -> MoteIconName {
        switch source {
        case .notification: .bell
        case .screenshot: .phone
        case .media: .photo
        case .folder: .folder
        }
    }

    private func icon(for kind: AddSourceKind) -> MoteIconName {
        switch kind {
        case .file: .file
        case .folder: .folder
        case .calendar: .calendar
        case .deviceEvents: .bolt
        case .cloud: .globe
        }
    }
}

private struct CaptureSyncRow<Accessory: View>: View {
    let icon: MoteIconName?
    let title: String
    let subtitle: String?
    let subtitleTone: CaptureSourceTone
    let topDivider: Bool
    let minHeight: CGFloat
    let action: (() -> Void)?
    let titleColor: Color
    let iconColor: Color
    private let accessory: Accessory

    init(
        icon: MoteIconName?,
        title: String,
        subtitle: String?,
        subtitleTone: CaptureSourceTone,
        topDivider: Bool,
        minHeight: CGFloat,
        action: (() -> Void)?,
        titleColor: Color = MoteDesignTokens.ink.color,
        iconColor: Color = MoteDesignTokens.muted.color,
        @ViewBuilder accessory: () -> Accessory
    ) {
        self.icon = icon
        self.title = title
        self.subtitle = subtitle
        self.subtitleTone = subtitleTone
        self.topDivider = topDivider
        self.minHeight = minHeight
        self.action = action
        self.titleColor = titleColor
        self.iconColor = iconColor
        self.accessory = accessory()
    }

    var body: some View {
        if let action {
            Button(action: action) { row }
                .buttonStyle(.plain)
        } else {
            row
        }
    }

    private var row: some View {
        HStack(spacing: 12) {
            if let icon {
                MoteIcon(icon, size: 20)
                    .foregroundStyle(iconColor)
            }
            VStack(alignment: .leading, spacing: 1) {
                Text(title)
                    .font(.system(size: 15, weight: subtitle == nil ? .regular : .medium))
                    .foregroundStyle(titleColor)
                    .lineLimit(1)
                if let subtitle {
                    Text(subtitle)
                        .font(.system(size: 13))
                        .foregroundStyle(subtitleTone == .warning
                            ? MoteDesignTokens.warning.color
                            : MoteDesignTokens.muted.color)
                        .lineLimit(1)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            accessory
        }
        .padding(.horizontal, 14)
        .frame(minHeight: minHeight)
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

/// A 32pt pill with a hit target above 44pt, used for row-level operations.
private struct CaptureActionPill: View {
    let title: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(MoteFont.smallAction)
                .foregroundStyle(MoteDesignTokens.ink.color)
                .lineLimit(1)
                .fixedSize(horizontal: true, vertical: false)
                .padding(.horizontal, 12)
                .frame(height: 32)
                .background(MoteDesignTokens.fill.color, in: Capsule())
                .frame(height: 46)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

/// The canvas switch: 51 × 31 with a 27pt knob and a 44pt hit target.
private struct CaptureSwitch: View {
    @Binding var isOn: Bool

    var body: some View {
        Button {
            withAnimation(.easeOut(duration: 0.15)) { isOn.toggle() }
        } label: {
            ZStack {
                Capsule()
                    .fill(isOn ? MoteDesignTokens.accent.color : MoteDesignTokens.border.color)
                    .frame(width: 51, height: 31)
                Circle()
                    .fill(Color.white)
                    .frame(width: 27, height: 27)
                    .shadow(color: .black.opacity(0.08), radius: 0.5, y: 0)
                    .shadow(color: .black.opacity(0.12), radius: 1.5, y: 1)
                    .offset(x: isOn ? 10 : -10)
            }
            .frame(width: 51, height: 31)
            .frame(height: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text("暂停发送"))
        .accessibilityValue(isOn ? "1" : "0")
        .accessibilityAddTraits(.isToggle)
    }
}
