import SwiftUI

/// Generated search states for visual acceptance and UI tests. They never
/// read a profile or the network.
struct SearchRecordsPreview: View {
    private let state: String
    @State private var opened = "none"

    init() {
        let arguments = ProcessInfo.processInfo.arguments
        state = arguments.firstIndex(of: "-MoteSearchState").flatMap {
            arguments.indices.contains($0 + 1) ? arguments[$0 + 1] : nil
        } ?? "results"
    }

    var body: some View {
        SearchRecordsView(
            model: Self.model(for: state),
            onClose: {},
            onOpenOriginal: { opened = $0 },
            onConnect: {}
        )
        .overlay(alignment: .topLeading) {
            Text(opened)
                .font(.system(size: 1))
                .opacity(0.01)
                .frame(width: 1, height: 1)
                .accessibilityIdentifier("search-preview-opened")
        }
    }

    private static func model(for state: String) -> SearchRecordsModel {
        switch state {
        case "empty":
            return SearchRecordsModel(
                query: "会议室",
                hasSearched: true,
                loader: loader()
            )
        case "unavailable":
            return SearchRecordsModel(connected: false, loader: loader())
        default:
            return SearchRecordsModel(
                rows: rows.filter { matches($0, query: "押金") },
                query: "押金",
                hasSearched: true,
                loader: loader()
            )
        }
    }

    private static func loader() -> SearchRecordsModel.Loader {
        { query, _ in
            SearchRecordsModel.Page(
                rows: rows.filter { matches($0, query: query) },
                nextCursor: nil
            )
        }
    }

    private static func matches(_ row: SearchRecordsModel.Row, query: String) -> Bool {
        let term = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !term.isEmpty else { return false }
        return row.title.localizedCaseInsensitiveContains(term)
            || row.snippet.localizedCaseInsensitiveContains(term)
    }

    private static let rows: [SearchRecordsModel.Row] = [
        SearchRecordsModel.Row(
            id: "capture.generated-deposit",
            title: "租房押金",
            snippet: "押金为两个月租金，下个月退，需要收据",
            timeLabel: "16:10",
            sourceLabel: "记录"
        ),
        SearchRecordsModel.Row(
            id: "capture.generated-parking",
            title: "车位租赁",
            snippet: "月租 300 元，押金一个月，年底续签",
            timeLabel: "15:32",
            sourceLabel: "记录"
        ),
        SearchRecordsModel.Row(
            id: "capture.generated-heating",
            title: "暖气费按实际用量分摊，月底前给账单照片",
            snippet: "周四和房东确认：暖气费按实际用量分摊，月底前把账单照片发给他。",
            timeLabel: "14:20",
            sourceLabel: "记录"
        ),
        SearchRecordsModel.Row(
            id: "capture.generated-parcel",
            title: "顺丰：包裹已放入驿站",
            snippet: "取件码 8-2-1038，今晚八点前取。",
            timeLabel: "21:38",
            sourceLabel: "通知"
        ),
    ]
}
