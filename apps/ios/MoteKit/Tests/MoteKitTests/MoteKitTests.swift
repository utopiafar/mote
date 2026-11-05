import XCTest
import MoteCentral
import MoteCore
import MoteDesign
import MoteStorage

final class MoteKitTests: XCTestCase {
    func testModuleNames() {
        XCTAssertEqual(MoteDesign.moduleName, "MoteDesign")
        XCTAssertEqual(MoteCore.moduleName, "MoteCore")
        XCTAssertEqual(MoteCentral.moduleName, "MoteCentral")
        XCTAssertEqual(MoteStorage.moduleName, "MoteStorage")
    }

    func testDevelopmentIdentity() {
        XCTAssertEqual(MoteCore.bundleIdentifier, "dev.mote.ios")
        XCTAssertEqual(MoteCore.appGroupIdentifier, "group.dev.mote")
    }
}
