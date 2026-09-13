import AppKit
import Foundation

// Generated test artwork only. This program never calls screen/window capture APIs.
let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 960, pixelsHigh: 540,
    bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
    colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
NSColor.white.setFill()
NSRect(x: 0, y: 0, width: 960, height: 540).fill()
let attributes: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 38, weight: .bold), .foregroundColor: NSColor.black]
("MOTE GENERATED DESKTOP FIXTURE" as NSString).draw(at: NSPoint(x: 35, y: 430), withAttributes: attributes)
("Synthetic timeline and queue validation" as NSString).draw(at: NSPoint(x: 35, y: 355), withAttributes: [.font: NSFont.systemFont(ofSize: 28), .foregroundColor: NSColor.darkGray])
("GENERATED PRIVATE AREA" as NSString).draw(at: NSPoint(x: 35, y: 95), withAttributes: attributes)
NSGraphicsContext.restoreGraphicsState()
FileHandle.standardOutput.write(bitmap.representation(using: .jpeg, properties: [.compressionFactor: 0.9])!)
