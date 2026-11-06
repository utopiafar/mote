import SwiftUI
import UIKit
import MoteCentral
import MoteDesign
import MoteStorage

/// Generated share states for visual and interaction checks. The panel is the
/// production view used by the extension; saving writes to a private temporary
/// queue so preview runs never touch the device's real records or draft.
struct SharePreview: View {
    @StateObject private var model: SharePreviewModel

    init() {
        let arguments = ProcessInfo.processInfo.arguments
        let state = Self.argument("-MoteShareState", in: arguments) ?? "link"
        _model = StateObject(wrappedValue: SharePreviewModel(state: state))
    }

    var body: some View {
        ZStack(alignment: .bottom) {
            MoteDesignTokens.background.color.ignoresSafeArea()
            ShareScrim()
            if model.closed {
                Text("已关闭")
                    .font(.system(size: 1))
                    .opacity(0.01)
                    .frame(width: 1, height: 1)
                    .accessibilityIdentifier("mote-share-preview-closed")
            } else {
                SharePanelView(
                    content: model.content,
                    note: $model.note,
                    descriptionText: $model.descriptionText,
                    isDescriptionExpanded: $model.isDescriptionExpanded,
                    saved: model.saved,
                    errorMessage: model.errorMessage,
                    saveEnabled: model.canSave,
                    onCancel: { model.closed = true },
                    onSave: { model.save() }
                )
            }
        }
        .statusBarHidden()
        .ignoresSafeArea(edges: .bottom)
    }

    private static func argument(_ name: String, in arguments: [String]) -> String? {
        guard let index = arguments.firstIndex(of: name), arguments.indices.contains(index + 1) else {
            return nil
        }
        return arguments[index + 1]
    }
}

@MainActor
final class SharePreviewModel: ObservableObject {
    let content: SharePanelContent
    @Published var note = "周末试一下，6 小时那版。"
    @Published var descriptionText = ""
    @Published var isDescriptionExpanded = false
    @Published var saved = false
    @Published var closed = false
    @Published var errorMessage: String?
    private let request: ShareRequest

    init(state: String) {
        request = SharePreviewModel.fixtures(state: state)
        content = request.panelContent
        note = state == "answer" ? "周五前把账单照片发给房东。" : "周末试一下，6 小时那版。"
        isDescriptionExpanded = state == "describe"
        saved = state == "done"
    }

    var canSave: Bool {
        !saved && (!note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || !request.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || request.link != nil || !request.attachments.isEmpty
            || request.conversation != nil)
    }

    func save() {
        guard canSave else { return }
        do {
            let root = FileManager.default.temporaryDirectory
                .appendingPathComponent("mote-share-preview-\(UUID().uuidString)", isDirectory: true)
            let queue = SendQueue(directoryURL: root.appendingPathComponent("Queue", isDirectory: true))
            let store = ShareAttachmentStore(directoryURL: root.appendingPathComponent("Attachments", isDirectory: true))
            _ = try ShareSubmission.save(
                request: request,
                note: note,
                description: descriptionText,
                deviceId: "generated-iphone",
                deviceName: "Generated iPhone",
                queue: queue,
                attachmentStore: store
            )
            saved = true
            Task { @MainActor in
                try? await Task.sleep(for: .milliseconds(2500))
                closed = true
            }
        } catch {
            errorMessage = "未能保存"
        }
    }

    private static func fixtures(state: String) -> ShareRequest {
        let link = ShareLinkPreview(
            url: "https://www.seriouseats.com/low-temperature-beef-ribs",
            title: "低温慢烤牛肋排的时间表",
            domain: "seriouseats.com"
        )
        switch state {
        case "answer":
            return ShareRequest(conversation: ShareConversationQuote(
                question: "暖气费是怎么约定的？",
                answer: "按实际用量分摊暖气费，月底前把账单照片发给房东；押金下个月退，需要收据。",
                displayAnswer: "按实际用量分摊暖气费，月底前把账单照片发给房东；押金下个月退，需要收据。",
                conversationId: "11111111-2222-3333-4444-555555555555",
                turnId: "turn-1"
            ))
        case "images":
            let images = [image(lines: true), image(document: true), image(landscape: true)]
            let attachments = images.enumerated().map { index, data in
                ShareAttachmentData(data: data, fileName: "照片\(index + 1).png", mimeType: "image/png")
            }
            return ShareRequest(attachments: attachments)
        case "file":
            let data = Data(repeating: 0x25, count: 2_400_000)
            return ShareRequest(attachments: [ShareAttachmentData(
                data: data, fileName: "季度计划.pdf", mimeType: "application/pdf"
            )])
        default:
            return ShareRequest(text: "低温慢烤牛肋排的时间表", link: link)
        }
    }

    private static func image(lines: Bool = false, document: Bool = false, landscape: Bool = false) -> Data {
        let size = CGSize(width: 144, height: 144)
        let renderer = UIGraphicsImageRenderer(size: size)
        return renderer.pngData { context in
            let canvas = context.cgContext
            func color(_ hex: UInt32) -> CGColor {
                UIColor(red: CGFloat((hex >> 16) & 255) / 255,
                        green: CGFloat((hex >> 8) & 255) / 255,
                        blue: CGFloat(hex & 255) / 255, alpha: 1).cgColor
            }
            if lines {
                canvas.setFillColor(color(0xe9e5dc))
                canvas.fill(CGRect(origin: .zero, size: size))
                canvas.setFillColor(color(0xf8f7f3))
                canvas.fill(CGRect(x: 16, y: 16, width: 112, height: 112))
                canvas.setStrokeColor(color(0x2f5d9e))
                canvas.setLineWidth(4)
                canvas.setLineCap(.round)
                for (y, end) in [(44.0, 72.0), (64.0, 104.0), (84.0, 56.0)] {
                    canvas.move(to: CGPoint(x: 32, y: y))
                    canvas.addLine(to: CGPoint(x: end, y: y))
                }
                canvas.strokePath()
            } else if document {
                canvas.setFillColor(color(0xd9d2c4))
                canvas.fill(CGRect(origin: .zero, size: size))
                canvas.setFillColor(color(0xfbfaf6))
                canvas.fill(CGRect(x: 44, y: 16, width: 56, height: 112))
                canvas.setStrokeColor(color(0x8b847a))
                canvas.setLineWidth(3)
                canvas.setLineCap(.round)
                for (y, end) in [(36.0, 80.0), (52.0, 60.0), (68.0, 80.0), (84.0, 30.0)] {
                    canvas.move(to: CGPoint(x: 54, y: y))
                    canvas.addLine(to: CGPoint(x: end + 54, y: y))
                }
                canvas.strokePath()
            } else {
                canvas.setFillColor(color(0xc9d3c2))
                canvas.fill(CGRect(origin: .zero, size: size))
                canvas.setFillColor(color(0x8fa287))
                canvas.beginPath()
                canvas.move(to: CGPoint(x: 0, y: 104))
                canvas.addLine(to: CGPoint(x: 40, y: 68))
                canvas.addLine(to: CGPoint(x: 68, y: 92))
                canvas.addLine(to: CGPoint(x: 92, y: 72))
                canvas.addLine(to: CGPoint(x: 144, y: 116))
                canvas.addLine(to: CGPoint(x: 144, y: 144))
                canvas.addLine(to: CGPoint(x: 0, y: 144))
                canvas.closePath()
                canvas.fillPath()
                canvas.setFillColor(color(0xf1e6c8))
                canvas.fillEllipse(in: CGRect(x: 90, y: 26, width: 28, height: 28))
            }
        }
    }
}
