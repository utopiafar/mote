// Draws the Mote mark — a single-stroke lowercase m whose last leg ends in a dot —
// into every raster icon the clients ship. The web SVG and the Android vector
// drawables carry the same path data.
//
//   swift apps/desktop/scripts/generate-brand-icons.swift mac <iconset-dir>      (desktop build)
//   swift apps/desktop/scripts/generate-brand-icons.swift tray <directory>       (apps/desktop/resources/tray)
//   swift apps/desktop/scripts/generate-brand-icons.swift ios <appiconset-dir>   (apps/ios/App/Assets.xcassets/AppIcon.appiconset)
//   swift apps/desktop/scripts/generate-brand-icons.swift touch <png-file>       (apps/web/public/apple-touch-icon.png)
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

func rgb(_ hex: UInt32, _ alpha: CGFloat = 1) -> CGColor {
    CGColor(srgbRed: CGFloat(hex >> 16 & 0xff) / 255, green: CGFloat(hex >> 8 & 0xff) / 255, blue: CGFloat(hex & 0xff) / 255, alpha: alpha)
}
struct Palette { let background: CGColor; let ink: CGColor; let accent: CGColor }
let paper = Palette(background: rgb(0xf7f5f1), ink: rgb(0x2d2a26), accent: rgb(0x7651a4))
let night = Palette(background: rgb(0x1c1b1a), ink: rgb(0xedebe8), accent: rgb(0xc2b0e6))
let tinted = Palette(background: rgb(0x000000), ink: rgb(0xffffff), accent: rgb(0xffffff))

/// Geometry in a 24-unit, y-down box. Small sizes open the arches and thicken the stroke.
struct Cut {
    let x: CGFloat, arch: CGFloat, radius: CGFloat, lastLeg: CGFloat, stroke: CGFloat
    let dot: (x: CGFloat, y: CGFloat, r: CGFloat)
    static let regular = Cut(x: 5.25, arch: 10.75, radius: 3.25, lastLeg: 12.2, stroke: 2.1, dot: (18.25, 15.85, 1.7))
    static let small = Cut(x: 5, arch: 10.9, radius: 3.4, lastLeg: 11.6, stroke: 2.6, dot: (18.6, 15.6, 2.05))
    static let tiny = Cut(x: 5, arch: 10.9, radius: 3.4, lastLeg: 11.6, stroke: 2.9, dot: (18.6, 15.6, 2.2))
    /// The alert state lifts the dot clear of the m.
    static let raisedDot: (x: CGFloat, y: CGFloat, r: CGFloat) = (20.6, 4.4, 2.9)
    static func forSize(_ pixels: CGFloat) -> Cut { pixels < 17 ? .tiny : pixels < 40 ? .small : .regular }
}

func drawMark(_ context: CGContext, in box: CGRect, cut: Cut, ink: CGColor, accent: CGColor, raised: Bool = false) {
    context.saveGState()
    context.translateBy(x: box.minX, y: box.maxY)
    context.scaleBy(x: box.width / 24, y: -box.height / 24)
    let path = CGMutablePath()
    path.move(to: CGPoint(x: cut.x, y: 16.5)); path.addLine(to: CGPoint(x: cut.x, y: 7.5))
    for (start, end) in [(cut.x, CGFloat(16.5)), (cut.x + 2 * cut.radius, cut.lastLeg)] {
        path.move(to: CGPoint(x: start, y: cut.arch))
        path.addRelativeArc(center: CGPoint(x: start + cut.radius, y: cut.arch), radius: cut.radius, startAngle: .pi, delta: .pi)
        path.addLine(to: CGPoint(x: start + 2 * cut.radius, y: end))
    }
    context.addPath(path)
    context.setStrokeColor(ink); context.setLineWidth(cut.stroke)
    context.setLineCap(.round); context.setLineJoin(.round)
    context.strokePath()
    let dot = raised ? Cut.raisedDot : cut.dot
    context.setFillColor(accent)
    context.fillEllipse(in: CGRect(x: dot.x - dot.r, y: dot.y - dot.r, width: dot.r * 2, height: dot.r * 2))
    context.restoreGState()
}

func writePNG(_ pixels: Int, to path: String, opaque: Bool = false, draw: (CGContext, CGFloat) -> Void) throws {
    let info = opaque ? CGImageAlphaInfo.noneSkipLast.rawValue : CGImageAlphaInfo.premultipliedLast.rawValue
    guard let context = CGContext(data: nil, width: pixels, height: pixels, bitsPerComponent: 8, bytesPerRow: 0,
                                  space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: info) else { throw CocoaError(.fileWriteUnknown) }
    context.interpolationQuality = .high
    draw(context, CGFloat(pixels))
    guard let image = context.makeImage(),
          let destination = CGImageDestinationCreateWithURL(URL(fileURLWithPath: path) as CFURL, UTType.png.identifier as CFString, 1, nil)
    else { throw CocoaError(.fileWriteUnknown) }
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination) else { throw CocoaError(.fileWriteUnknown) }
}

