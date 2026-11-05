import SwiftUI
import UIKit
import MoteCentral
import MoteDesign

struct ShareFilePreview: Equatable {
    let name: String
    let sizeText: String

    init(name: String, sizeText: String) {
        self.name = name
        self.sizeText = sizeText
    }
}

struct SharePanelContent: Equatable {
    var link: ShareLinkPreview?
    var images: [Data] = []
    var files: [ShareFilePreview] = []

    init(link: ShareLinkPreview? = nil, images: [Data] = [], files: [ShareFilePreview] = []) {
        self.link = link
        self.images = images
        self.files = files
    }

    var isEmpty: Bool {
        link == nil && images.isEmpty && files.isEmpty
    }

    static func formatBytes(_ bytes: Int) -> String {
        let formatter = ByteCountFormatter()
        formatter.allowedUnits = [.useKB, .useMB, .useGB]
        formatter.countStyle = .file
        return formatter.string(fromByteCount: Int64(bytes))
    }
}

extension ShareRequest {
    /// How one shared request is previewed above the note. Links keep their
    /// title and domain; every other attachment is a file, with images shown
    /// as thumbnails.
    var panelContent: SharePanelContent {
        var images: [Data] = []
        var files: [ShareFilePreview] = []
        for attachment in attachments {
            if attachment.mimeType.hasPrefix("image/") {
                images.append(attachment.data)
            } else {
                files.append(ShareFilePreview(
                    name: attachment.fileName,
                    sizeText: SharePanelContent.formatBytes(attachment.data.count)
                ))
            }
        }
        return SharePanelContent(link: link, images: images, files: files)
    }
}

/// The dimmed backdrop behind the panel, matching the design scrim in both
/// appearances.
struct ShareScrim: View {
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        (colorScheme == .dark ? Color.black : MoteDesignTokens.ink.color)
            .opacity(colorScheme == .dark ? 0.55 : 0.36)
            .ignoresSafeArea()
    }
}

/// The compact panel used by the share extension. The app's preview harness
/// renders the same view so light/dark screenshots exercise production layout.
struct SharePanelView: View {
    let content: SharePanelContent
    @Binding var note: String
    @Binding var descriptionText: String
    @Binding var isDescriptionExpanded: Bool
    let saved: Bool
    let errorMessage: String?
    let saveEnabled: Bool
    let onCancel: () -> Void
    let onSave: () -> Void
    var title = "保存到 Mote"
    var notePlaceholder = "备注"

