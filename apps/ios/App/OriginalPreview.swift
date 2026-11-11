import MoteCentral
import SwiftUI
import UIKit

struct OriginalPreview: View {
    @State private var lastAction = "none"
    @State private var deleteAttempts = 0
    @State private var destination: HomeDestination?
    private let arguments = ProcessInfo.processInfo.arguments

    var body: some View {
        Group {
            if let destination {
                HomeDestinationView(
                    destination: destination,
                    editorStore: nil,
                    arguments: arguments,
                    onAsk: { _ in },
                    onClearScope: { self.destination = .ask(nil) },
                    onOpenConnection: {},
                    onOpenOriginal: { _ in }
                )
            } else {
                OriginalView(
                    presentation: presentation,
                    hero: .image(state == "screen" ? screenshot : photo),
                    initialPanel: state == "panel-detail" ? .detail : state == "panel-more" ? .more : nil,
                    onBack: { lastAction = "back" },
                    onAsk: {
                        lastAction = "ask.\($0.id)"
                        destination = .ask($0)
                    },
                    onDelete: {
                        deleteAttempts += 1
                        return state == "deleteError" ? "未能确认删除完成。原文仍保留，刷新后可核对当前状态。" : nil
                    },
                    onDeleted: { lastAction = "deleted" }
                )
            }
        }
        .statusBarHidden()
        .overlay(alignment: .topLeading) {
            Text(lastAction)
                .font(.system(size: 1))
                .opacity(0.01)
                .frame(width: 1, height: 1)
                .accessibilityIdentifier("reader-preview-action")
            Text("delete-attempts.\(deleteAttempts)")
                .font(.system(size: 1))
                .opacity(0.01)
                .frame(width: 1, height: 1)
                .accessibilityIdentifier("reader-delete-attempts")
        }
    }

    private var state: String {
        guard let index = arguments.firstIndex(of: "-MoteReaderState"), arguments.indices.contains(index + 1) else {
            return "reader"
        }
        return arguments[index + 1]
    }

    private var presentation: OriginalPresentation {
        let calendar = Calendar.current
        let today = calendar.startOfDay(for: Date())
        func at(_ hour: Int, _ minute: Int) -> Date {
            calendar.date(bySettingHour: hour, minute: minute, second: 0, of: today)!
        }
        if state == "screen" {
            return OriginalPresentation(
                id: "00000000-0000-4000-8000-000000000001",
                title: "房屋租赁合同",
                text: "第 4 页：押金为两个月租金，下个月退，需要收据。\n退租时按交接单核对房屋和物品。",
                capturedAt: at(14, 20),
                receivedAt: at(14, 22),
                organizedAt: at(14, 25),
                indexingStatus: "indexed",
                sourceDescription: "截图 · 我的 iPhone",
                referenceCount: 2,
                deletionKind: .capture,
                source: .screen,
                hasImage: true
            )
        }
        return OriginalPresentation(
            id: "00000000-0000-4000-8000-000000000001",
            title: "暖气费按实际用量分摊，月底前给账单照片",
            text: "周四和房东确认：暖气费按实际用量分摊，月底前把账单照片发给他。押金下个月退，记得要收据。",
            capturedAt: at(14, 20),
            receivedAt: at(14, 22),
            organizedAt: at(14, 25),
            indexingStatus: "indexed",
            sourceDescription: "记录 · 我的 iPhone",
            referenceCount: 2,
            deletionKind: .capture,
            highlightedPhrase: "暖气费按实际用量分摊，月底前把账单照片发给他。"
        )
    }

    /// A generated photo of a bill on a table.
    private var photo: UIImage {
        UIGraphicsImageRenderer(size: CGSize(width: 148 * 2.4, height: 112 * 2.4)).image { context in
            let canvas = context.cgContext
            canvas.scaleBy(x: 2.4, y: 2.4)
            canvas.setFillColor(color(0xe9e5dc))
            canvas.fill(CGRect(x: 0, y: 0, width: 148, height: 112))
            canvas.setFillColor(color(0xf8f7f3))
            canvas.fill(CGRect(x: 10, y: 10, width: 128, height: 92))
            canvas.setStrokeColor(color(0x3a3632))
            canvas.setLineWidth(2.4)
            canvas.setLineCap(.round)
            for (y, end) in [(30.0, 70.0), (42.0, 92.0), (54.0, 58.0), (74.0, 66.0)] {
                canvas.move(to: CGPoint(x: 22, y: y))
                canvas.addLine(to: CGPoint(x: end, y: y))
            }
            canvas.strokePath()
            canvas.setStrokeColor(color(0xb5432f))
            canvas.move(to: CGPoint(x: 98, y: 66))
            canvas.addLine(to: CGPoint(x: 106, y: 74))
            canvas.addLine(to: CGPoint(x: 122, y: 56))
            canvas.strokePath()
        }
    }

    /// A generated phone screenshot of a contract page.
    private var screenshot: UIImage {
        UIGraphicsImageRenderer(size: CGSize(width: 390, height: 844)).image { context in
            let canvas = context.cgContext
            canvas.setFillColor(color(0xf8f7f3))
            canvas.fill(CGRect(x: 0, y: 0, width: 390, height: 844))
            canvas.setFillColor(color(0xe9e5dc))
            canvas.fill(CGRect(x: 0, y: 0, width: 390, height: 104))
            canvas.setFillColor(color(0x3a3632))
            canvas.fill(CGRect(x: 24, y: 64, width: 150, height: 14))
            for (index, width) in [300.0, 330, 280, 318, 210, 0, 296, 326, 250, 312, 180].enumerated() where width > 0 {
                canvas.fill(CGRect(x: 24, y: 140 + Double(index) * 34, width: width, height: 9))
            }
            canvas.setFillColor(color(0xf1e3a6))
            canvas.fill(CGRect(x: 20, y: 132, width: 338, height: 59))
            canvas.setFillColor(color(0x3a3632))
            canvas.fill(CGRect(x: 24, y: 140, width: 300, height: 9))
            canvas.fill(CGRect(x: 24, y: 174, width: 330, height: 9))
        }
    }

    private func color(_ hex: UInt32) -> CGColor {
        UIColor(red: CGFloat((hex >> 16) & 255) / 255,
                green: CGFloat((hex >> 8) & 255) / 255,
                blue: CGFloat(hex & 255) / 255, alpha: 1).cgColor
    }
}
