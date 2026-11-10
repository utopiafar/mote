import SwiftUI

/// Content on its way: rows in the shape of what replaces them. The words stay for VoiceOver.
/// Nothing shows for the first 300 ms; with Reduce Motion the rows appear at once and hold still.
public struct MoteLoading: View {
    private let label: String
    private let rows: Int
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var shown = false
    @State private var dimmed = false

    public init(_ label: String = "正在读取…", rows: Int = 3) {
        self.label = label
        self.rows = rows
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            ForEach(0..<rows, id: \.self) { index in
                VStack(alignment: .leading, spacing: 9) {
                    bar(fraction: index.isMultiple(of: 2) ? 0.62 : 0.48, cap: index.isMultiple(of: 2) ? 420 : 320, height: 14)
                    bar(fraction: 0.34, cap: 220, height: 11)
                }
            }
        }
        .opacity(dimmed ? 0.45 : 1)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 8)
        .opacity(shown ? 1 : 0)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(label)
        .task {
            guard !reduceMotion else { shown = true; return }
            try? await Task.sleep(for: .milliseconds(300))
            guard !Task.isCancelled else { return }
            withAnimation(.easeOut(duration: 0.2)) { shown = true }
            withAnimation(.easeInOut(duration: 0.9).delay(0.2).repeatForever(autoreverses: true)) { dimmed = true }
        }
    }

    private func bar(fraction: CGFloat, cap: CGFloat, height: CGFloat) -> some View {
        Capsule()
            .fill(MoteDesignTokens.fill.color)
            .containerRelativeFrame(.horizontal, alignment: .leading) { length, _ in min(length * fraction, cap) }
            .frame(height: height)
    }
}
