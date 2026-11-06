import Foundation
import MoteCore
import SwiftUI

/// Generated states for the library and memory screens. They mirror the
/// canvas rows and never read a profile or the network.
struct LibraryMemoriesPreview: View {
    private let state: String

    init() {
        let arguments = ProcessInfo.processInfo.arguments
        state = arguments.firstIndex(of: "-MoteLibraryState").flatMap {
            arguments.indices.contains($0 + 1) ? arguments[$0 + 1] : nil
        } ?? "library"
    }

    var body: some View {
        LibraryMemoriesView(model: Self.model(for: state), onBack: {}, previewFocused: state == "memories-search")
    }

    private static func model(for state: String) -> LibraryMemoriesModel {
        let library = libraryRows()
        let memories = memoryRows()
        switch state {
        case "library-filter":
            return LibraryMemoriesModel(
                previewLibrary: library,
                previewMemories: memories,
                filterPresented: true
            )
        case "memories":
            return LibraryMemoriesModel(
                previewLibrary: library,
                previewMemories: memories,
                previewHistorical: historicalRows(),
                tab: .memories
            )
        case "memories-search":
            return LibraryMemoriesModel(
                previewLibrary: library,
                previewMemories: memories,
                previewHistorical: historicalRows(),
                tab: .memories,
                memoryQuery: "押金"
            )
        case "memories-filter":
            return LibraryMemoriesModel(
                previewLibrary: library,
                previewMemories: memories,
                previewHistorical: historicalRows(),
                tab: .memories,
                filterPresented: true
            )
        default:
            return LibraryMemoriesModel(previewLibrary: library, previewMemories: memories)
        }
    }

    private static func libraryRows() -> [LibraryBrowseRow] {
        let calendar = Calendar.current
        let today = Date()
        let yesterday = calendar.date(byAdding: .day, value: -1, to: today) ?? today
        func at(_ day: Date, _ hour: Int, _ minute: Int) -> Date {
            calendar.date(bySettingHour: hour, minute: minute, second: 0, of: day) ?? day
        }
        return [
            LibraryBrowseRow(
                id: "capture.generated-board",
                title: "白板：第三季度路线图",
                timeLabel: "18:02",
                sourceLabel: "照片",
                date: at(today, 18, 2),
                source: "media",
                kind: "",
                isMaterial: false,
                isImage: true,
                captureID: "00000000-0000-4000-8000-000000000001"
            ),
            LibraryBrowseRow(
                id: "capture.generated-call",
                title: "和陈老师的电话",
                timeLabel: "16:40",
                sourceLabel: "录音 12:40",
                date: at(today, 16, 40),
                source: "media",
                kind: "",
                isMaterial: false,
                isImage: false,
                captureID: "00000000-0000-4000-8000-000000000002"
            ),
            LibraryBrowseRow(
                id: "capture.generated-heating",
                title: "暖气费按实际用量分摊，月底前给账单照片",
                timeLabel: "14:20",
                sourceLabel: "记录",
                date: at(today, 14, 20),
                source: "note",
                kind: "",
                isMaterial: false,
                isImage: false,
                captureID: "00000000-0000-4000-8000-000000000003"
            ),
            LibraryBrowseRow(
                id: "capture.generated-recipe",
                title: "低温慢烤牛肋排的时间表",
                timeLabel: "11:05",
                sourceLabel: "seriouseats.com",
                date: at(today, 11, 5),
                source: "ui_page",
                kind: "",
                isMaterial: false,
                isImage: false,
                captureID: "00000000-0000-4000-8000-000000000004"
            ),
            LibraryBrowseRow(
                id: "capture.generated-parcel",
                title: "顺丰：包裹已放入驿站",
                timeLabel: "21:38",
                sourceLabel: "通知",
                date: at(yesterday, 21, 38),
                source: "notification",
                kind: "",
                isMaterial: false,
                isImage: false,
                captureID: "00000000-0000-4000-8000-000000000005"
            ),
            LibraryBrowseRow(
                id: "material.generated-lease",
                title: "租房合同 2026.pdf",
                timeLabel: "09:30",
                sourceLabel: "文件",
                date: at(yesterday, 9, 30),
                source: "",
                kind: "mote.file",
                isMaterial: true,
                isImage: false
            ),
        ]
    }

    private static func memoryRows() -> [MemoryBrowseRow] {
        [
            MemoryBrowseRow(id: "memory.generated-deposit", title: "租房押金",
                            statement: "押金为两个月租金，下个月退，需要收据", kind: "semantic"),
            MemoryBrowseRow(id: "memory.generated-heating", title: "暖气费分摊",
                            statement: "按实际用量分摊，月底前给房东账单照片", kind: "episodic"),
            MemoryBrowseRow(id: "memory.generated-ribs", title: "牛肋排做法",
                            statement: "低温烤 6 小时效果最好", kind: "procedural"),
            MemoryBrowseRow(id: "memory.generated-weekly", title: "周报习惯",
                            statement: "每周五写周报，用三条要点开场", kind: "procedural"),
            MemoryBrowseRow(id: "memory.generated-teacher", title: "陈老师",
                            statement: "女儿的钢琴老师，周三下午上课", kind: "semantic"),
            MemoryBrowseRow(id: "memory.generated-bookstore", title: "常去的书店",
                            statement: "学校附近的三联书店", kind: "semantic"),
            MemoryBrowseRow(id: "memory.generated-checkup", title: "体检提醒",
                            statement: "少熬夜，三个月后复查血脂", kind: "episodic"),
            MemoryBrowseRow(id: "memory.generated-parking", title: "车位租赁",
                            statement: "月租 300 元，押金一个月，年底续签", kind: "episodic"),
        ]
    }

    private static func historicalRows() -> [MemoryBrowseRow] {
        [
            MemoryBrowseRow(id: "memory.generated-old-parking", title: "旧车位租赁",
                            statement: "去年月租 260 元，合同已到期", kind: "semantic"),
        ]
    }
}
