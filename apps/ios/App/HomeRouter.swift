import MoteCentral
import MoteCore
import MoteDesign
import Observation
import SwiftUI

/// The one place home actions become destinations. Later units replace the
/// marked placeholders with their own screens.
@MainActor
@Observable
final class HomeRouter {
    var destination: HomeDestination?

    func open(_ action: HomeAction) {
        switch action {
        case .profile: destination = .profile
        case .search: destination = .search
        case .ask: destination = .ask(nil)
        case .record: destination = .editor(.record)
        case .camera: destination = .editor(.camera)
        case .microphone: destination = .editor(.microphone)
        case .notice(.connect): destination = .connection
        case .notice(.capture(.reconnect)): destination = .connection
        case .notice(.capture): destination = .captureStatus
        case .highlight(let kind, let id): destination = .highlight(kind, id)
        case .original(let id): destination = .original(id)
        }
    }

    func open(_ entry: MoteEntry) {
        switch entry.action {
        case .openEditor(.note): open(HomeAction.record)
        case .openEditor(.photo): open(HomeAction.camera)
        case .openEditor(.recording): open(HomeAction.microphone)
        case .openAsk: open(HomeAction.ask)
        case .pause: MoteSendPause.pause()
        }
    }
}

enum HomeDestination: Equatable, Identifiable {
    // Destination: 我的 Mote（后续单元）
    case profile
    // Destination: 中央原文搜索（后续单元）
    case search
    // Destination: IOS11 iOS 对话列表
    case ask(OriginalAskScope?)
    // Destination: IOS08 iOS 编辑器；拍照直接进入编辑器，录音由 IOS09 接管
    case editor(EditorIntent)
    // Destination: IOS07 iOS 连接
    case connection
    // Destination: 采集状态（IOS09、IOS10 之后）
    case captureStatus
    case original(String)
    // Destination: 日程与待办、发现历史（后续单元）
    case highlight(HomeHighlight.Kind, String)

    enum EditorIntent: String {
        case record
        case camera
        case microphone
    }

    var id: String {
        switch self {
        case .profile: "profile"
        case .search: "search"
        case .ask(let scope): "ask.\(scope?.id ?? "none")"
        case .editor(let intent): "editor.\(intent.rawValue)"
        case .connection: "connection"
        case .captureStatus: "captureStatus"
        case .original(let id): "original.\(id)"
        case .highlight(let kind, let id): "highlight.\(kind.rawValue).\(id)"
        }
    }

    var title: String {
        switch self {
        case .profile: "我的 Mote"
        case .search: "搜索"
        case .ask: "问一问"
        case .editor(.record): "记录"
        case .editor(.camera): "拍照"
        case .editor(.microphone): "录音"
        case .connection: "连接 Mote"
        case .captureStatus: "采集状态"
        case .original: "原文"
        case .highlight(.schedule, _): "日程"
        case .highlight(.discovery, _): "发现"
        }
    }
}

struct HomeDestinationView: View {
    let destination: HomeDestination
    let onAsk: (OriginalAskScope) -> Void
    let onClearScope: () -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        if case .original(let id) = destination {
            OriginalRootView(id: id, onDeleted: { dismiss() }, onAsk: onAsk)
        } else {
            NavigationStack {
                VStack(spacing: 12) {
                    MoteMark()
                    Text(destination.title)
                        .font(MoteFont.title)
                        .foregroundStyle(MoteDesignTokens.ink.color)
                    if case .ask(let scope?) = destination {
                        HStack(spacing: 8) {
                            Text(scope.title)
                                .font(MoteFont.secondary)
                                .foregroundStyle(MoteDesignTokens.ink.color)
                                .lineLimit(1)
                            Button("清除范围", action: onClearScope)
                                .font(MoteFont.smallAction)
                                .frame(minHeight: MoteMetrics.touchTarget)
                        }
                        .accessibilityElement(children: .contain)
                    }
                    Text("此功能将在后续版本提供")
                        .font(MoteFont.secondary)
                        .foregroundStyle(MoteDesignTokens.muted.color)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(MoteDesignTokens.background.color)
                .navigationTitle(destination.title)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button("关闭") { dismiss() }
                    }
                }
            }
        }
    }
}
