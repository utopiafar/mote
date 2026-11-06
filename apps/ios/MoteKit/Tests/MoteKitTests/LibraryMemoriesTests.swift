import Foundation
import XCTest
@testable import MoteCore

final class LibraryMemoriesTests: XCTestCase {
    private var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 8 * 3600)!
        calendar.locale = Locale(identifier: "zh_CN")
        return calendar
    }

    func testLibraryCategoriesMatchTheCanvasFilters() {
        let note = row(id: "note", source: "note")
        let screen = row(id: "screen", source: "screen", isImage: true)
        let photo = row(id: "photo", source: "media", isImage: true)
        let recording = row(id: "recording", source: "media")
        let notification = row(id: "notification", source: "notification")
        let file = row(id: "file", source: "file")
        let page = row(id: "page", source: "ui_page")
        let materialNote = row(id: "material-note", source: "", kind: "mote.note", isMaterial: true)
        let materialFile = row(id: "material-file", source: "", kind: "mote.file", isMaterial: true)

        XCTAssertTrue(LibraryBrowseCategory.all.matches(recording))
        XCTAssertTrue(LibraryBrowseCategory.records.matches(note))
        XCTAssertTrue(LibraryBrowseCategory.records.matches(materialNote))
        XCTAssertTrue(LibraryBrowseCategory.images.matches(screen))
        XCTAssertTrue(LibraryBrowseCategory.images.matches(photo))
        XCTAssertFalse(LibraryBrowseCategory.images.matches(recording))
        XCTAssertTrue(LibraryBrowseCategory.notifications.matches(notification))
        XCTAssertTrue(LibraryBrowseCategory.files.matches(file))
        XCTAssertTrue(LibraryBrowseCategory.files.matches(page))
        XCTAssertTrue(LibraryBrowseCategory.files.matches(materialFile))
        XCTAssertFalse(LibraryBrowseCategory.files.matches(screen))
        XCTAssertFalse(LibraryBrowseCategory.records.matches(notification))
    }

    func testLibraryMetaUsesTheCanvasSourceLabels() {
        XCTAssertEqual(
            LibraryBrowsePresentation.sourceLabel(source: "media", kind: "", isMaterial: false, appName: "", durationMs: 760_000),
            "录音 12:40"
        )
        XCTAssertEqual(
            LibraryBrowsePresentation.sourceLabel(source: "ui_page", kind: "", isMaterial: false, appName: "seriouseats.com", durationMs: 0),
            "seriouseats.com"
        )
        XCTAssertEqual(
            LibraryBrowsePresentation.sourceLabel(source: "file", kind: "", isMaterial: false, appName: "", durationMs: 0),
            "文件"
        )
        XCTAssertEqual(
            LibraryBrowsePresentation.sourceLabel(source: "", kind: "mote.note", isMaterial: true, appName: "", durationMs: 0),
            "记录"
        )
        XCTAssertEqual(LibraryBrowsePresentation.durationLabel(760_000), "12:40")
        XCTAssertEqual(LibraryBrowsePresentation.durationLabel(3_725_000), "1:02:05")
    }

    func testLibraryTitlePrefersTheOwnersWordsForNotesAndTitlesForPages() {
        XCTAssertEqual(
            LibraryBrowsePresentation.title(
                source: "note",
                textPreview: "暖气费按实际用量分摊，月底前给账单照片\n第二行",
                windowTitle: "",
                appName: "Mote"
            ),
            "暖气费按实际用量分摊，月底前给账单照片"
        )
        XCTAssertEqual(
            LibraryBrowsePresentation.title(
                source: "ui_page",
                textPreview: "正文预览",
                windowTitle: "低温慢烤牛肋排的时间表",
                appName: "Safari"
            ),
            "低温慢烤牛肋排的时间表"
        )
        XCTAssertEqual(
            LibraryBrowsePresentation.title(
                source: "media",
                textPreview: "录音",
                windowTitle: "",
                appName: "语音备忘录"
            ),
            "录音"
        )
        XCTAssertEqual(
            LibraryBrowsePresentation.title(
                source: "file",
                textPreview: "正文",
                windowTitle: "",
                appName: "",
                materialTitle: "租房合同 2026.pdf"
            ),
            "租房合同 2026.pdf"
        )
    }

    func testLibraryGroupsDaysNewestFirstAndKeepsOrderInsideADay() {
        let now = date(2026, 11, 6, 20, 0)
        let rows = [
            row(id: "today-late", source: "note", date: date(2026, 11, 6, 18, 2)),
            row(id: "yesterday", source: "notification", date: date(2026, 11, 5, 21, 38)),
            row(id: "today-early", source: "file", date: date(2026, 11, 6, 9, 30)),
            row(id: "older", source: "screen", date: date(2026, 11, 3, 8, 0), isImage: true),
        ]

        let groups = LibraryBrowsePresentation.groups(rows, now: now, calendar: calendar)

        XCTAssertEqual(groups.map(\.label), ["今天", "昨天", "周二"])
        XCTAssertEqual(groups[0].rows.map(\.id), ["today-late", "today-early"])
        XCTAssertEqual(groups[1].rows.map(\.id), ["yesterday"])
        XCTAssertEqual(groups[2].rows.map(\.id), ["older"])
    }

    func testMemorySearchHighlightsEveryTermAndMergesOverlap() {
        let text = "租房押金：押金为两个月租金，下个月退，需要收据"
        let ranges = MemorySearchHighlight.ranges(in: text, query: "押金 租金")
        XCTAssertEqual(ranges.map { String(text[$0]) }, ["押金", "押金", "租金"])

        let overlap = MemorySearchHighlight.ranges(in: "abcdef", query: "abc bcdef")
        XCTAssertEqual(overlap.count, 1)
        XCTAssertEqual(String("abcdef"[overlap[0]]), "abcdef")

        let insensitive = MemorySearchHighlight.ranges(in: "Generated Package", query: "generated")
        XCTAssertEqual(insensitive.map { String("Generated Package"[$0]) }, ["Generated"])
    }

    func testMemorySearchLeavesBlankQueriesAndLiteralOnlyTextAlone() {
        XCTAssertTrue(MemorySearchHighlight.ranges(in: "押金", query: "   ").isEmpty)
        XCTAssertFalse(MemorySearchHighlight.matches("押金", query: "房租"))
        XCTAssertTrue(MemorySearchHighlight.matches("押金", query: "押"))
    }

    func testMemoryCategoriesUseTheAndroidContextTreeNodes() {
        XCTAssertEqual(MemoryBrowseCategory.personal.treeID, "topics")
        XCTAssertEqual(MemoryBrowseCategory.personal.nodeID, "personal")
        XCTAssertEqual(MemoryBrowseCategory.events.treeID, "knowledge")
        XCTAssertEqual(MemoryBrowseCategory.events.nodeID, "episodic")
        XCTAssertNil(MemoryBrowseCategory.all.treeID)

        let catalog = ["topics": Set(["personal", "coding"]), "knowledge": Set(["episodic", "semantic"])]
        XCTAssertEqual(MemoryBrowseCategory.personal.resolved(treeIDs: catalog), .personal)
        XCTAssertEqual(MemoryBrowseCategory.events.resolved(treeIDs: catalog), .events)
        XCTAssertEqual(MemoryBrowseCategory.events.resolved(treeIDs: ["topics": ["personal"]]), .all)
    }

    private func row(
        id: String,
        source: String,
        kind: String = "",
        date: Date? = nil,
        isMaterial: Bool = false,
        isImage: Bool = false
    ) -> LibraryBrowseRow {
        LibraryBrowseRow(
            id: id,
            title: id,
            timeLabel: LibraryBrowsePresentation.timeLabel(date, calendar: calendar),
            sourceLabel: "来源",
            date: date,
            source: source,
            kind: kind,
            isMaterial: isMaterial,
            isImage: isImage
        )
    }

    private func date(_ year: Int, _ month: Int, _ day: Int, _ hour: Int, _ minute: Int) -> Date {
        calendar.date(from: DateComponents(year: year, month: month, day: day, hour: hour, minute: minute))!
    }
}
