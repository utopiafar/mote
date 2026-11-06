import Foundation
import XCTest
import MoteCore

final class SystemControlMappingTests: XCTestCase {
    func testEachSystemControlResolvesToTheIntendedEntryAction() throws {
        let expected: [(MoteSystemControl, MoteEntry, MoteEntryAction)] = [
            (.record, .record, .openEditor(.note)),
            (.photo, .photo, .openEditor(.photo)),
            (.recording, .recording, .openEditor(.recording)),
            (.ask, .ask, .openAsk),
            (.pauseSending, .pauseSending, .pause),
        ]

        XCTAssertEqual(MoteSystemControl.allCases.count, expected.count)
        XCTAssertEqual(Set(MoteSystemControl.allCases.map(\.kind)).count, expected.count)
        for (control, entry, action) in expected {
            XCTAssertEqual(control.entry, entry)
            XCTAssertEqual(control.entry.action, action)
            let url = try XCTUnwrap(control.entry.deepLinkURL)
            XCTAssertEqual(MoteEntry.resolve(url), entry)
        }
    }

    func testPauseControlUsesTheExistingSharedPauseState() {
        let suite = "dev.mote.tests.controls.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }

        XCTAssertFalse(MoteSendPause.isPaused(defaults: defaults))
        XCTAssertEqual(MoteSystemControl.pauseSending.entry.action, .pause)
        MoteSendPause.pause(defaults: defaults)
        XCTAssertTrue(MoteSendPause.isPaused(defaults: defaults))
    }
}