    var body: some View {
        VStack(spacing: 0) {
            Capsule()
                .fill(MoteDesignTokens.border.color)
                .frame(width: 36, height: 5)
                .padding(.top, 6)
                .padding(.bottom, 2)
            header
            VStack(alignment: .leading, spacing: 12) {
                previews
                noteField
                descriptionControls
                if let errorMessage {
                    Text(errorMessage)
                        .font(MoteFont.secondary)
                        .foregroundStyle(MoteDesignTokens.danger.color)
                        .accessibilityIdentifier("mote-share-error")
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 12)
            Color.clear
                .frame(height: 44)
        }
        .background(MoteDesignTokens.surfaceRaised.color)
        .clipShape(UnevenRoundedRectangle(topLeadingRadius: 24, topTrailingRadius: 24))
        .overlay {
            if saved {
                doneOverlay
                    .clipShape(UnevenRoundedRectangle(topLeadingRadius: 24, topTrailingRadius: 24))
            }
        }
    }

    private var header: some View {
        ZStack {
            Text(title)
                .font(MoteFont.appBar)
                .foregroundStyle(MoteDesignTokens.ink.color)
                .lineLimit(1)
                .accessibilityAddTraits(.isHeader)
            HStack(spacing: 0) {
                Button(action: onCancel) {
                    Text("取消")
                        .font(MoteFont.body)
                        .foregroundStyle(MoteDesignTokens.muted.color)
                        .padding(.horizontal, 8)
                        .frame(height: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                Spacer(minLength: 0)
                Button(action: onSave) {
                    Text("保存")
                        .font(MoteFont.smallAction)
                        .foregroundStyle(MoteDesignTokens.primaryInk.color)
                        .padding(.horizontal, 12)
                        .frame(height: 34)
                        .background(MoteDesignTokens.primaryBackground.color, in: Capsule())
                        .frame(height: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(!saveEnabled || saved)
                .opacity(saveEnabled && !saved ? 1 : 0.45)
            }
        }
        .padding(.leading, 8)
        .padding(.trailing, 12)
        .frame(height: 44)
    }

    @ViewBuilder
    private var previews: some View {
        if let link = content.link {
            MoteGroup {
                HStack(spacing: 12) {
                    thumbnail(icon: .link)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(link.title)
                            .font(MoteFont.body.weight(.medium))
                            .foregroundStyle(MoteDesignTokens.ink.color)
                            .lineLimit(1)
                        Text(link.domain)
                            .font(MoteFont.secondary)
                            .foregroundStyle(MoteDesignTokens.muted.color)
                            .lineLimit(1)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 9)
                .frame(minHeight: 64)
            }
            .accessibilityIdentifier("mote-share-link")
        }
        if !content.images.isEmpty {
            HStack(spacing: 8) {
                ForEach(Array(content.images.enumerated()), id: \.offset) { _, data in
                    imageThumbnail(data)
                }
                Spacer(minLength: 0)
            }
            .padding(12)
            .background(MoteDesignTokens.surface.color)
            .clipShape(RoundedRectangle(cornerRadius: MoteMetrics.groupRadius, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: MoteMetrics.groupRadius, style: .continuous)
                    .strokeBorder(MoteDesignTokens.hair.color, lineWidth: 1)
            }
            .accessibilityIdentifier("mote-share-images")
        }
        ForEach(Array(content.files.enumerated()), id: \.offset) { _, file in
            MoteGroup {
                HStack(spacing: 12) {
                    thumbnail(icon: .file)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(file.name)
                            .font(MoteFont.body.weight(.medium))
                            .foregroundStyle(MoteDesignTokens.ink.color)
                            .lineLimit(1)
                        Text(file.sizeText)
                            .font(MoteFont.secondary)
                            .foregroundStyle(MoteDesignTokens.muted.color)
                            .lineLimit(1)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 9)
                .frame(minHeight: 64)
            }
            .accessibilityIdentifier("mote-share-file")
        }
    }

    private func thumbnail(icon: MoteIconName) -> some View {
        MoteIcon(icon, size: 20)
            .foregroundStyle(MoteDesignTokens.muted.color)
            .frame(width: 40, height: 40)
            .background(MoteDesignTokens.surfaceSunken.color)
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .strokeBorder(MoteDesignTokens.hair.color, lineWidth: 1)
            }
    }

    @ViewBuilder
    private func imageThumbnail(_ data: Data) -> some View {
        Group {
            if let image = UIImage(data: data) {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
            } else {
                MoteDesignTokens.surfaceSunken.color
                    .overlay {
                        MoteIcon(.photo, size: 20)
                            .foregroundStyle(MoteDesignTokens.muted.color)
                    }
            }
        }
        .frame(width: 72, height: 72)
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .strokeBorder(MoteDesignTokens.hair.color, lineWidth: 1)
        }
        .accessibilityLabel("照片")
        .accessibilityIdentifier("mote-share-image")
    }

    private var noteField: some View {
        TextField("", text: $note, prompt: Text(notePlaceholder).foregroundStyle(MoteDesignTokens.muted.color), axis: .vertical)
            .font(MoteFont.body)
            .lineSpacing(4)
            .tint(MoteDesignTokens.accent.color)
            .foregroundStyle(MoteDesignTokens.ink.color)
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .frame(minHeight: 96, alignment: .topLeading)
            .background(MoteDesignTokens.surface.color)
            .clipShape(RoundedRectangle(cornerRadius: MoteMetrics.fieldRadius, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: MoteMetrics.fieldRadius, style: .continuous)
                    .strokeBorder(MoteDesignTokens.controlBorder.color, lineWidth: 1)
            }
            .accessibilityLabel(notePlaceholder)
            .accessibilityIdentifier("mote-share-note")
    }

    @ViewBuilder
    private var descriptionControls: some View {
        if isDescriptionExpanded {
            TextField("", text: $descriptionText,
                      prompt: Text("资料说明").foregroundStyle(MoteDesignTokens.muted.color), axis: .vertical)
                .font(MoteFont.body)
                .lineSpacing(4)
                .tint(MoteDesignTokens.accent.color)
                .foregroundStyle(MoteDesignTokens.ink.color)
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
                .frame(minHeight: 76, alignment: .topLeading)
                .background(MoteDesignTokens.surface.color)
                .clipShape(RoundedRectangle(cornerRadius: MoteMetrics.fieldRadius, style: .continuous))
                .overlay {
                    RoundedRectangle(cornerRadius: MoteMetrics.fieldRadius, style: .continuous)
                        .strokeBorder(MoteDesignTokens.controlBorder.color, lineWidth: 1)
                }
                .accessibilityLabel("资料说明")
                .accessibilityIdentifier("mote-share-description")
        } else {
            Button {
                isDescriptionExpanded = true
            } label: {
                HStack(spacing: 8) {
                    MoteIcon(.plus, size: 16)
                    Text("资料说明")
                        .font(MoteFont.action)
                }
                .foregroundStyle(MoteDesignTokens.accent.color)
                .padding(.horizontal, 4)
                .frame(height: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("mote-share-description-toggle")
        }
    }

    private var doneOverlay: some View {
        VStack(spacing: 12) {
            ZStack {
                Circle()
                    .fill(MoteDesignTokens.successTint.color)
                MoteIcon(.check, size: 24)
                    .foregroundStyle(MoteDesignTokens.success.color)
            }
            .frame(width: 52, height: 52)
            Text("已保存")
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(MoteDesignTokens.ink.color)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(MoteDesignTokens.surfaceRaised.color)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("mote-share-done")
    }
}
