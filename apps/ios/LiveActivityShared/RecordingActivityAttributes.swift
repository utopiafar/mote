import ActivityKit
import Foundation

struct RecordingActivityAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        let timerStart: Date
        let elapsed: TimeInterval
        let isPaused: Bool
    }

    let recordingID: String
}
