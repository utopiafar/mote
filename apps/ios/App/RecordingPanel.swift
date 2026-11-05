import MoteDesign
import SwiftUI

struct RecordingPanel: View {
    @ObservedObject var recording: RecordingController
    let collapse: () -> Void

    private let heights: [CGFloat] = [8, 14, 22, 12, 30, 18, 26, 34, 20, 12, 24, 36, 28, 16, 10, 22, 30, 14, 26, 18, 12, 8, 6, 6, 6, 6, 6, 6, 6, 6]

    var body: some View {
        VStack(spacing: 16) {
            if recording.state.interrupted {
                HStack(spacing: 10) {
                    MoteIcon(.pause, size: 20)
                        .foregroundStyle(MoteDesignTokens.muted.color)
                    Text("录音已暂停")
                        .font(MoteFont.body)
                        .foregroundStyle(MoteDesignTokens.ink.color)
                    Spacer()
                    if let cause = recording.interruptionCause {
                        Text(cause)
                            .font(MoteFont.secondary)
                            .foregroundStyle(MoteDesignTokens.muted.color)
                    }
                }
                .padding(.horizontal, 16)
                .frame(height: 44)
                .background(MoteDesignTokens.surface.color, in: Capsule())
                .overlay { Capsule().strokeBorder(MoteDesignTokens.hair.color, lineWidth: 1) }
            }
            HStack(spacing: 16) {
                Text(recordingDuration(recording.elapsed))
                    .font(.system(size: 34, weight: .semibold))
                    .monospacedDigit()
                    .foregroundStyle(MoteDesignTokens.ink.color)
                    .frame(width: 104, alignment: .leading)
                    .accessibilityIdentifier("mote-recording-elapsed")
                HStack(spacing: 3) {
                    ForEach(Array(heights.enumerated()), id: \.offset) { index, height in
                        RoundedRectangle(cornerRadius: 2)
                            .fill(index < 21 ? MoteDesignTokens.ink.color : MoteDesignTokens.border.color)
                            .frame(width: 3, height: height)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .frame(height: 40)
                .clipped()
                .accessibilityHidden(true)
            }
            HStack {
                MoteIconButton(icon: .down, label: "收起", action: collapse)
                Spacer()
                Button { recording.stop() } label: {
                    MoteIcon(.stop, size: 24)
                        .foregroundStyle(MoteDesignTokens.primaryInk.color)
                        .frame(width: 64, height: 64)
                        .background(MoteDesignTokens.primaryBackground.color, in: Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("停止录音")
                .accessibilityIdentifier("mote-recording-stop")
                Spacer()
                Button {
                    if recording.isPaused { recording.resume() } else { recording.pause() }
                } label: {
                    MoteIcon(recording.isPaused ? .play : .pause, size: 24)
                        .foregroundStyle(MoteDesignTokens.ink.color)
                        .frame(width: 44, height: 44)
                        .background(MoteDesignTokens.fill.color, in: Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(recording.isPaused ? "继续录音" : "暂停录音")
            }
            .frame(height: 64)
        }
        .padding(.horizontal, 20)
        .padding(.top, 18)
        .padding(.bottom, 30)
        .background(MoteDesignTokens.surface.color)
        .overlay(alignment: .top) {
            Rectangle().fill(MoteDesignTokens.hair.color).frame(height: 1)
        }
    }
}
