import SwiftUI
import UniformTypeIdentifiers
import MoteCentral
import MoteDesign
import MoteStorage

struct ConnectionView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @State private var screen: Screen = .start
    @State private var invitation: ConnectionInvitation?
    @State private var notice: String?
    @State private var isImporting = false
    @State private var deviceName = "我的 iPhone"
    @State private var pendingCount: Int?
    @State private var connectionState: ConnectionState = .ready
    @State private var connected = false
    @FocusState private var editingDeviceName: Bool

    private enum Screen { case start, scan, confirm }
    private enum ConnectionState { case ready, connecting, failed }

    var body: some View {
        ZStack {
            MoteDesignTokens.background.color.ignoresSafeArea()
            switch screen {
            case .start: startScreen
            case .scan: scanScreen
            case .confirm: confirmationScreen
            }
        }
        .ignoresSafeArea(.container)
        .statusBarHidden()
        .persistentSystemOverlays(.hidden)
        .onAppear(perform: prepare)
        .fileImporter(isPresented: $isImporting, allowedContentTypes: [.json, .plainText, .data]) { result in
            if case .success(let url) = result { importInvitation(url) }
        }
        .alert("已连接", isPresented: $connected) {
            Button("完成") { screen = .start; invitation = nil; dismiss() }
        }
    }

    private var startScreen: some View {
        VStack(spacing: 0) {
            Color.clear.frame(height: 54)
            HStack {
                MoteIconButton(icon: .back, label: "返回") { dismiss() }
                Spacer()
            }
            .padding(.leading, 6)
            .frame(height: 44)
            VStack(alignment: .leading, spacing: 18) {
                Text("m")
                    .font(.system(size: 42, weight: .semibold))
                    .tracking(-3)
                    .foregroundStyle(MoteDesignTokens.primaryInk.color)
                    .padding(.trailing, 2)
                    .padding(.bottom, 6)
                    .frame(width: 52, height: 52)
                    .background(MoteDesignTokens.primaryBackground.color, in: RoundedRectangle(cornerRadius: 12))
                    .accessibilityHidden(true)
                Text("连接你的 Mote")
                    .font(.system(size: 26, weight: .semibold))
                    .tracking(-0.65)
                    .foregroundStyle(MoteDesignTokens.ink.color)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 20)
            .padding(.top, 48)
            Spacer(minLength: 20)
            if let notice {
                warning(notice).padding(.bottom, 14)
            }
            VStack(spacing: 10) {
                MoteCapsuleButton("扫描二维码", icon: .qr, style: .primary, fullWidth: true) { screen = .scan }
                MoteCapsuleButton("粘贴邀请", fullWidth: true) { pasteInvitation() }
                MoteCapsuleButton("选择邀请文件", fullWidth: true) { isImporting = true }
                Button {
                    if let url = URL(string: "https://github.com/utopiafar/mote/blob/main/docs/agent-install.md") { openURL(url) }
                } label: {
                    Text("还没有自己的 Mote？")
                        .font(MoteFont.action)
                        .foregroundStyle(MoteDesignTokens.muted.color)
                        .frame(maxWidth: .infinity, minHeight: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 30)
        }
    }

    private var scanScreen: some View {
        ZStack {
            Color(red: 20 / 255, green: 19 / 255, blue: 18 / 255).ignoresSafeArea()
            QRScanner { text in acceptInvitation(text) }
                .ignoresSafeArea()
            GeometryReader { geometry in
                ZStack {
                    Color.black.opacity(0.35)
                    RoundedRectangle(cornerRadius: 20)
                        .frame(width: 236, height: 236)
                        .position(x: geometry.size.width / 2, y: geometry.size.height / 2 - 8)
                        .blendMode(.destinationOut)
                }
                .compositingGroup()
            }
            .ignoresSafeArea().allowsHitTesting(false)
            VStack(spacing: 0) {
                Color.clear.frame(height: 54)
                HStack {
                    Button { screen = .start } label: {
                        MoteIcon(.close, size: 24).foregroundStyle(.white).frame(width: 44, height: 44)
                    }
                    .accessibilityLabel("关闭")
                    Spacer()
                }
                .padding(.leading, 6)
                Spacer()
                RoundedRectangle(cornerRadius: 20)
                    .strokeBorder(.white.opacity(0.9), lineWidth: 2)
                    .frame(width: 236, height: 236)
                    .accessibilityHidden(true)
                Text("将二维码放入取景框")
                    .font(MoteFont.body).foregroundStyle(.white)
                    .padding(.top, 22)
                Spacer()
                Button { pasteInvitation() } label: {
                    Text("粘贴邀请").font(MoteFont.action).foregroundStyle(.white)
                        .frame(maxWidth: .infinity, minHeight: 44).contentShape(Rectangle())
                }
                    .buttonStyle(.plain)
                    .overlay(Capsule().strokeBorder(.white.opacity(0.4), lineWidth: 1))
                    .padding(.horizontal, 16)
                    .padding(.bottom, 30)
            }
        }
    }

    private var confirmationScreen: some View {
        VStack(spacing: 0) {
            Color.clear.frame(height: 54)
            HStack(spacing: 6) {
                Button {
                    guard connectionState != .connecting else { return }
                    screen = .start; connectionState = .ready
                } label: {
                    Text("取消").font(MoteFont.action).foregroundStyle(MoteDesignTokens.muted.color)
                        .frame(width: 60, height: 44, alignment: .leading).contentShape(Rectangle())
                }
                    .buttonStyle(.plain)
                    .allowsHitTesting(connectionState != .connecting)
                    .accessibilityRepresentation {
                        Button("取消") { screen = .start; connectionState = .ready }
                            .disabled(connectionState == .connecting)
                    }
                Spacer(minLength: 0)
                Text("确认连接").font(MoteFont.appBar).foregroundStyle(MoteDesignTokens.ink.color)
                Spacer(minLength: 0)
                Color.clear.frame(width: 60, height: 44)
            }
            .padding(.horizontal, 16)
            MoteGroup {
                HStack(spacing: 12) {
                    MoteMark()
                    VStack(alignment: .leading, spacing: 1) {
                        Text(centralAddress).font(MoteFont.body).foregroundStyle(MoteDesignTokens.ink.color)
                            .lineLimit(1)
                        Text("本人设备").font(MoteFont.secondary).foregroundStyle(MoteDesignTokens.muted.color)
                    }
                    Spacer()
                }
                .padding(.horizontal, 14)
                .frame(minHeight: 64)
            }
            .padding(.horizontal, 16)
            .padding(.top, 18)
            VStack(alignment: .leading, spacing: 6) {
                Text("设备名称").font(.system(size: 13, weight: .medium))
                    .foregroundStyle(MoteDesignTokens.muted.color).padding(.leading, 2)
                TextField("我的 iPhone", text: $deviceName)
                    .font(MoteFont.body).foregroundStyle(MoteDesignTokens.ink.color)
                    .padding(.horizontal, 12).frame(height: 44)
                    .background(MoteDesignTokens.surface.color, in: RoundedRectangle(cornerRadius: 12))
                    .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(MoteDesignTokens.controlBorder.color, lineWidth: 1))
                    .accessibilityLabel("设备名称")
                    .focused($editingDeviceName)
                    .submitLabel(.done)
                    .onSubmit { editingDeviceName = false }
                    .disabled(connectionState == .connecting)
            }
            .padding(.horizontal, 16)
            .padding(.top, 22)
            MoteGroup {
                HStack {
                    Text("连接后发送").foregroundStyle(MoteDesignTokens.ink.color)
                    Spacer()
                    Text(pendingCount.map { "\($0) 条记录" } ?? "暂时无法读取")
                        .foregroundStyle(MoteDesignTokens.muted.color)
                }
                .font(MoteFont.body).padding(.horizontal, 14).frame(minHeight: 44)
            }
            .padding(.horizontal, 16)
            .padding(.top, 22)
            Spacer(minLength: 20)
            if connectionState == .failed {
                warning(notice ?? "连接未完成").padding(.bottom, 14)
            }
            MoteCapsuleButton(connectionLabel, style: .primary, fullWidth: true) { connect() }
                .compositingGroup()
                .opacity(connectionState == .connecting ? 0.55 : 1)
                .disabled(connectionState != .connecting && pendingCount == nil)
                .allowsHitTesting(connectionState != .connecting)
                .accessibilityRepresentation {
                    Button(connectionLabel) { connect() }
                        .disabled(connectionState == .connecting || pendingCount == nil)
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 30)
        }
    }

    private var centralAddress: String {
        guard let value = invitation?.serverUrl, let components = URLComponents(string: value) else { return "" }
        guard let host = components.host else { return value }
        return components.port.map { "\(host):\($0)" } ?? host
    }

    private var connectionLabel: String {
        switch connectionState {
        case .ready: "确认连接"
        case .connecting: "正在连接…"
        case .failed: "重试"
        }
    }

    private func warning(_ text: String) -> some View {
        Text(text).font(MoteFont.body).foregroundStyle(MoteDesignTokens.ink.color)
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .padding(.leading, 16).padding(.trailing, 8)
            .background(MoteDesignTokens.warningTint.color, in: Capsule())
            .padding(.horizontal, 16)
            .accessibilityAddTraits(.isStaticText)
    }

    private func prepare() {
        #if DEBUG && targetEnvironment(simulator)
        if let count = ProcessInfo.processInfo.environment["MOTE_TEST_QUEUE_ITEMS"].flatMap(Int.init),
           let queue = try? sendQueue() {
            for item in (try? queue.pending()) ?? [] { try? queue.acknowledge(id: item.id) }
            for index in 0..<max(0, count) { _ = try? queue.enqueue(Data("generated \(index)".utf8)) }
        }
        pendingCount = readPendingCount()
        if let value = ProcessInfo.processInfo.environment["MOTE_TEST_PASTE"] {
            UIPasteboard.general.string = value
        }
        if let value = ProcessInfo.processInfo.environment["MOTE_TEST_FILE"],
           let directory = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first {
            try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try? Data(value.utf8).write(to: directory.appendingPathComponent("Mote-invitation.json"), options: .atomic)
        }
        if let state = ProcessInfo.processInfo.environment["MOTE_TEST_STATE"] {
            switch state {
            case "invalid": notice = "邀请已失效"
            case "scan": screen = .scan
            case "confirm", "connecting", "failed":
                if let input = ProcessInfo.processInfo.environment["MOTE_TEST_INVITATION"] {
                    acceptInvitation(input)
                    if state == "connecting" { connectionState = .connecting }
                    if state == "failed" { connectionState = .failed; notice = "连接未完成" }
                }
            default: break
            }
        }
        #else
        pendingCount = readPendingCount()
        #endif
    }

    private func readPendingCount() -> Int? {
        #if DEBUG && targetEnvironment(simulator)
        if let count = ProcessInfo.processInfo.environment["MOTE_TEST_PENDING"].flatMap(Int.init) { return count }
        #endif
        return try? sendQueue().pending().count
    }

    private func sendQueue() throws -> SendQueue {
        #if DEBUG && targetEnvironment(simulator)
        if ProcessInfo.processInfo.environment["MOTE_TEST_QUEUE_ITEMS"] != nil {
            return SendQueue(directoryURL: FileManager.default.temporaryDirectory.appendingPathComponent("MoteUITestQueue"))
        }
        #endif
        return try MoteStorage.sendQueue()
    }

    private func pasteInvitation() {
        guard let text = UIPasteboard.general.string else { screen = .start; notice = "邀请已失效"; return }
        acceptInvitation(text)
    }

    private func importInvitation(_ url: URL) {
        let accessed = url.startAccessingSecurityScopedResource()
        defer { if accessed { url.stopAccessingSecurityScopedResource() } }
        do {
            let file = try FileHandle(forReadingFrom: url)
            defer { try? file.close() }
            guard let data = try file.read(upToCount: ConnectionInvitation.maximumInputBytes + 1),
                  data.count <= ConnectionInvitation.maximumInputBytes,
                  let text = String(data: data, encoding: .utf8) else { throw CentralError.invalidInvitation }
            acceptInvitation(text)
        } catch {
            screen = .start; notice = "邀请已失效"
        }
    }

    private func acceptInvitation(_ text: String) {
        do {
            let value = try ConnectionInvitation.parse(text)
            guard value.platforms?.contains(.ios) == true else {
                screen = .start; notice = "此中央尚不支持 iOS，升级中央后重试"; return
            }
            invitation = value
            notice = nil
            connectionState = .ready
            pendingCount = readPendingCount()
            screen = .confirm
        } catch {
            screen = .start; notice = "邀请已失效"
        }
    }

    private func connect() {
        guard let invitation, connectionState != .connecting else { return }
        pendingCount = readPendingCount()
        guard let pendingCount else { return }
        let name = deviceName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, name.count <= 128 else { connectionState = .failed; notice = "设备名称无效"; return }
        connectionState = .connecting
        notice = nil
        Task {
            do {
                let store = try MoteStorage.connectionStore()
                let existing = try store.read()
                if let existing, existing.serverUrl != invitation.serverUrl, pendingCount > 0 {
                    connectionState = .failed; notice = "有待发送记录，无法更换中央"; return
                }
                let defaults = UserDefaults.standard
                let deviceId = defaults.string(forKey: "mote.deviceId") ?? UUID().uuidString.lowercased()
                defaults.set(deviceId, forKey: "mote.deviceId")
                let connection = try await ConnectionService.establish(invitation: invitation, deviceId: deviceId, deviceName: name)
                try store.save(StoredConnection(
                    serverUrl: connection.credential.serverUrl,
                    token: connection.credential.token,
                    credentialId: connection.credential.credentialId,
                    scope: connection.credential.scope,
                    deviceName: name,
                    connectedAt: Date()
                ))
                connectionState = .ready
                connected = true
            } catch CentralError.unsupportedPlatform {
                screen = .start; notice = "此中央尚不支持 iOS，升级中央后重试"
            } catch {
                connectionState = .failed; notice = "连接未完成"
            }
        }
    }
}
