import XCTest
import MoteCore

final class HomePresentationTests: XCTestCase {
    private var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 8 * 60 * 60)!
        return calendar
    }

    private func date(_ value: String) -> Date {
        ISO8601DateFormatter().date(from: value)!
    }

    private func facts(
        connection: CaptureConnection = .connected,
        permission: CapturePermission? = nil,
        sync: CaptureSyncState = .idle
    ) -> CaptureStatusFacts {
        CaptureStatusFacts(connection: connection, captureEnabled: true, captureLive: true, permission: permission, syncState: sync)
    }

    func testUnconnectedOwnerSeesConnectWhileDraftStateRemainsIndependent() {
        let home = HomePresentation(facts: facts(connection: .unconfigured, sync: .unconfigured), hasDraft: true, highlights: [], originals: [])

        XCTAssertEqual(home.notice?.title, "连接你的 Mote")
        XCTAssertEqual(home.notice?.actionTitle, "连接")
        XCTAssertEqual(home.notice?.operation, .connect)
        XCTAssertTrue(home.hasDraft)
    }

    func testNormalStateHasNoNoticeAndExistingMappingChoosesOneActionableStatus() {
        let normal = HomePresentation(facts: facts(), hasDraft: false, highlights: [], originals: [])
        XCTAssertNil(normal.notice)

        let interrupted = HomePresentation(facts: facts(connection: .reconnect, permission: .missing, sync: .paused), hasDraft: false, highlights: [], originals: [])
        XCTAssertEqual(interrupted.notice?.title, "需要重新连接")
        XCTAssertEqual(interrupted.notice?.operation, .capture(.reconnect))
        XCTAssertEqual(interrupted.notice?.level, .needsAction)
    }

    func testPausedSendAndPermissionUseSharedActionAndSeverity() {
        let paused = HomePresentation(facts: facts(sync: .paused), hasDraft: false, highlights: [], originals: [])
        XCTAssertEqual(paused.notice?.title, "发送已暂停")
        XCTAssertEqual(paused.notice?.actionTitle, "恢复")
        XCTAssertEqual(paused.notice?.operation, .capture(.resumeSend))
        XCTAssertEqual(paused.notice?.level, .reminder)

        let permission = HomePresentation(facts: facts(permission: .missing), hasDraft: false, highlights: [], originals: [])
        XCTAssertEqual(permission.notice?.title, "等待采集权限")
        XCTAssertEqual(permission.notice?.actionTitle, "处理")
        XCTAssertEqual(permission.notice?.operation, .capture(.openPermissions))
        XCTAssertEqual(permission.notice?.level, .needsAction)
    }

    func testUnconnectedOwnerStillSeesHigherPriorityCaptureProblem() {
        let home = HomePresentation(
            facts: facts(connection: .unconfigured, permission: .missing, sync: .unconfigured),
            hasDraft: false,
            highlights: [],
            originals: []
        )

        XCTAssertEqual(home.notice?.title, "等待采集权限")
        XCTAssertEqual(home.notice?.operation, .capture(.openPermissions))
        XCTAssertEqual(home.notice?.level, .needsAction)
    }

    func testFirstUseConnectNoticeRemainsWhenCaptureHasNotBeenEnabled() {
        let home = HomePresentation(
            facts: CaptureStatusFacts(connection: .unconfigured, captureEnabled: false, captureLive: false, syncState: .unconfigured),
            hasDraft: false,
            highlights: [],
            originals: []
        )

        XCTAssertEqual(home.notice?.title, "连接你的 Mote")
        XCTAssertEqual(home.notice?.operation, .connect)
    }

    func testOriginalsAreOrderedAndGroupedByOwnersLocalDay() {
        let originals = [
            HomeOriginal(id: "older", capturedAt: date("2026-11-05T15:59:00Z"), title: "生成的旧记录", detail: "23:59 · 记录"),
            HomeOriginal(id: "newer", capturedAt: date("2026-11-05T16:01:00Z"), title: "生成的新记录", detail: "00:01 · 记录"),
            HomeOriginal(id: "equal", capturedAt: date("2026-11-05T16:01:00Z"), title: "生成的同一时间记录", detail: "00:01 · 记录"),
        ]
        let highlights = [HomeHighlight(id: "schedule", kind: .schedule, title: "生成的日程", detail: "待补充")]
        let home = HomePresentation(facts: facts(), hasDraft: false, highlights: highlights, originals: originals, calendar: calendar)

        XCTAssertEqual(home.highlights, highlights)
        XCTAssertEqual(home.days.count, 2)
        XCTAssertEqual(home.days.map { $0.originals.map(\.id) }, [["newer", "equal"], ["older"]])
        XCTAssertEqual(home.days[0].date, date("2026-11-05T16:00:00Z"))

        let empty = HomePresentation(facts: facts(), hasDraft: false, highlights: [], originals: [], calendar: calendar)
        XCTAssertTrue(empty.highlights.isEmpty)
        XCTAssertTrue(empty.days.isEmpty)
    }
}
