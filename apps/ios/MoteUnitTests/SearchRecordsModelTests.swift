import XCTest
@testable import Mote

@MainActor
final class SearchRecordsModelTests: XCTestCase {
    func testSearchTrimsTheQueryAndReadsOwnerRows() async {
        let model = SearchRecordsModel(loader: { query, cursor in
            XCTAssertEqual(query, "暖气费")
            XCTAssertNil(cursor)
            return .init(
                rows: [self.row(id: "capture.heating", title: "暖气费按实际用量分摊")],
                nextCursor: nil
            )
        })
        model.query = "  暖气费  "

        await model.searchNow()

        XCTAssertTrue(model.hasSearched)
        XCTAssertTrue(model.connected)
        XCTAssertFalse(model.loading)
        XCTAssertNil(model.errorMessage)
        XCTAssertEqual(model.rows.map(\.id), ["capture.heating"])
        XCTAssertFalse(model.showsEmptyResult)
    }

    func testEmptyResultIsAnEmptySearchNotAnError() async {
        var calls = 0
        let model = SearchRecordsModel(loader: { _, _ in
            calls += 1
            return .init(rows: [], nextCursor: nil)
        })
        model.query = "会议室"

        await model.searchNow()

        XCTAssertEqual(calls, 1)
        XCTAssertTrue(model.hasSearched)
        XCTAssertTrue(model.rows.isEmpty)
        XCTAssertNil(model.errorMessage)
        XCTAssertTrue(model.showsEmptyResult)
    }

    func testNoConnectionShowsTheConnectionStateInsteadOfAnError() async {
        let model = SearchRecordsModel(
            loader: { _, _ in throw SearchRecordsError.notConnected },
            connectionCheck: { false }
        )
        await model.prepare()
        XCTAssertFalse(model.connected)

        model.query = "押金"
        await model.searchNow()

        XCTAssertFalse(model.connected)
        XCTAssertTrue(model.rows.isEmpty)
        XCTAssertNil(model.errorMessage)
        XCTAssertFalse(model.loading)
        XCTAssertFalse(model.showsEmptyResult)
    }

    func testConnectionCheckMarksTheInitialPageWithoutARequest() async {
        let model = SearchRecordsModel(connectionCheck: { true })
        await model.prepare()
        XCTAssertTrue(model.connected)
    }

    func testFailedSearchKeepsARetryableMessage() async {
        struct GeneratedFailure: Error {}
        let model = SearchRecordsModel(loader: { _, _ in throw GeneratedFailure() })
        model.query = "押金"

        await model.searchNow()

        XCTAssertEqual(model.errorMessage, "搜索暂不可用")
        XCTAssertTrue(model.rows.isEmpty)
        XCTAssertFalse(model.showsEmptyResult)
    }

    func testBlankQueryClearsRowsWithoutCallingTheLoader() async {
        var calls = 0
        let model = SearchRecordsModel(
            rows: [row(id: "capture.old", title: "旧结果")],
            query: "押金",
            hasSearched: true,
            loader: { _, _ in
                calls += 1
                return .init(rows: [], nextCursor: nil)
            }
        )
        model.query = "   "

        await model.searchNow()

        XCTAssertEqual(calls, 0)
        XCTAssertTrue(model.rows.isEmpty)
        XCTAssertFalse(model.hasSearched)
        XCTAssertNil(model.errorMessage)
    }

    func testLoadMoreAppendsTheNextCursorOnlyForTheLastRow() async {
        let model = SearchRecordsModel(loader: { _, cursor in
            if cursor == nil {
                return .init(rows: [self.row(id: "capture.first", title: "第一页")], nextCursor: "next")
            }
            XCTAssertEqual(cursor, "next")
            return .init(
                rows: [
                    self.row(id: "capture.first", title: "第一页"),
                    self.row(id: "capture.second", title: "第二页"),
                ],
                nextCursor: nil
            )
        })
        model.query = "押金"
        await model.searchNow()
        XCTAssertEqual(model.rows.map(\.id), ["capture.first"])

        await model.loadMoreIfNeeded(after: "capture.second")
        XCTAssertEqual(model.rows.map(\.id), ["capture.first"], "Non-final rows must not page")

        await model.loadMoreIfNeeded(after: "capture.first")
        XCTAssertEqual(model.rows.map(\.id), ["capture.first", "capture.second"])
    }

    private func row(id: String, title: String) -> SearchRecordsModel.Row {
        SearchRecordsModel.Row(
            id: id,
            title: title,
            snippet: "生成的结果摘要",
            timeLabel: "14:20",
            sourceLabel: "记录"
        )
    }
}
