import ActivityKit
import AppIntents

struct PauseRecordingActivityIntent: LiveActivityIntent {
    static let title: LocalizedStringResource = "暂停录音"
    static let isDiscoverable = false
    @Parameter(title: "录音") var recordingID: String

    init() {}
    init(recordingID: String) { self.recordingID = recordingID }

    func perform() async throws -> some IntentResult {
        #if !MOTE_ACTIVITY_EXTENSION
        await RecordingLiveActivity.perform(.pause, recordingID: recordingID)
        #endif
        return .result()
    }
}

struct ResumeRecordingActivityIntent: LiveActivityIntent {
    static let title: LocalizedStringResource = "继续录音"
    static let isDiscoverable = false
    @Parameter(title: "录音") var recordingID: String

    init() {}
    init(recordingID: String) { self.recordingID = recordingID }

    func perform() async throws -> some IntentResult {
        #if !MOTE_ACTIVITY_EXTENSION
        await RecordingLiveActivity.perform(.resume, recordingID: recordingID)
        #endif
        return .result()
    }
}

struct StopRecordingActivityIntent: LiveActivityIntent {
    static let title: LocalizedStringResource = "停止录音"
    static let isDiscoverable = false
    @Parameter(title: "录音") var recordingID: String

    init() {}
    init(recordingID: String) { self.recordingID = recordingID }

    func perform() async throws -> some IntentResult {
        #if !MOTE_ACTIVITY_EXTENSION
        await RecordingLiveActivity.perform(.stop, recordingID: recordingID)
        #endif
        return .result()
    }
}
