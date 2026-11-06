import XCTest
import MoteCore
@testable import Mote

final class SystemControlIntentTests: XCTestCase {
    func testControlIntentOpensTheMatchingUnifiedEntry() throws {
        let controls: [(MoteSystemControl, MoteEntry, MoteEntryAction)] = [
            (.record, .record, .openEditor(.note)),
            (.photo, .photo, .openEditor(.photo)),
            (.recording, .recording, .openEditor(.recording)),
            (.ask, .ask, .openAsk),
        ]

        for (control, expectedEntry, expectedAction) in controls {
            let intent = OpenSystemControlIntent(control: control)
            let entry = try XCTUnwrap(intent.target.entry)
            XCTAssertEqual(entry, expectedEntry)
            XCTAssertEqual(entry.action, expectedAction)
            XCTAssertEqual(MoteEntry.resolve(try XCTUnwrap(entry.deepLinkURL)), expectedEntry)
        }
    }
}
