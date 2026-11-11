import SwiftUI

/// The Mote mark in its 24-unit box: one stroke writes the m, its last leg rests on a dot.
/// Web (`Loading.tsx`), Android (`MarkView`) and the generated app icons draw the same geometry.
public enum MoteMarkGeometry {
    public static let box: CGFloat = 24
    public static let stroke: CGFloat = 2.2
    public static let dotCenter = CGPoint(x: 18.25, y: 15.85)
    public static let dotRadius: CGFloat = 1.65

    /// Scales the box into `rect`, centered.
    static func fit(_ rect: CGRect) -> CGAffineTransform {
        let scale = min(rect.width, rect.height) / box
        return CGAffineTransform(translationX: rect.midX - box * scale / 2, y: rect.midY - box * scale / 2)
            .scaledBy(x: scale, y: scale)
    }
}

/// The m alone; stroke it with round caps and joins.
public struct MoteMarkStroke: Shape {
    public init() {}

    public func path(in rect: CGRect) -> Path {
        var path = Path()
        path.move(to: CGPoint(x: 5.25, y: 16.5))
        path.addLine(to: CGPoint(x: 5.25, y: 7.5))
        for (start, end) in [(CGFloat(5.25), CGFloat(16.5)), (CGFloat(11.75), CGFloat(12.2))] {
            path.move(to: CGPoint(x: start, y: 10.75))
            path.addArc(center: CGPoint(x: start + 3.25, y: 10.75), radius: 3.25,
                        startAngle: .degrees(180), endAngle: .degrees(360), clockwise: false)
            path.addLine(to: CGPoint(x: start + 6.5, y: end))
        }
        return path.applying(MoteMarkGeometry.fit(rect))
    }
}

/// The dot the last leg rests on.
public struct MoteMarkDot: Shape {
    public init() {}

    public func path(in rect: CGRect) -> Path {
        let center = MoteMarkGeometry.dotCenter, radius = MoteMarkGeometry.dotRadius
        return Path(ellipseIn: CGRect(x: center.x - radius, y: center.y - radius, width: radius * 2, height: radius * 2))
            .applying(MoteMarkGeometry.fit(rect))
    }
}

/// The mark used by the app bar, connection screens and Mote-owned steps.
public struct MoteMark: View {
    private let size: CGFloat
    private let ink: Color
    private let dot: Color

    public init(size: CGFloat = MoteMetrics.markSize,
                ink: Color = MoteDesignTokens.ink.color,
                dot: Color = MoteDesignTokens.accent.color) {
        self.size = size
        self.ink = ink
        self.dot = dot
    }

    public var body: some View {
        ZStack {
            MoteMarkStroke()
                .stroke(ink, style: StrokeStyle(lineWidth: MoteMarkGeometry.stroke * size / MoteMarkGeometry.box,
                                                lineCap: .round, lineJoin: .round))
            MoteMarkDot().fill(dot)
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}
