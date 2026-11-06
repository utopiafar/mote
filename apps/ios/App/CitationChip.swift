import MoteDesign
import SwiftUI
import UIKit

/// Draws the numbered citation chip that sits inside running answer text.
/// `Text` can only tint a run's background, so the chip is rendered as an
/// 18pt pill image whose geometry matches the canvas (18pt tall, 11pt
/// semibold number, tint fill, accent ink).
@MainActor
enum CitationChip {
    private static var cache: [String: UIImage] = [:]

    static func image(number: Int, colorScheme: ColorScheme) -> UIImage {
        let key = "\(colorScheme == .dark ? "dark" : "light").\(number)"
        if let cached = cache[key] { return cached }
        let image = render(number: number, dark: colorScheme == .dark)
        cache[key] = image
        return image
    }

    private static func render(number: Int, dark: Bool) -> UIImage {
        let height: CGFloat = 18
        let font = UIFont.systemFont(ofSize: 11, weight: .semibold)
        let label = "\(number)" as NSString
        let attributes: [NSAttributedString.Key: Any] = [
            .font: font,
            .foregroundColor: color(MoteDesignTokens.accent, dark: dark),
        ]
        let textSize = label.size(withAttributes: attributes)
        let chipWidth = max(height, ceil(textSize.width) + 8)
        // The canvas keeps a 2pt margin on each side of the chip; bake it into
        // the image so no breakable space characters sit around the run.
        let margin: CGFloat = 2
        let size = CGSize(width: chipWidth + margin * 2, height: height)
        let format = UIGraphicsImageRendererFormat.default()
        format.opaque = false
        format.scale = UIScreen.main.scale
        return UIGraphicsImageRenderer(size: size, format: format).image { _ in
            color(MoteDesignTokens.tint, dark: dark).setFill()
            UIBezierPath(roundedRect: CGRect(x: margin, y: 0, width: chipWidth, height: height),
                         cornerRadius: height / 2).fill()
            label.draw(at: CGPoint(x: margin + (chipWidth - textSize.width) / 2,
                                  y: (height - textSize.height) / 2),
                       withAttributes: attributes)
        }
    }

    private static func color(_ token: MoteColorToken, dark: Bool) -> UIColor {
        UIColor(MoteColorToken.color(hex: dark ? token.dark : token.light))
    }
}

/// Draws the streaming caret at the canvas size: an 8x16 ink block at 60%
/// opacity with a 2pt left margin, sitting 2pt below the text baseline.
@MainActor
enum AnswerCaret {
    private static var cache: [Bool: UIImage] = [:]

    static func image(colorScheme: ColorScheme) -> UIImage {
        let dark = colorScheme == .dark
        if let cached = cache[dark] { return cached }
        let format = UIGraphicsImageRendererFormat.default()
        format.opaque = false
        format.scale = UIScreen.main.scale
        let image = UIGraphicsImageRenderer(size: CGSize(width: 10, height: 16), format: format).image { _ in
            let color = UIColor(MoteColorToken.color(hex: dark ? MoteDesignTokens.ink.dark : MoteDesignTokens.ink.light))
                .withAlphaComponent(0.6)
            color.setFill()
            UIRectFill(CGRect(x: 2, y: 0, width: 8, height: 16))
        }
        cache[dark] = image
        return image
    }
}
