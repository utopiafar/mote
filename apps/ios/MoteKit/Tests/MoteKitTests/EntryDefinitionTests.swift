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

    func testOpenEntriesHaveOneCanonicalDeepLink() throws {
        for entry in MoteEntry.allCases where entry != .pauseSending {
            let url = try XCTUnwrap(entry.deepLinkURL, entry.id)
            XCTAssertEqual(MoteEntry.resolve(url), entry)
        }
        XCTAssertNil(MoteEntry.pauseSending.deepLinkURL)
        XCTAssertNil(MoteEntry.resolve(URL(string: "mote://entry/unknown")!))
        XCTAssertNil(MoteEntry.resolve(URL(string: "https://mote.example/entry/record")!))
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
