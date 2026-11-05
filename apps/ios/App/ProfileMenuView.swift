import MoteDesign
import MoteStorage
import SwiftUI
import UIKit

/// 我的 Mote: the settings hub home reaches from the top-left mark. The
/// capture and sync row opens the product capture screen; the other rows are
/// owned by later units and answer with the shared placeholder notice.
struct ProfileMenuView: View {
    private let onOpenConnection: (() -> Void)?
    @Environment(\.dismiss) private var dismiss
    @State private var showingCaptureSync = false
    @State private var showingUnavailable = false

    init(onOpenConnection: (() -> Void)? = nil) {
        self.onOpenConnection = onOpenConnection
    }

    var body: some View {
        ZStack {
            MoteDesignTokens.background.color
                .ignoresSafeArea()

            if showingCaptureSync {
                CaptureSyncScreen(onBack: { dismiss() }, onOpenConnection: onOpenConnection)
            } else {
                menu
            }
        }
        .alert("此功能将在后续版本提供", isPresented: $showingUnavailable) {
            Button("好", role: .cancel) {}
        }
    }

    private var menu: some View {
        VStack(spacing: 0) {
            HStack(spacing: 0) {
                MoteIconButton(icon: .back, label: "返回") { dismiss() }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 6)
            .frame(height: 44)

            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    Text("我的 Mote")
                        .font(MoteFont.title)
                        .tracking(-0.55)
                        .foregroundStyle(MoteDesignTokens.ink.color)
                        .padding(.horizontal, 20)
                        .padding(.bottom, 18)

                    MoteGroup {
                        MoteRow(icon: .library, title: "资料与记忆") { unavailable() }
                        MoteRow(icon: .pulse, title: "发现历史", topDivider: true) { unavailable() }
                        MoteRow(icon: .calendar, title: "日程与待办", topDivider: true) { unavailable() }
                    }
                    .padding(.horizontal, MoteMetrics.pageMargin)

                    MoteGroup {
                        MoteRow(icon: .refresh, title: "采集与同步") {
                            showingCaptureSync = true
                        }
                        MoteRow(icon: .gear, title: "设置", topDivider: true) { unavailable() }
                    }
                    .padding(.horizontal, MoteMetrics.pageMargin)
                    .padding(.top, 24)

                    MoteGroup {
                        MoteRow(icon: .globe, title: "中央工作台", action: openCentral) {
                            MoteIcon(.external, size: 16)
                                .foregroundStyle(MoteDesignTokens.muted.color)
                        }
                    }
                    .padding(.horizontal, MoteMetrics.pageMargin)
                    .padding(.top, 24)
                }
                .padding(.bottom, 34)
            }
            .scrollIndicators(.hidden)
        }
    }

    private func unavailable() {
        showingUnavailable = true
    }

    private func openCentral() {
        guard let connection = (try? MoteStorage.connectionStore().read()) ?? nil,
              let url = URL(string: connection.serverUrl),
              let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https"
        else {
            unavailable()
            return
        }
        UIApplication.shared.open(url)
    }
}
