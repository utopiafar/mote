import AVFoundation
import PhotosUI
import SwiftUI
import UIKit
import UniformTypeIdentifiers
import MoteDesign
import MoteStorage

struct EditorFlowView: View {
    @StateObject private var model: EditorModel
    @State private var didLoad = false
    private let fixtureName: String?
    private let descriptionExpanded: Bool

    init(store: EditorDraftStore, arguments: [String]) {
        _model = StateObject(wrappedValue: EditorModel(store: store))
        fixtureName = Self.argument("-MoteEditorFixture", in: arguments)
        descriptionExpanded = Self.argument("-MoteEditorDescribe", in: arguments) == "true"
    }

    var body: some View {
        Group {
            if model.isEditorVisible {
                EditorView(model: model)
            } else {
                EditorHomeView(model: model)
            }
        }
        .background(MoteDesignTokens.background.color.ignoresSafeArea())
        .onAppear {
            guard !didLoad else { return }
            didLoad = true
            model.load(fixtureName: fixtureName, descriptionExpanded: descriptionExpanded)
        }
    }

    private static func argument(_ name: String, in arguments: [String]) -> String? {
        guard let index = arguments.firstIndex(of: name), arguments.indices.contains(index + 1) else {
            return nil
        }
        return arguments[index + 1]
    }
}

private struct EditorHomeView: View {
    @ObservedObject var model: EditorModel

    var body: some View {
        VStack {
            Spacer()
            MoteCapsuleButton(model.hasDraft ? "继续草稿" : "记录", style: .primary, fullWidth: true) {
                model.isEditorVisible = true
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 12)
        }
        .accessibilityIdentifier("mote-editor-home")
    }
}

private struct EditorView: View {
    @ObservedObject var model: EditorModel
    @StateObject private var audioPlayer = EditorAudioPlayer()
    @State private var photoItem: PhotosPickerItem?
    @State private var isCameraPresented = false
    @State private var isFileImporterPresented = false

    var body: some View {
        VStack(spacing: 0) {
            topBar
            VStack(alignment: .leading, spacing: 16) {
                TextField(
                    "",
                    text: Binding(get: { model.session.draft.text }, set: model.updateText),
                    axis: .vertical
                )
                .font(MoteFont.reading)
                .lineSpacing(7)
                .tint(MoteDesignTokens.accent.color)
                .foregroundStyle(MoteDesignTokens.ink.color)
                .padding(.horizontal, 20)
                .padding(.top, 6)
                .accessibilityLabel("记录")
                .accessibilityIdentifier("mote-editor-text")
                .overlay(alignment: .topLeading) {
                    if model.session.draft.text.isEmpty {
                        Text("记录")
                            .font(MoteFont.reading)
                            .foregroundStyle(MoteDesignTokens.muted.color)
                            .padding(.horizontal, 20)
                            .padding(.top, 6)
                            .allowsHitTesting(false)
                            .accessibilityHidden(true)
                    }
                }

                if model.hasDraft {
                    attachmentStack
                }
            }
            Spacer(minLength: 0)
            if let errorMessage = model.errorMessage {
                Text(errorMessage)
                    .font(MoteFont.secondary)
                    .foregroundStyle(MoteDesignTokens.danger.color)
                    .padding(.horizontal, 20)
                    .padding(.bottom, 8)
            }
            if model.session.canUndoClear {
                MoteToast(title: "已清空", actionTitle: "撤销") {
                    audioPlayer.stop()
                    model.undoClear()
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 14)
            }
            toolbar
        }
        .background(MoteDesignTokens.background.color)
        .statusBarHidden(true)
        .onDisappear {
            audioPlayer.stop()
        }
        .onChange(of: photoItem) { _, item in
            Task { @MainActor in
                await importPhoto(item)
            }
        }
        .fullScreenCover(isPresented: $isCameraPresented) {
            CameraPicker { data in
                do {
                    model.add(try model.store.importData(data, kind: .photo, fileName: "照片.jpg"))
                } catch {
                    model.errorMessage = "照片未能添加"
                }
            }
            .ignoresSafeArea()
        }
        .fileImporter(
            isPresented: $isFileImporterPresented,
            allowedContentTypes: [.data, .audio, .image]
        ) { result in
            importFile(result)
        }
    }

    private var topBar: some View {
        HStack(spacing: 6) {
            MoteIconButton(icon: .back, label: "返回") {
                model.back()
            }
            Spacer()
            if model.hasDraft {
                Button("清空") {
                    audioPlayer.stop()
                    model.clear()
                }
                .buttonStyle(.plain)
                .font(MoteFont.action)
                .foregroundStyle(MoteDesignTokens.muted.color)
                .padding(.horizontal, 8)
                .frame(height: 44)
                .contentShape(Rectangle())
            }
            Button {
                model.save()
            } label: {
                Text("保存")
                    .font(MoteFont.action)
                    .foregroundStyle(MoteDesignTokens.primaryInk.color)
                    .padding(.horizontal, 12)
                    .frame(height: 34)
                    .background(MoteDesignTokens.primaryBackground.color, in: Capsule())
                    .contentShape(Capsule())
            }
            .buttonStyle(.plain)
            .frame(height: 44)
            .contentShape(Rectangle())
        }
        .padding(.leading, 6)
        .padding(.trailing, 12)
        .frame(height: 44)
    }

