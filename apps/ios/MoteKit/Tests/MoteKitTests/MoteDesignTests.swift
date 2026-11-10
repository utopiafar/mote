import SwiftUI
import XCTest
@testable import MoteDesign

final class MoteDesignTests: XCTestCase {
    func testFinalPaletteValues() {
        XCTAssertEqual(MoteDesignTokens.background.light, "#f7f5f1")
        XCTAssertEqual(MoteDesignTokens.background.dark, "#1c1b1a")
        XCTAssertEqual(MoteDesignTokens.surface.light, "#fffdfa")
        XCTAssertEqual(MoteDesignTokens.surface.dark, "#232220")
        XCTAssertEqual(MoteDesignTokens.ink.light, "#2d2a26")
        XCTAssertEqual(MoteDesignTokens.ink.dark, "#edebe8")
        XCTAssertEqual(MoteDesignTokens.hair.light, "#e8e3db")
        XCTAssertEqual(MoteDesignTokens.hair.dark, "#302e2b")
        XCTAssertEqual(MoteDesignTokens.fill.light, "#2d2a2612")
        XCTAssertEqual(MoteDesignTokens.fill.dark, "#edebe814")
        XCTAssertEqual(MoteDesignTokens.controlBorder.light, "#928a81")
        XCTAssertEqual(MoteDesignTokens.controlBorder.dark, "#79726a")
    }

    func testPhoneRadiiAndTouchTargets() {
        XCTAssertEqual(MoteDesignTokens.Dimens.radiusThumbMobile, 10)
        XCTAssertEqual(MoteDesignTokens.Dimens.radiusControlMobile, 12)
        XCTAssertEqual(MoteDesignTokens.Dimens.radiusContainerMobile, 16)
        XCTAssertEqual(MoteDesignTokens.Dimens.radiusPanelMobile, 24)
        XCTAssertEqual(MoteDesignTokens.Dimens.radiusPill, 999)
        XCTAssertEqual(MoteMetrics.touchTarget, 44)
        XCTAssertEqual(MoteMetrics.rowMinHeight, 44)
        XCTAssertEqual(MoteMetrics.controlHeight, 44)
        XCTAssertEqual(MoteMetrics.markSize, 28)
    }

    func testMarkArchesOverItsLegsAndRestsOnTheDot() {
        let box = CGRect(x: 0, y: 0, width: 24, height: 24)
        let ink = MoteMarkStroke().path(in: box)
            .strokedPath(StrokeStyle(lineWidth: MoteMarkGeometry.stroke, lineCap: .round, lineJoin: .round))
        // Both arches pass over the top of their legs; a bowl underneath would be a different letter.
        XCTAssertTrue(ink.contains(CGPoint(x: 8.5, y: 7.5)))
        XCTAssertTrue(ink.contains(CGPoint(x: 15, y: 7.5)))
        XCTAssertFalse(ink.contains(CGPoint(x: 8.5, y: 14)))
        XCTAssertFalse(ink.contains(CGPoint(x: 15, y: 14)))
        // The last leg stops short; the dot below it carries the accent.
        XCTAssertTrue(ink.contains(CGPoint(x: 18.25, y: 12.2)))
        XCTAssertFalse(ink.contains(MoteMarkGeometry.dotCenter))
        XCTAssertTrue(MoteMarkDot().path(in: box).contains(MoteMarkGeometry.dotCenter))
        // Any frame keeps the same proportions, centered.
        let wide = MoteMarkStroke().path(in: CGRect(x: 0, y: 0, width: 96, height: 48)).boundingRect
        XCTAssertEqual(wide.minX, 24 + 5.25 * 2, accuracy: 0.01)
        XCTAssertEqual(wide.minY, 7.5 * 2, accuracy: 0.01)
        XCTAssertEqual(wide.maxX, 24 + 18.25 * 2, accuracy: 0.01)
    }

    func testTextAndControlContrast() {
        for scheme in [("light", MoteDesignTokens.background.light, MoteDesignTokens.ink.light, MoteDesignTokens.controlBorder.light),
                       ("dark", MoteDesignTokens.background.dark, MoteDesignTokens.ink.dark, MoteDesignTokens.controlBorder.dark)] {
            XCTAssertGreaterThanOrEqual(contrast(scheme.2, scheme.1), 4.5, "\(scheme.0) ink/background")
            XCTAssertGreaterThanOrEqual(contrast(scheme.3, scheme.1), 3, "\(scheme.0) control/background")
        }
        XCTAssertGreaterThanOrEqual(contrast(MoteDesignTokens.ink.light, composite(MoteDesignTokens.fill.light, MoteDesignTokens.background.light)), 4.5)
        XCTAssertGreaterThanOrEqual(contrast(MoteDesignTokens.ink.dark, composite(MoteDesignTokens.fill.dark, MoteDesignTokens.surfaceRaised.dark)), 4.5)
        XCTAssertGreaterThanOrEqual(contrast(MoteDesignTokens.controlBorder.dark, MoteDesignTokens.surfaceRaised.dark), 3)
    }

    func testEverySharedLinearIconHasGeometry() {
        XCTAssertEqual(MoteIconName.allCases.count, 53)
        for name in MoteIconName.allCases {
            let elements = MoteIconCatalog.elements[name]
            XCTAssertNotNil(elements, "\(name.rawValue) is missing geometry")
            XCTAssertFalse(elements?.isEmpty ?? true, "\(name.rawValue) has no geometry")
        }
        XCTAssertEqual(Set(MoteIconName.allCases).count, MoteIconName.allCases.count)
    }

    private func channels(_ hex: String) -> [Double] {
        let value = hex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
        let parts = stride(from: 0, to: 6, by: 2).map { start in
            let lower = value.index(value.startIndex, offsetBy: start)
            let upper = value.index(lower, offsetBy: 2)
            return String(value[lower..<upper])
        }
        return parts.map { Double(Int($0, radix: 16) ?? 0) / 255 }
    }

    private func luminance(_ hex: String) -> Double {
        let values = channels(hex).map { $0 <= 0.04045 ? $0 / 12.92 : pow(($0 + 0.055) / 1.055, 2.4) }
        return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722
    }

    private func contrast(_ foreground: String, _ background: String) -> Double {
        let values = [luminance(foreground), luminance(background)].sorted(by: >)
        return (values[0] + 0.05) / (values[1] + 0.05)
    }

    private func composite(_ foreground: String, _ background: String) -> String {
        let value = foreground.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
        let alpha = value.count == 8 ? Double(Int(value.suffix(2), radix: 16) ?? 255) / 255 : 1
        let front = channels(foreground), back = channels(background)
        let mixed = (0..<3).map { channel in
            Int(((front[channel] * alpha + back[channel] * (1 - alpha)) * 255).rounded())
        }
        return "#" + mixed.map { String(format: "%02x", $0) }.joined()
    }
}
