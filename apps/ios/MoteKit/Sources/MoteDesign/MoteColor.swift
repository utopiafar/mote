import SwiftUI

public extension MoteColorToken {
    /// The token resolved against the current interface style.
    var color: Color {
        MoteDynamicColor.make(light: Self.color(hex: light), dark: Self.color(hex: dark))
    }

    var lightColor: Color { Self.color(hex: light) }
    var darkColor: Color { Self.color(hex: dark) }

    static func color(hex value: String) -> Color {
        let hex = value.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
        guard let rgba = UInt64(hex, radix: 16) else { return .clear }
        let red, green, blue, alpha: Double
        if hex.count == 8 {
            red = Double((rgba >> 24) & 0xff) / 255
            green = Double((rgba >> 16) & 0xff) / 255
            blue = Double((rgba >> 8) & 0xff) / 255
            alpha = Double(rgba & 0xff) / 255
        } else {
            red = Double((rgba >> 16) & 0xff) / 255
            green = Double((rgba >> 8) & 0xff) / 255
            blue = Double(rgba & 0xff) / 255
            alpha = 1
        }
        return Color(.sRGB, red: red, green: green, blue: blue, opacity: alpha)
    }
}

#if canImport(UIKit)
private enum MoteDynamicColor {
    static func make(light: Color, dark: Color) -> Color {
        Color(uiColor: UIColor { traits in
            UIColor(traits.userInterfaceStyle == .dark ? dark : light)
        })
    }
}
#elseif canImport(AppKit)
private enum MoteDynamicColor {
    static func make(light: Color, dark: Color) -> Color {
        Color(nsColor: NSColor(name: nil) { appearance in
            NSColor(appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? dark : light)
        })
    }
}
#endif

public enum MoteFont {
    public static let title = Font.system(size: MoteDesignTokens.Dimens.fontTitleMobile, weight: .semibold)
    public static let section = Font.system(size: 16, weight: .semibold)
    public static let body = Font.system(size: 15)
    public static let reading = Font.system(size: 16)
    public static let secondary = Font.system(size: 13)
    public static let action = Font.system(size: 15, weight: .medium)
    public static let smallAction = Font.system(size: 13, weight: .medium)
    public static let badge = Font.system(size: 12, weight: .medium)
    public static let appBar = Font.system(size: 16, weight: .semibold)
}