    private var attachmentStack: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(model.session.draft.attachments) { attachment in
                switch attachment.kind {
                case .photo:
                    photoAttachment(attachment)
                case .audio:
                    audioAttachment(attachment)
                case .file:
                    fileAttachment(attachment)
                }
            }
            if model.isDescriptionExpanded {
                TextField(
                    "",
                    text: Binding(
                        get: { model.session.draft.sourceDescription },
                        set: model.updateSourceDescription
                    ),
                    axis: .vertical
                )
                .font(MoteFont.body)
                .tint(MoteDesignTokens.accent.color)
                .foregroundStyle(MoteDesignTokens.ink.color)
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
                .frame(minHeight: 76, alignment: .topLeading)
                .background(MoteDesignTokens.surface.color)
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                .overlay {
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .strokeBorder(MoteDesignTokens.controlBorder.color, lineWidth: 1)
                }
                .overlay(alignment: .topLeading) {
                    if model.session.draft.sourceDescription.isEmpty {
                        Text("资料说明")
                            .font(MoteFont.body)
                            .foregroundStyle(MoteDesignTokens.muted.color)
                            .padding(.horizontal, 12)
                            .padding(.top, 10)
                            .allowsHitTesting(false)
                            .accessibilityHidden(true)
                    }
                }
                .accessibilityLabel("资料说明")
                .accessibilityIdentifier("mote-source-description")
            } else {
                Button {
                    model.isDescriptionExpanded = true
                } label: {
                    HStack(spacing: 8) {
                        MoteIcon(.plus, size: 16)
                        Text("资料说明")
                            .font(MoteFont.action)
                    }
                    .foregroundStyle(MoteDesignTokens.accent.color)
                    .padding(.horizontal, 4)
                    .frame(minHeight: 44)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 16)
    }

    private func photoAttachment(_ attachment: EditorAttachment) -> some View {
        ZStack(alignment: .topTrailing) {
            if let image = UIImage(contentsOfFile: model.store.fileURL(for: attachment).path) {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
            } else {
                MoteDesignTokens.surfaceSunken.color
                    .overlay {
                        MoteIcon(.photo, size: 24)
                            .foregroundStyle(MoteDesignTokens.muted.color)
                    }
            }
        }
        .frame(width: 148, height: 112)
        .background(MoteDesignTokens.surfaceSunken.color)
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(MoteDesignTokens.hair.color, lineWidth: 1)
        }
        .overlay(alignment: .topTrailing) {
            Button {
                model.remove(attachment)
            } label: {
                ZStack {
                    Circle()
                        .fill(Color.black.opacity(0.62))
                        .frame(width: 24, height: 24)
                    MoteIcon(.close, size: 16)
                        .foregroundStyle(.white)
                }
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("移除照片")
            .padding(.top, -4)
            .padding(.trailing, -4)
        }
        .accessibilityIdentifier("mote-photo-attachment")
    }

