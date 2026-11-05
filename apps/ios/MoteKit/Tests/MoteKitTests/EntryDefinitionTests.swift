import XCTest
import MoteCore

final class EntryDefinitionTests: XCTestCase {
    func testEverySystemEntryUsesOnlyEditorAskOrPause() {
        XCTAssertEqual(MoteEntry.allCases.map(\.id), ["record", "photo", "recording", "ask", "pauseSending"])
        XCTAssertEqual(MoteEntry.allCases.map(\.action), [
            .openEditor(.note),
            .openEditor(.photo),
            .openEditor(.recording),
            .openAsk,
            .pause,
        ])
    }

    func testEveryEntryRoundTripsThroughItsCanonicalDeepLink() throws {
        for entry in MoteEntry.allCases {
            let url = try XCTUnwrap(entry.deepLinkURL, entry.id)
            XCTAssertEqual(MoteEntry(url: url), entry)
            XCTAssertEqual(MoteEntry.resolve(url), entry)
        }
        XCTAssertNil(MoteEntry(url: URL(string: "mote://entry/unknown")!))
        XCTAssertNil(MoteEntry(url: URL(string: "https://mote.example/entry/record")!))
        XCTAssertNil(MoteEntry(url: URL(string: "mote://entry/record?source=shortcut")!))
        XCTAssertNil(MoteEntry(url: URL(string: "mote://entry/record#top")!))
    }

    func testShortcutNamesAndSiriPhrasesMatchThePublishedContract() {
        XCTAssertEqual(MoteEntry.allCases.map(\.title), ["记录", "拍照", "录音", "问一问", "暂停发送"])
        XCTAssertEqual(MoteCaptureShortcut.allCases.map(\.title), ["保存截图", "保存通知"])
        XCTAssertEqual(MoteEntry.record.siriPhrases, ["用 Mote 记一下"])
        XCTAssertEqual(MoteEntry.recording.siriPhrases, ["用 Mote 录音"])
        XCTAssertEqual(MoteEntry.ask.siriPhrases, ["问 Mote"])
        XCTAssertTrue(MoteEntry.allCases.filter { !$0.siriPhrases.isEmpty }.map(\.id)
            .elementsEqual(["record", "recording", "ask"]))
    }
}
