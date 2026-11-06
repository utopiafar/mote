import Foundation

/// Formats the saved connection for 设置 › 连接与设备. Only local facts the
/// device already has: the central address, the credential scope, the name
/// chosen while connecting and when that connection was saved.
public struct ConnectionDevicePresentation: Equatable, Sendable {
    public let connected: Bool
    public let central: String
    public let permission: String
    public let connectionTime: String
    public let deviceName: String

    public init(
        serverUrl: String?,
        scope: String?,
        deviceName: String?,
        connectedAt: Date?,
        now: Date = Date(),
        calendar: Calendar = .current,
        locale: Locale = Locale(identifier: "zh_CN")
    ) {
        let server = serverUrl?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let name = deviceName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        connected = !server.isEmpty
        central = Self.centralText(server)
        permission = connected ? (scope == "owner" ? "本人设备" : "采集权限") : "尚未连接"
        if connected {
            connectionTime = connectedAt.map {
                Self.dateText($0, now: now, calendar: calendar, locale: locale)
            } ?? "暂不可读取"
        } else {
            connectionTime = "尚未连接"
        }
        self.deviceName = name.isEmpty ? "我的 iPhone" : name
    }

    private static func centralText(_ server: String) -> String {
        guard !server.isEmpty else { return "尚未连接" }
        guard let components = URLComponents(string: server),
              let host = components.host,
              !host.isEmpty
        else { return server }
        if let port = components.port, port != 80, port != 443 {
            return "\(host):\(port)"
        }
        return host
    }

    private static func dateText(_ date: Date, now: Date, calendar: Calendar, locale: Locale) -> String {
        let formatter = DateFormatter()
        formatter.locale = locale
        formatter.timeZone = calendar.timeZone
        if calendar.component(.year, from: date) == calendar.component(.year, from: now) {
            formatter.setLocalizedDateFormatFromTemplate("MMMd")
        } else {
            formatter.dateStyle = .medium
            formatter.timeStyle = .none
        }
        return formatter.string(from: date)
    }
}
