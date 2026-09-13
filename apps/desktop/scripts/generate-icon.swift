import AppKit
import Foundation

let directory = CommandLine.arguments[1]
try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
for size in [16, 32, 128, 256, 512] {
    for scale in [1, 2] {
        let pixels = size * scale
        let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels,
            bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
            colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
        let n = CGFloat(pixels)
        NSColor(calibratedRed: 40/255, green: 103/255, blue: 70/255, alpha: 1).setFill()
        NSBezierPath(roundedRect: NSRect(x: n*0.07, y: n*0.07, width: n*0.86, height: n*0.86), xRadius: n*0.21, yRadius: n*0.21).fill()
        let attributes: [NSAttributedString.Key: Any] = [
            .font: NSFont(name: "Georgia", size: n*0.68) ?? NSFont.systemFont(ofSize: n*0.68),
            .foregroundColor: NSColor.white,
        ]
        let label = "m" as NSString
        let width = label.size(withAttributes: attributes).width
        label.draw(at: NSPoint(x: (n-width)/2, y: n*0.12), withAttributes: attributes)
        NSGraphicsContext.restoreGraphicsState()
        let suffix = scale == 2 ? "@2x" : ""
        try bitmap.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: "\(directory)/icon_\(size)x\(size)\(suffix).png"))
    }
}
