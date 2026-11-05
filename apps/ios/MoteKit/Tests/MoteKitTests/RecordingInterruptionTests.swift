import XCTest
@testable import MoteCore

final class RecordingInterruptionTests: XCTestCase {
    func testInterruptionRequiresExplicitResumeAndStopDoesNotRestart() {
        var state = RecordingState()
        state.start()
        state.pause(interrupted: true)
        XCTAssertEqual(state.phase, .paused)
        XCTAssertTrue(state.interrupted)

        state.interruptionEnded()
        XCTAssertEqual(state.phase, .paused)
        state.resume()
        XCTAssertEqual(state.phase, .recording)
        XCTAssertFalse(state.interrupted)
        state.stop()
        state.resume()
        XCTAssertEqual(state.phase, .idle)
    }

    func testInterruptionDoesNotTurnManualPauseIntoAutomaticResume() {
        var state = RecordingState()
        state.start()
        state.pause()
        state.pause(interrupted: true)
        XCTAssertEqual(state.phase, .paused)
        XCTAssertFalse(state.interrupted)
        state.resume()
        XCTAssertEqual(state.phase, .recording)
    }
}
