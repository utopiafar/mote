import SwiftUI

/// A 24pt linear icon from the shared family used by Web, Android and the canvas.
public struct MoteIcon: View {
    public let name: MoteIconName
    public let size: CGFloat

    public init(_ name: MoteIconName, size: CGFloat = 24) {
        self.name = name
        self.size = size
    }

    public var body: some View {
        let elements = MoteIconCatalog.elements[name] ?? []
        ZStack {
            MoteIconShape(elements: elements.filter { !$0.filled })
                .stroke(style: StrokeStyle(lineWidth: 1.65 * size / 24, lineCap: .round, lineJoin: .round))
            MoteIconShape(elements: elements.filter(\.filled))
                .fill()
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

private struct MoteIconShape: Shape {
    let elements: [MoteIconElement]

    func path(in rect: CGRect) -> Path {
        var path = Path()
        for element in elements {
            switch element.geometry {
            case .path(let data):
                appendSVGPath(data, to: &path)
            case .circle(let cx, let cy, let radius):
                path.addEllipse(in: CGRect(x: cx - radius, y: cy - radius, width: radius * 2, height: radius * 2))
            case .rect(let x, let y, let width, let height, let radius):
                let frame = CGRect(x: x, y: y, width: width, height: height)
                if radius > 0 {
                    path.addRoundedRect(in: frame, cornerSize: CGSize(width: radius, height: radius))
                } else {
                    path.addRect(frame)
                }
            }
        }
        let scale = CGAffineTransform(
            a: rect.width / 24, b: 0, c: 0, d: rect.height / 24,
            tx: rect.minX, ty: rect.minY
        )
        return path.applying(scale)
    }
}

/// Parses the SVG path subset used by the shared icon set (M, L, H, V, C, S, Q, T, A, Z).
private func appendSVGPath(_ data: String, to path: inout Path) {
    var scanner = SVGPathScanner(data)
    var current = CGPoint.zero
    var start = CGPoint.zero
    var previousControl: CGPoint?
    var previousCommand: Character = " "

    while let command = scanner.nextCommand() {
        let relative = command.isLowercase
        var handled = true
        switch Character(command.uppercased()) {
        case "M":
            var first = true
            while let point = scanner.nextPoint() {
                var resolved = point
                if relative { resolved.x += current.x; resolved.y += current.y }
                if first {
                    path.move(to: resolved)
                    start = resolved
                    first = false
                } else {
                    path.addLine(to: resolved)
                }
                current = resolved
            }
            previousControl = nil
        case "L":
            while let point = scanner.nextPoint() {
                var resolved = point
                if relative { resolved.x += current.x; resolved.y += current.y }
                path.addLine(to: resolved)
                current = resolved
            }
            previousControl = nil
        case "H":
            while let value = scanner.nextNumber() {
                var x = value
                if relative { x += current.x }
                current.x = x
                path.addLine(to: current)
            }
            previousControl = nil
        case "V":
            while let value = scanner.nextNumber() {
                var y = value
                if relative { y += current.y }
                current.y = y
                path.addLine(to: current)
            }
            previousControl = nil
        case "C":
            while let control1 = scanner.nextPoint(), let control2 = scanner.nextPoint(), let end = scanner.nextPoint() {
                var c1 = control1, c2 = control2, point = end
                if relative {
                    c1.x += current.x; c1.y += current.y
                    c2.x += current.x; c2.y += current.y
                    point.x += current.x; point.y += current.y
                }
                path.addCurve(to: point, control1: c1, control2: c2)
                current = point
                previousControl = c2
            }
        case "S":
            while let control2 = scanner.nextPoint(), let end = scanner.nextPoint() {
                var c2 = control2, point = end
                if relative {
                    c2.x += current.x; c2.y += current.y
                    point.x += current.x; point.y += current.y
                }
                let c1: CGPoint
                if previousCommand == "C" || previousCommand == "S", let previous = previousControl {
                    c1 = CGPoint(x: current.x * 2 - previous.x, y: current.y * 2 - previous.y)
                } else {
                    c1 = current
                }
                path.addCurve(to: point, control1: c1, control2: c2)
                current = point
                previousControl = c2
            }
        case "Q":
            while let control = scanner.nextPoint(), let end = scanner.nextPoint() {
                var c = control, point = end
                if relative {
                    c.x += current.x; c.y += current.y
                    point.x += current.x; point.y += current.y
                }
                path.addQuadCurve(to: point, control: c)
                current = point
                previousControl = c
            }
        case "T":
            while let end = scanner.nextPoint() {
                var point = end
                if relative { point.x += current.x; point.y += current.y }
                let control: CGPoint
                if previousCommand == "Q" || previousCommand == "T", let previous = previousControl {
                    control = CGPoint(x: current.x * 2 - previous.x, y: current.y * 2 - previous.y)
                } else {
                    control = current
                }
                path.addQuadCurve(to: point, control: control)
                current = point
                previousControl = control
            }
        case "A":
            while let radiusX = scanner.nextNumber(), let radiusY = scanner.nextNumber(),
                  let rotation = scanner.nextNumber(), let largeArc = scanner.nextFlag(),
                  let sweep = scanner.nextFlag(), let end = scanner.nextPoint() {
                var point = end
                if relative { point.x += current.x; point.y += current.y }
                appendArc(
                    from: current, to: point,
                    radiusX: radiusX, radiusY: radiusY, rotation: rotation,
                    largeArc: largeArc, sweep: sweep, to: &path
                )
                current = point
            }
            previousControl = nil
        case "Z":
            path.closeSubpath()
            current = start
            previousControl = nil
        default:
            handled = false
        }
        if !handled { break }
        previousCommand = Character(command.uppercased())
        if !["C", "S", "Q", "T"].contains(previousCommand) {
            previousControl = nil
        }
    }
}

private struct SVGPathScanner {
    private let characters: [Character]
    private var index = 0

    init(_ string: String) {
        characters = Array(string)
    }

    mutating func nextCommand() -> Character? {
        skipSeparators()
        guard index < characters.count, characters[index].isLetter else { return nil }
        defer { index += 1 }
        return characters[index]
    }

    mutating func nextNumber() -> CGFloat? {
        skipSeparators()
        guard index < characters.count else { return nil }
        let start = index
        if characters[index] == "+" || characters[index] == "-" { index += 1 }
        var hasDigit = false
        while index < characters.count, characters[index].isNumber {
            hasDigit = true
            index += 1
        }
        if index < characters.count, characters[index] == "." {
            index += 1
            while index < characters.count, characters[index].isNumber {
                hasDigit = true
                index += 1
            }
        }
        if hasDigit, index < characters.count, characters[index] == "e" || characters[index] == "E" {
            index += 1
            if index < characters.count, characters[index] == "+" || characters[index] == "-" { index += 1 }
            while index < characters.count, characters[index].isNumber { index += 1 }
        }
        guard hasDigit, let value = Double(String(characters[start..<index])) else {
            index = start
            return nil
        }
        return CGFloat(value)
    }

    mutating func nextPoint() -> CGPoint? {
        guard let x = nextNumber(), let y = nextNumber() else { return nil }
        return CGPoint(x: x, y: y)
    }

    mutating func nextFlag() -> Bool? {
        skipSeparators()
        guard index < characters.count, characters[index] == "0" || characters[index] == "1" else { return nil }
        defer { index += 1 }
        return characters[index] == "1"
    }

    private mutating func skipSeparators() {
        while index < characters.count, characters[index] == "," || characters[index].isWhitespace {
            index += 1
        }
    }
}

private func appendArc(
    from start: CGPoint, to end: CGPoint,
    radiusX: CGFloat, radiusY: CGFloat, rotation: CGFloat,
    largeArc: Bool, sweep: Bool, to path: inout Path
) {
    guard start != end else { return }
    var rx = abs(radiusX), ry = abs(radiusY)
    guard rx > 0, ry > 0 else {
        path.addLine(to: end)
        return
    }

    let phi = rotation * .pi / 180
    let cosine = cos(phi), sine = sin(phi)
    let dx = (start.x - end.x) / 2
    let dy = (start.y - end.y) / 2
    let x1 = cosine * dx + sine * dy
    let y1 = -sine * dx + cosine * dy

    let lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry)
    if lambda > 1 {
        let scale = sqrt(lambda)
        rx *= scale
        ry *= scale
    }

    let numerator = max(0, rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1)
    let denominator = rx * rx * y1 * y1 + ry * ry * x1 * x1
    var factor = denominator == 0 ? 0 : sqrt(numerator / denominator)
    if largeArc == sweep { factor = -factor }
    let cx1 = factor * rx * y1 / ry
    let cy1 = -factor * ry * x1 / rx
    let centerX = cosine * cx1 - sine * cy1 + (start.x + end.x) / 2
    let centerY = sine * cx1 + cosine * cy1 + (start.y + end.y) / 2

    func angle(_ ux: CGFloat, _ uy: CGFloat, _ vx: CGFloat, _ vy: CGFloat) -> CGFloat {
        let dot = ux * vx + uy * vy
        let length = sqrt(ux * ux + uy * uy) * sqrt(vx * vx + vy * vy)
        guard length > 0 else { return 0 }
        let value = max(-1, min(1, dot / length))
        return (ux * vy - uy * vx < 0 ? -1 : 1) * acos(value)
    }

    let startAngle = angle(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry)
    var deltaAngle = angle((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry)
    if !sweep, deltaAngle > 0 { deltaAngle -= 2 * .pi }
    if sweep, deltaAngle < 0 { deltaAngle += 2 * .pi }

    let segments = max(1, Int(ceil(abs(deltaAngle) / (.pi / 2))))
    let segmentAngle = deltaAngle / CGFloat(segments)

    func point(angle: CGFloat) -> CGPoint {
        let x = rx * cos(angle), y = ry * sin(angle)
        return CGPoint(x: cosine * x - sine * y + centerX, y: sine * x + cosine * y + centerY)
    }

    for segment in 0..<segments {
        let startA = startAngle + CGFloat(segment) * segmentAngle
        let endA = startA + segmentAngle
        let alpha = 4 / 3 * tan(segmentAngle / 4)
        let p1 = point(angle: startA)
        let p2 = point(angle: endA)
        let startDerivative = CGPoint(x: -rx * sin(startA), y: ry * cos(startA))
        let endDerivative = CGPoint(x: -rx * sin(endA), y: ry * cos(endA))
        let c1 = CGPoint(
            x: p1.x + alpha * (cosine * startDerivative.x - sine * startDerivative.y),
            y: p1.y + alpha * (sine * startDerivative.x + cosine * startDerivative.y)
        )
        let c2 = CGPoint(
            x: p2.x - alpha * (cosine * endDerivative.x - sine * endDerivative.y),
            y: p2.y - alpha * (sine * endDerivative.x + cosine * endDerivative.y)
        )
        path.addCurve(to: p2, control1: c1, control2: c2)
    }
}
