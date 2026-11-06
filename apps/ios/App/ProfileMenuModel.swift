import Foundation
import MoteCore
import MoteStorage
import Observation

/// Reads the facts the "我的 Mote" menu can show today: the saved connection
/// and the durable send queue. Capture source problems arrive with the units
/// that own those sources; until then only send pause is visible.
@MainActor
@Observable
final class ProfileMenuModel {
    private(set) var captureStatus: MoteMenuStatus?

    private let fileManager: FileManager
    private let previewStatus: MoteMenuStatus?
    private let usesPreview: Bool

    init(fileManager: FileManager = .default) {
        self.fileManager = fileManager
        previewStatus = nil
        usesPreview = false
        refresh()
    }

    init(previewStatus: MoteMenuStatus?) {
        fileManager = .default
        self.previewStatus = previewStatus
        usesPreview = true
        captureStatus = previewStatus
    }

    func refresh() {
        guard !usesPreview else {
            captureStatus = previewStatus
            return
        }
        let connection = (try? MoteStorage.connectionStore(fileManager: fileManager).read()) ?? nil
        let pending = (try? MoteStorage.sendQueue(fileManager: fileManager).pending().count) ?? 0
        let paused = MoteSendPause.isPaused()
        // iOS has no global capture switch: sources capture on their own. The
        // facts still go through the shared status mapping so the row and the
        // home notice always agree.
        let facts = CaptureStatusFacts(
            connection: connection == nil ? .unconfigured : .connected,
            captureEnabled: true,
            captureLive: true,
            syncState: paused ? .paused : (pending > 0 ? .waiting : .idle),
            pending: pending
        )
        captureStatus = MoteMenuPresentation(facts: facts).captureStatus
    }
}
