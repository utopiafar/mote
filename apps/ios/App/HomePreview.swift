import MoteCore
import SwiftUI
import UIKit

/// Generated, in-memory examples for visual and accessibility checks.
struct HomePreview: View {
    @State private var lastAction = "none"
    private let arguments = ProcessInfo.processInfo.arguments

    var body: some View {
        HomeView(presentation: presentation) { action in
            lastAction = actionName(action)
        }
        .statusBarHidden()
        .overlay(alignment: .topLeading) {
            Text(lastAction)
                .font(.system(size: 1))
                .opacity(0.01)
                .frame(width: 1, height: 1)
                .accessibilityIdentifier("home-preview-action")
        }
    }

    private var state: String {
        guard let index = arguments.firstIndex(of: "-MoteHomeState"), arguments.indices.contains(index + 1) else {
            return "normal"
        }
        return arguments[index + 1]
    }

    private var presentation: HomePresentation {
        let connection: CaptureConnection = state == "firstUse" ? .unconfigured : state == "reconnect" ? .reconnect : .connected
        let sync: CaptureSyncState = state == "sendPaused" ? .paused : state == "firstUse" ? .unconfigured : .idle
        let facts = CaptureStatusFacts(
            connection: connection,
            captureEnabled: true,
            captureLive: true,
            permission: state == "permission" ? .missing : nil,
            syncState: sync
        )
        let calendar = Calendar.current
        let today = calendar.startOfDay(for: Date())
        let yesterday = calendar.date(byAdding: .day, value: -1, to: today)!
        func at(_ day: Date, _ hour: Int, _ minute: Int) -> Date {
            calendar.date(bySettingHour: hour, minute: minute, second: 0, of: day)!
        }
        let originals = [
            HomeOriginal(id: "generated-board", capturedAt: at(today, 18, 2), title: "白板：第三季度路线图", detail: "18:02 · 照片", thumbnail: thumbnail(board: true)),
            HomeOriginal(id: "generated-call", capturedAt: at(today, 16, 40), title: "和陈老师的电话", detail: "16:40 · 录音 12:40"),
            HomeOriginal(id: "generated-note", capturedAt: at(today, 14, 20), title: "暖气费按实际用量分摊，月底前给账单照片", detail: "14:20 · 记录"),
            HomeOriginal(id: "generated-link", capturedAt: at(today, 11, 5), title: "低温慢烤牛肋排的时间表", detail: "11:05 · seriouseats.com"),
            HomeOriginal(id: "generated-notification", capturedAt: at(yesterday, 21, 38), title: "顺丰：包裹已放入驿站", detail: "21:38 · 通知"),
            HomeOriginal(id: "generated-receipt", capturedAt: at(yesterday, 19, 12), title: "书店收据", detail: "19:12 · 照片", thumbnail: thumbnail(board: false)),
            HomeOriginal(id: "generated-file", capturedAt: at(yesterday, 9, 30), title: "租房合同 2026.pdf", detail: "09:30 · 文件"),
        ]
        let highlights: [HomeHighlight] = state == "highlights" ? [
            HomeHighlight(id: "generated-schedule", kind: .schedule, title: "生成的日程", detail: "待补充"),
            HomeHighlight(id: "generated-discovery", kind: .discovery, title: "生成的发现", detail: "查看发现"),
        ] : []
        return HomePresentation(facts: facts, hasDraft: state == "draft", highlights: highlights, originals: originals, calendar: calendar)
    }

    private func thumbnail(board: Bool) -> Data? {
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: 44, height: 44))
        return renderer.pngData { context in
            func color(_ hex: UInt32) -> CGColor {
                UIColor(red: CGFloat((hex >> 16) & 255) / 255,
                        green: CGFloat((hex >> 8) & 255) / 255,
                        blue: CGFloat(hex & 255) / 255, alpha: 1).cgColor
            }
            let canvas = context.cgContext
            canvas.setFillColor(color(board ? 0xeceae4 : 0xd9d2c4))
            canvas.fill(CGRect(x: 0, y: 0, width: 44, height: 44))
            canvas.setLineCap(.round)
            if board {
                canvas.setStrokeColor(color(0x2f5d9e))
                canvas.setLineWidth(2)
                for (y, end) in [(12.0, 24.0), (18.0, 31.0), (24.0, 19.0)] {
                    canvas.move(to: CGPoint(x: 7, y: y))
                    canvas.addLine(to: CGPoint(x: end, y: y))
                }
                canvas.strokePath()
                canvas.setStrokeColor(color(0xb5432f))
                canvas.move(to: CGPoint(x: 26, y: 27))
                canvas.addLine(to: CGPoint(x: 31, y: 32))
                canvas.addLine(to: CGPoint(x: 38, y: 23))
                canvas.strokePath()
                canvas.setStrokeColor(color(0x3a3632))
                canvas.move(to: CGPoint(x: 7, y: 33))
                canvas.addLine(to: CGPoint(x: 21, y: 33))
                canvas.strokePath()
            } else {
                canvas.setFillColor(color(0xfbfaf6))
                canvas.fill(CGRect(x: 12, y: 5, width: 20, height: 36))
                canvas.setStrokeColor(color(0x8b847a))
                canvas.setLineWidth(1.6)
                for (y, end) in [(11.0, 28.0), (16.0, 25.0), (21.0, 28.0), (26.0, 23.0), (33.0, 28.0)] {
                    canvas.move(to: CGPoint(x: 16, y: y))
                    canvas.addLine(to: CGPoint(x: end, y: y))
                }
                canvas.strokePath()
            }
        }
    }

    private func actionName(_ action: HomeAction) -> String {
        switch action {
        case .profile: "profile"
        case .search: "search"
        case .notice(.connect): "notice.connect"
        case .notice(.capture(let operation)): "notice.\(operation.rawValue)"
        case .highlight(let kind, let id): "highlight.\(kind.rawValue).\(id)"
        case .original(let id): "original.\(id)"
        case .ask: "ask"
        case .record: "record"
        case .camera: "camera"
        case .microphone: "microphone"
        }
    }
}