    private func audioAttachment(_ attachment: EditorAttachment) -> some View {
        MoteGroup {
            HStack(spacing: 8) {
                Button {
                    do {
                        try audioPlayer.toggle(attachment, url: model.store.fileURL(for: attachment))
                    } catch {
                        model.errorMessage = "录音未能播放"
                    }
                } label: {
                    MoteIcon(audioPlayer.playingID == attachment.id ? .pause : .play, size: 20)
                        .foregroundStyle(MoteDesignTokens.ink.color)
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(audioPlayer.playingID == attachment.id ? "暂停录音" : "播放录音")
                VStack(alignment: .leading, spacing: 1) {
                    Text("录音")
                        .font(MoteFont.action)
                        .foregroundStyle(MoteDesignTokens.ink.color)
                    Text(Self.duration(attachment.duration ?? 0))
                        .font(MoteFont.secondary)
                        .foregroundStyle(MoteDesignTokens.muted.color)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                MoteIconButton(icon: .close, label: "移除录音", style: .muted) {
                    audioPlayer.stop()
                    model.remove(attachment)
                }
            }
            .padding(.leading, 6)
            .padding(.trailing, 4)
            .padding(.vertical, 4)
        }
        .accessibilityIdentifier("mote-audio-attachment")
    }

    private func fileAttachment(_ attachment: EditorAttachment) -> some View {
        MoteGroup {
            HStack(spacing: 8) {
                MoteIcon(.file, size: 20)
                    .foregroundStyle(MoteDesignTokens.muted.color)
                    .frame(width: 44, height: 44)
                Text(attachment.fileName)
                    .font(MoteFont.body)
                    .foregroundStyle(MoteDesignTokens.ink.color)
                    .lineLimit(1)
                    .frame(maxWidth: .infinity, alignment: .leading)
                MoteIconButton(icon: .close, label: "移除文件", style: .muted) {
                    model.remove(attachment)
                }
            }
            .padding(.leading, 6)
            .padding(.trailing, 4)
            .padding(.vertical, 4)
        }
        .accessibilityIdentifier("mote-file-attachment")
    }

    private var toolbar: some View {
        HStack(spacing: 2) {
            MoteIconButton(icon: .camera, label: "拍照") {
                if UIImagePickerController.isSourceTypeAvailable(.camera) {
                    isCameraPresented = true
                } else {
                    model.errorMessage = "此设备无法拍照"
                }
            }
            PhotosPicker(selection: $photoItem, matching: .images) {
                photoPickerLabel
            }
            .buttonStyle(.plain)
            .accessibilityLabel("照片")
            MoteIconButton(icon: .mic, label: "录音") {}
            MoteIconButton(icon: .file, label: "文件") {
                isFileImporterPresented = true
            }
            Spacer()
        }
        .padding(.horizontal, 8)
        .padding(.top, 4)
        .frame(height: 48)
        .overlay(alignment: .top) {
            Rectangle()
                .fill(MoteDesignTokens.hair.color)
                .frame(height: 1)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("添加")
    }

    @MainActor
    private var photoPickerLabel: some View {
        MoteIcon(.photo, size: 24)
            .foregroundStyle(MoteDesignTokens.ink.color)
            .frame(width: 44, height: 44)
            .contentShape(Rectangle())
    }

    private func importPhoto(_ item: PhotosPickerItem?) async {
        guard let item else { return }
        do {
            guard let data = try await item.loadTransferable(type: Data.self) else { return }
            model.add(try model.store.importData(data, kind: .photo, fileName: "照片.jpg"))
            photoItem = nil
        } catch {
            model.errorMessage = "照片未能添加"
        }
    }

    private func importFile(_ result: Result<URL, Error>) {
        do {
            let sourceURL = try result.get()
            let accessing = sourceURL.startAccessingSecurityScopedResource()
            defer {
                if accessing { sourceURL.stopAccessingSecurityScopedResource() }
            }
            let type = UTType(filenameExtension: sourceURL.pathExtension)
            let kind: EditorAttachmentKind
            let duration: TimeInterval?
            if type?.conforms(to: .audio) == true {
                kind = .audio
                duration = try? AVAudioPlayer(contentsOf: sourceURL).duration
            } else if type?.conforms(to: .image) == true {
                kind = .photo
                duration = nil
            } else {
                kind = .file
                duration = nil
            }
            model.add(try model.store.importFile(at: sourceURL, kind: kind, duration: duration ?? nil))
        } catch {
            model.errorMessage = "文件未能添加"
        }
    }

    private static func duration(_ duration: TimeInterval) -> String {
        let seconds = max(0, Int(duration.rounded()))
        return String(format: "%02d:%02d", seconds / 60, seconds % 60)
    }
}

@MainActor
private final class EditorAudioPlayer: NSObject, ObservableObject, AVAudioPlayerDelegate {
    @Published private(set) var playingID: String?
    private var currentID: String?
    private var player: AVAudioPlayer?

    func toggle(_ attachment: EditorAttachment, url: URL) throws {
        if playingID == attachment.id {
            player?.pause()
            playingID = nil
            return
        }
        if currentID == attachment.id, let player {
            player.play()
            playingID = attachment.id
            return
        }
        stop()
        let player = try AVAudioPlayer(contentsOf: url)
        player.delegate = self
        player.prepareToPlay()
        player.play()
        self.player = player
        currentID = attachment.id
        playingID = attachment.id
    }

    func stop() {
        player?.stop()
        player = nil
        currentID = nil
        playingID = nil
    }

    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        Task { @MainActor [weak self] in
            self?.stop()
        }
    }
}

private struct CameraPicker: UIViewControllerRepresentable {
    let onCapture: (Data) -> Void
    @Environment(\.dismiss) private var dismiss

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let controller = UIImagePickerController()
        controller.sourceType = .camera
        controller.cameraCaptureMode = .photo
        controller.delegate = context.coordinator
        return controller
    }

    func updateUIViewController(_ uiViewController: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator {
        Coordinator(onCapture: onCapture) {
            dismiss()
        }
    }

    @MainActor
    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        private let onCapture: (Data) -> Void
        private let close: () -> Void

        init(onCapture: @escaping (Data) -> Void, close: @escaping () -> Void) {
            self.onCapture = onCapture
            self.close = close
        }

        func imagePickerController(
            _ picker: UIImagePickerController,
            didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]
        ) {
            if let image = info[.originalImage] as? UIImage, let data = image.jpegData(compressionQuality: 0.9) {
                onCapture(data)
            }
            close()
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            close()
        }
    }
}
