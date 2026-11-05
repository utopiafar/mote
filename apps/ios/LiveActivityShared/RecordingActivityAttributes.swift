import ActivityKit
import Foundation

struct RecordingActivityAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        let elapsed: TimeInterval
        let isPaused: Bool
    }

    let recordingID: String
}