/// A full-bleed square; iOS and the web touch icon are masked by the system.
func squareIcon(_ palette: Palette) -> (CGContext, CGFloat) -> Void {
    { context, size in
        context.setFillColor(palette.background); context.fill(CGRect(x: 0, y: 0, width: size, height: size))
        let glyph = size * 70 / 92
        drawMark(context, in: CGRect(x: (size - glyph) / 2, y: (size - glyph) / 2, width: glyph, height: glyph),
                 cut: Cut.forSize(glyph), ink: palette.ink, accent: palette.accent)
    }
}

/// macOS draws no mask: the icon carries its own rounded body, edge and shadow (824 of 1024).
func macIcon(_ context: CGContext, _ size: CGFloat) {
    let inset = size * 100 / 1024, side = size - inset * 2
    let body = CGRect(x: inset, y: inset, width: side, height: side)
    let shape = CGPath(roundedRect: body, cornerWidth: side * 0.2237, cornerHeight: side * 0.2237, transform: nil)
    context.saveGState()
    context.setShadow(offset: CGSize(width: 0, height: -size * 0.0125), blur: size * 0.035, color: rgb(0x2d2a26, 0.2))
    context.addPath(shape); context.setFillColor(paper.background); context.fillPath()
    context.restoreGState()
    let edge = max(1, size / 512)
    context.addPath(CGPath(roundedRect: body.insetBy(dx: edge / 2, dy: edge / 2), cornerWidth: side * 0.2237 - edge / 2, cornerHeight: side * 0.2237 - edge / 2, transform: nil))
    context.setStrokeColor(rgb(0xe1dcd3)); context.setLineWidth(edge); context.strokePath()
    let glyph = side * 64 / 84
    drawMark(context, in: CGRect(x: body.midX - glyph / 2, y: body.midY - glyph / 2, width: glyph, height: glyph),
             cut: Cut.forSize(glyph), ink: paper.ink, accent: paper.accent)
}

/// Menu-bar templates: black plus alpha; macOS supplies the color.
func trayIcon(dimmed: Bool, raised: Bool) -> (CGContext, CGFloat) -> Void {
    { context, size in
        context.setAlpha(dimmed ? 0.35 : 1)
        context.beginTransparencyLayer(auxiliaryInfo: nil)
        drawMark(context, in: CGRect(x: 0, y: 0, width: size, height: size), cut: .small, ink: rgb(0), accent: rgb(0), raised: raised)
        context.endTransparencyLayer()
    }
}

let arguments = CommandLine.arguments
guard arguments.count == 3 else {
    FileHandle.standardError.write("usage: generate-brand-icons.swift mac|tray|ios|touch <output>\n".data(using: .utf8)!)
    exit(64)
}
let output = arguments[2]
switch arguments[1] {
case "mac":
    try FileManager.default.createDirectory(atPath: output, withIntermediateDirectories: true)
    for size in [16, 32, 128, 256, 512] {
        for scale in [1, 2] {
            try writePNG(size * scale, to: "\(output)/icon_\(size)x\(size)\(scale == 2 ? "@2x" : "").png", draw: macIcon)
        }
    }
case "tray":
    try FileManager.default.createDirectory(atPath: output, withIntermediateDirectories: true)
    for (name, dimmed, raised) in [("Normal", false, false), ("Paused", true, false), ("Alert", false, true)] {
        for scale in [1, 2] {
            try writePNG(18 * scale, to: "\(output)/mote\(name)Template\(scale == 2 ? "@2x" : "").png", draw: trayIcon(dimmed: dimmed, raised: raised))
        }
    }
case "ios":
    try FileManager.default.createDirectory(atPath: output, withIntermediateDirectories: true)
    for (name, palette) in [("AppIcon", paper), ("AppIcon-Dark", night), ("AppIcon-Tinted", tinted)] {
        try writePNG(1024, to: "\(output)/\(name).png", opaque: true, draw: squareIcon(palette))
    }
case "touch":
    try writePNG(180, to: output, opaque: true, draw: squareIcon(paper))
default:
    FileHandle.standardError.write("unknown target \(arguments[1])\n".data(using: .utf8)!)
    exit(64)
}
