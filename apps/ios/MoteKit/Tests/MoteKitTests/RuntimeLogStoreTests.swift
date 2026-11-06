import Foundation
import MoteStorage
import XCTest

final class RuntimeLogStoreTests: XCTestCase {
    func testSettingsAffectNewEventsAndSurviveReopening() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = RuntimeLogStore(directoryURL: directory, development: false)
        XCTAssertEqual(try store.readPolicy(), RuntimeLogPolicy(enabled: true, level: .info))
        try store.record(.requestStarted)
        try store.record(.requestCompleted)
        try store.savePolicy(RuntimeLogPolicy(enabled: true, level: .debug))
        try store.record(.requestStarted)
        try store.savePolicy(RuntimeLogPolicy(enabled: false, level: .debug))
        try store.record(.requestFailed)
        let reopened = RuntimeLogStore(directoryURL: directory, development: false)
        XCTAssertEqual(try reopened.readPolicy(), RuntimeLogPolicy(enabled: false, level: .debug))
        let lines = try reopened.readLogs().split(separator: "\n")
        XCTAssertEqual(lines.count, 2)
        XCTAssertTrue(lines[0].contains("request.completed"))
        XCTAssertTrue(lines[1].contains("request.started"))
        XCTAssertEqual(try RuntimeLogStore(directoryURL: directory.appendingPathComponent("dev"), development: true).readPolicy().level, .debug)
    }

    func testRotationKeepsBoundedHistory() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = RuntimeLogStore(directoryURL: directory, development: true, maxBytes: 120)
        for _ in 0..<30 { try store.record(.requestCompleted) }
        let files = try FileManager.default.contentsOfDirectory(atPath: directory.path).filter { $0.hasSuffix(".log") }
        XCTAssertEqual(files.count, 3)
        XCTAssertLessThanOrEqual(try store.readLogs().utf8.count, 360)
    }

    func testOversizedLogIsRejectedWithoutRewritingIt() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let file = directory.appendingPathComponent("mote.0.log")
        let generated = Data(repeating: 7, count: 4096)
        try generated.write(to: file)
        XCTAssertThrowsError(try RuntimeLogStore(directoryURL: directory, maxBytes: 120).readLogs())
        XCTAssertEqual(try Data(contentsOf: file), generated)
    }
}
