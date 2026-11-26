import SwiftUI

/// Content on its way: rows in the shape of what replaces them. The words stay for VoiceOver.
/// Nothing shows for the first 300 ms; with Reduce Motion the rows appear at once and hold still.
public struct MoteLoading: View {
    private let label: String
    private let rows: Int

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
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 8)
        .modifier(LoadingReveal(label: label))
    }

    private func bar(fraction: CGFloat, cap: CGFloat, height: CGFloat) -> some View {
        Capsule()
            .fill(MoteDesignTokens.fill.color)
            .containerRelativeFrame(.horizontal, alignment: .leading) { length, _ in min(length * fraction, cap) }
            .frame(height: height)
    }
}

/// An image on its way: a quiet tile where it will appear, with the same timing as `MoteLoading`.
public struct MoteLoadingTile: View {
    private let label: String
    private let height: CGFloat

    public init(_ label: String = "正在读取…", height: CGFloat = 220) {
        self.label = label
        self.height = height
    }

    public var body: some View {
        RoundedRectangle(cornerRadius: MoteMetrics.groupRadius, style: .continuous)
            .fill(MoteDesignTokens.fill.color)
            .frame(maxWidth: .infinity)
            .frame(height: height)
            .modifier(LoadingReveal(label: label))
    }
}

/// Give fast reads time to finish before revealing the placeholder.
private struct LoadingReveal: ViewModifier {
    let label: String
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var shown = false

    func body(content: Content) -> some View {
        content
            .opacity(shown ? 1 : 0)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(label)
            .task(id: reduceMotion) {
                guard !shown else { return }
                try? await Task.sleep(for: MoteMotion.loadingDelay)
                guard !Task.isCancelled else { return }
                withAnimation(reduceMotion ? nil : MoteMotion.settle(MoteMotion.enter)) { shown = true }
            }
    }
}
