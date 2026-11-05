import ActivityKit
import MoteCore
import MoteDesign
import SwiftUI
import WidgetKit

@main
struct MoteLiveActivityBundle: WidgetBundle {
    var body: some Widget { RecordingLiveActivityWidget() }
}

private let cardBackground = MoteColorToken.color(hex: "#2b2926")
private let cardText = MoteColorToken.color(hex: "#f2efe9")
private let cardMuted = MoteColorToken.color(hex: "#aba7a1")
private let pauseBackground = MoteColorToken.color(hex: "#3b3834")
private let stopBackground = MoteColorToken.color(hex: "#e8e4dd")
private let stopText = MoteColorToken.color(hex: "#24211e")

struct RecordingLiveActivityWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: RecordingActivityAttributes.self) { context in
            RecordingActivityCard(context: context)
                .background(cardBackground)
                .activityBackgroundTint(cardBackground)
                .activitySystemActionForegroundColor(cardText)
                .widgetURL(MoteEntry.record.deepLinkURL)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    RecordingMark()
                }
                DynamicIslandExpandedRegion(.trailing) {
                    RecordingTime(state: context.state)
                        .font(.system(size: 22, weight: .semibold).monospacedDigit())
                        .frame(width: 86, alignment: .trailing)
                        .foregroundStyle(cardText)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    HStack {
                        Text("录音")
                            .font(.system(size: 13))
                            .foregroundStyle(cardMuted)
                        Spacer()
                        RecordingButtons(context: context)
                    }
                    .padding(.horizontal, 4)
                }
            } compactLeading: {
                MoteIcon(.mic, size: 16).foregroundStyle(cardText)
                    .accessibilityLabel("录音")
            } compactTrailing: {
                RecordingTime(state: context.state)
                    .font(.system(size: 13, weight: .semibold).monospacedDigit())
                    .frame(width: 50, alignment: .trailing)
                    .foregroundStyle(cardText)
            } minimal: {
                MoteIcon(.mic, size: 16).foregroundStyle(cardText)
                    .accessibilityLabel("录音")
            }
            .widgetURL(MoteEntry.record.deepLinkURL)
        }
    }
}

private struct RecordingActivityCard: View {
    let context: ActivityViewContext<RecordingActivityAttributes>

    var body: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 8) {
                    RecordingMark()
                    Text("录音").font(.system(size: 13)).foregroundStyle(cardMuted)
                }
                RecordingTime(state: context.state)
                    .font(.system(size: 32, weight: .semibold).monospacedDigit())
                    .frame(width: 120, height: 45, alignment: .topLeading)
                    .foregroundStyle(cardText)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            RecordingButtons(context: context)
        }
        .padding(.leading, 16)
        .padding(.trailing, 14)
        .padding(.vertical, 14)
        .frame(minHeight: 98)
    }
}

private struct RecordingMark: View {
    var body: some View {
        Text("m")
            .font(.system(size: 16, weight: .semibold))
            .tracking(-0.8)
            .foregroundStyle(stopText)
            .frame(width: 20, height: 20)
            .background(stopBackground, in: RoundedRectangle(cornerRadius: 5))
            .accessibilityHidden(true)
    }
}

private struct RecordingTime: View {
    let state: RecordingActivityAttributes.ContentState
    @Environment(\.isLuminanceReduced) private var isLuminanceReduced

    var body: some View {
        Group {
            if state.isPaused {
                Text(Self.duration(state.elapsed))
            } else if isLuminanceReduced {
                Text(timerInterval: state.timerStart...state.timerStart.addingTimeInterval(8 * 60 * 60), countsDown: false, showsHours: false)
            } else {
                Text(.durationOffset(to: state.timerStart), format: .time(pattern: .minuteSecond(padMinuteToLength: 2)))
            }
        }
        .lineLimit(1)
        .accessibilityLabel("录音")
    }

    private static func duration(_ value: TimeInterval) -> String {
        let seconds = max(0, Int(value))
        return String(format: "%02d:%02d", seconds / 60, seconds % 60)
    }
}

private struct RecordingButtons: View {
    let context: ActivityViewContext<RecordingActivityAttributes>

    var body: some View {
        HStack(spacing: 12) {
            if context.state.isPaused {
                Button(intent: ResumeRecordingActivityIntent(recordingID: context.attributes.recordingID)) {
                    icon(.play, foreground: cardText, background: pauseBackground)
                }
                .accessibilityLabel("继续录音")
            } else {
                Button(intent: PauseRecordingActivityIntent(recordingID: context.attributes.recordingID)) {
                    icon(.pause, foreground: cardText, background: pauseBackground)
                }
                .accessibilityLabel("暂停录音")
            }
            Button(intent: StopRecordingActivityIntent(recordingID: context.attributes.recordingID)) {
                icon(.stop, foreground: stopText, background: stopBackground)
            }
            .accessibilityLabel("停止录音")
        }
        .buttonStyle(.plain)
    }

    private func icon(_ name: MoteIconName, foreground: Color, background: Color) -> some View {
        MoteIcon(name, size: 20)
            .foregroundStyle(foreground)
            .frame(width: 44, height: 44)
            .background(background, in: Circle())
    }
}
