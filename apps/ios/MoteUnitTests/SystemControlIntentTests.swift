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

    @MainActor
    func testControlEntriesRouteToTheirHomeDestinations() async throws {
        let cases: [(MoteSystemControl, HomeDestination)] = [
            (.record, .editor(.record)),
            (.photo, .editor(.camera)),
            (.recording, .editor(.microphone)),
            (.ask, .ask(nil)),
        ]

        for (control, destination) in cases {
            let intent = OpenSystemControlIntent(control: control)
            let url = try XCTUnwrap(intent.target.entry?.deepLinkURL)
            let entry = try XCTUnwrap(MoteEntry.resolve(url))
            let router = HomeRouter()
            router.open(entry)
            XCTAssertEqual(router.destination, destination, "Wrong destination for \(control.rawValue)")
        }
    }
}
