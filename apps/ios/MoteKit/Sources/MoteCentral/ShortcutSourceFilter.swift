import Foundation
import MoteCore

public enum ShortcutSourceFilter {
    public static func notification(
        _ content: IOSNotificationContent,
        settings: ShortcutSourceSettings
    ) -> IOSNotificationContent? {
        guard settings.acceptsCaptures, allows(appId: content.appId, appName: content.appName, settings: settings) else {
            return nil
        }
        let text = settings.notificationContent == .titleOnly ? nil : content.text
        guard !excludes(title: content.title, text: text, rules: settings.excludedText) else { return nil }
        return IOSNotificationContent(
            appId: content.appId,
            appName: content.appName,
            title: content.title,
            text: text,
            category: content.category
        )
    }

    public static func acceptsScreenshot(recognizedText: String?, settings: ShortcutSourceSettings) -> Bool {
        settings.acceptsCaptures && !excludes(title: nil, text: recognizedText, rules: settings.excludedText)
    }

    private static func allows(appId: String, appName: String, settings: ShortcutSourceSettings) -> Bool {
        let allowed = normalizedRules(settings.allowedApps)
        guard !allowed.isEmpty else { return true }
        return allowed.contains(appId.foldedForRule) || allowed.contains(appName.foldedForRule)
    }

    private static func excludes(title: String?, text: String?, rules: [String]) -> Bool {
        let content = [title, text].compactMap { $0 }.joined(separator: "\n").foldedForRule
        guard !content.isEmpty else { return false }
        return normalizedRules(rules).contains { content.contains($0) }
    }

    private static func normalizedRules(_ rules: [String]) -> [String] {
        var seen: Set<String> = []
        return rules.map(\.foldedForRule).filter { !$0.isEmpty && seen.insert($0).inserted }
    }
}

private extension String {
    var foldedForRule: String {
        trimmingCharacters(in: .whitespacesAndNewlines).folding(
            options: [.caseInsensitive, .diacriticInsensitive, .widthInsensitive],
            locale: Locale(identifier: "en_US_POSIX")
        ).lowercased()
    }
}
