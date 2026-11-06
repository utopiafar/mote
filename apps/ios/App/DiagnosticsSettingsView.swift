import MoteDesign
import MoteStorage
import SwiftUI
import UniformTypeIdentifiers

private struct LogDocument: FileDocument {
    static let readableContentTypes: [UTType] = [.plainText]
    var text: String
    init(text: String) { self.text = text }
    init(configuration: ReadConfiguration) throws { text = String(decoding: configuration.file.regularFileContents ?? Data(), as: UTF8.self) }
    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper { FileWrapper(regularFileWithContents: Data(text.utf8)) }
}

struct DiagnosticsSettingsView: View {
    let onBack: () -> Void
    private let store: RuntimeLogStore?
    @State private var policy = RuntimeLogPolicy(enabled: true, level: .info)
    @State private var logs: String?
    @State private var message = ""
    @State private var document = LogDocument(text: "")
    @State private var exporting = false

    init(store: RuntimeLogStore? = try? MoteStorage.runtimeLog(), onBack: @escaping () -> Void) {
        self.store = store
        self.onBack = onBack
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                MoteIconButton(icon: .back, label: "返回", action: onBack)
                Spacer()
            }.padding(.horizontal, 6).frame(height: 44)
            Form {
                Section("运行日志") {
                    Toggle("记录运行日志", isOn: $policy.enabled)
                        .accessibilityIdentifier("runtime-log-enabled")
                    Picker("日志级别", selection: $policy.level) {
                        ForEach(RuntimeLogLevel.allCases, id: \.self) { level in
                            Text(level.rawValue.uppercased()).tag(level)
                        }
                    }.accessibilityIdentifier("runtime-log-level")
                    Button("保存日志设置", action: save)
                        .accessibilityIdentifier("runtime-log-save")
                }
                Section("日志目录") {
                    Text(store?.directoryURL.path ?? "日志位置暂不可用")
                        .font(.footnote).textSelection(.enabled)
                    Text("日志位于应用私有空间；关闭后停止新增，已有日志保留。")
                        .font(.footnote).foregroundStyle(.secondary)
                    Button("查看日志") { load() }
                    Button("导出日志") {
                        if let text = load() { document = LogDocument(text: text); exporting = true }
                    }
                    if let logs { Text(logs.isEmpty ? "暂无日志。" : logs).font(.system(.caption, design: .monospaced)).textSelection(.enabled) }
                }
                if !message.isEmpty { Section { Text(message).accessibilityIdentifier("runtime-log-message") } }
            }
            .scrollContentBackground(.hidden)
        }
        .background(MoteDesignTokens.background.color)
        .onAppear { readPolicy() }
        .fileExporter(isPresented: $exporting, document: document, contentType: .plainText, defaultFilename: "mote.log") { result in
            if case .failure = result { message = "日志导出失败，请重试。" }
        }
    }
    private func readPolicy() {
        do { guard let store else { throw CocoaError(.fileNoSuchFile) }; policy = try store.readPolicy() }
        catch { message = "日志设置读取失败，请重试。" }
    }
    private func save() {
        do { guard let store else { throw CocoaError(.fileNoSuchFile) }; try store.savePolicy(policy); message = "已保存，立即生效。" }
        catch { message = "日志设置保存失败，请重试。" }
    }
    @discardableResult private func load() -> String? {
        do { guard let store else { throw CocoaError(.fileNoSuchFile) }; let text = try store.readLogs(); logs = text; message = ""; return text }
        catch { message = "日志读取失败，请重试。"; return nil }
    }
}
