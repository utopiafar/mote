// Generated from the shared 24px linear icon set (canvas/mote.css). Do not edit by hand.
import CoreGraphics

public enum MoteIconName: String, CaseIterable, Sendable {
    case search
    case back
    case chev
    case down
    case close
    case plus
    case mic
    case camera
    case photo
    case file
    case folder
    case calendar
    case bell
    case screen
    case phone
    case laptop
    case bolt
    case link
    case up
    case pause
    case play
    case stop
    case check
    case alert
    case send
    case refresh
    case trash
    case share
    case compose
    case clock
    case history
    case ask
    case library
    case memory
    case plug
    case sliders
    case more
    case qr
    case copy
    case external
    case undo
    case wave
    case lock
    case disk
    case globe
    case home
    case pulse
    case quote
    case keyboard
    case wifi
    case bluetooth
    case moon
    case gear
}

struct MoteIconElement: Sendable {
    enum Geometry: Sendable {
        case path(String)
        case circle(cx: CGFloat, cy: CGFloat, r: CGFloat)
        case rect(x: CGFloat, y: CGFloat, width: CGFloat, height: CGFloat, radius: CGFloat)
    }

    let geometry: Geometry
    let filled: Bool

    init(_ geometry: Geometry, filled: Bool) {
        self.geometry = geometry
        self.filled = filled
    }
}

enum MoteIconCatalog {
    static let elements: [MoteIconName: [MoteIconElement]] = [
        .search: [
            .init(.circle(cx: 11, cy: 11, r: 6.5), filled: false),
            .init(.path("M16 16l4.5 4.5"), filled: false),
        ],
        .back: [
            .init(.path("M15 5l-7 7 7 7"), filled: false),
        ],
        .chev: [
            .init(.path("M9.5 6l6 6-6 6"), filled: false),
        ],
        .down: [
            .init(.path("M6 9.5l6 6 6-6"), filled: false),
        ],
        .close: [
            .init(.path("M6.5 6.5l11 11M17.5 6.5l-11 11"), filled: false),
        ],
        .plus: [
            .init(.path("M12 5v14M5 12h14"), filled: false),
        ],
        .mic: [
            .init(.rect(x: 9, y: 3.5, width: 6, height: 11, radius: 3), filled: false),
            .init(.path("M5.5 11a6.5 6.5 0 0013 0M12 17.5V21"), filled: false),
        ],
        .camera: [
            .init(.path("M4 8.5h3.2L9 6h6l1.8 2.5H20V19H4z"), filled: false),
            .init(.circle(cx: 12, cy: 13.2, r: 3.3), filled: false),
        ],
        .photo: [
            .init(.rect(x: 4, y: 5, width: 16, height: 14, radius: 2), filled: false),
            .init(.path("M4 16l4.5-4.5 4 4 2.5-2.5L20 18"), filled: false),
            .init(.circle(cx: 15.5, cy: 9.5, r: 1.3), filled: false),
        ],
        .file: [
            .init(.path("M7 3.5h6.5L18 8v12.5H7z"), filled: false),
            .init(.path("M13.5 3.5V8H18M9.5 12.5h6M9.5 16h6"), filled: false),
        ],
        .folder: [
            .init(.path("M3.5 6.5h6l2 2.2h9v9.8h-17z"), filled: false),
        ],
        .calendar: [
            .init(.rect(x: 4, y: 5.5, width: 16, height: 14.5, radius: 2), filled: false),
            .init(.path("M4 10h16M8.5 3.5v4M15.5 3.5v4"), filled: false),
        ],
        .bell: [
            .init(.path("M6.5 16.5V11a5.5 5.5 0 0111 0v5.5l1.5 1.5h-14z"), filled: false),
            .init(.path("M10 20.5h4"), filled: false),
        ],
        .screen: [
            .init(.rect(x: 3.5, y: 4.5, width: 17, height: 12, radius: 1.5), filled: false),
            .init(.path("M9 20h6M12 16.5V20"), filled: false),
        ],
        .phone: [
            .init(.rect(x: 7, y: 3, width: 10, height: 18, radius: 2), filled: false),
            .init(.path("M11 18h2"), filled: false),
        ],
        .laptop: [
            .init(.path("M5 6.5h14v9.5H5z"), filled: false),
            .init(.path("M3 18.5h18"), filled: false),
        ],
        .bolt: [
            .init(.path("M13 3L6 13.5h5.5L10.5 21 18 10.5h-5.5z"), filled: false),
        ],
        .link: [
            .init(.path("M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1"), filled: false),
            .init(.path("M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1"), filled: false),
        ],
        .up: [
            .init(.path("M12 19V5M6 11l6-6 6 6"), filled: false),
        ],
        .pause: [
            .init(.path("M9 6v12M15 6v12"), filled: false),
        ],
        .play: [
            .init(.path("M8 5.5v13l10.5-6.5z"), filled: false),
        ],
        .stop: [
            .init(.rect(x: 7, y: 7, width: 10, height: 10, radius: 1.5), filled: false),
        ],
        .check: [
            .init(.path("M5 12.5l4.5 4.5L19 7.5"), filled: false),
        ],
        .alert: [
            .init(.path("M12 4.2L20.8 19.5H3.2z"), filled: false),
            .init(.path("M12 10v4.2M12 17v.01"), filled: false),
        ],
        .send: [
            .init(.path("M12 14.5V4.5M7.5 9L12 4.5 16.5 9"), filled: false),
            .init(.path("M5 14v5.5h14V14"), filled: false),
        ],
        .refresh: [
            .init(.path("M19.5 12a7.5 7.5 0 11-2.2-5.3"), filled: false),
            .init(.path("M19.5 4.5v4h-4"), filled: false),
        ],
        .trash: [
            .init(.path("M5 7h14M10 4h4M7 7l.8 12.5h8.4L17 7"), filled: false),
        ],
        .share: [
            .init(.path("M12 3.5v11M8 7.5l4-4 4 4"), filled: false),
            .init(.path("M8 10.5H5.5v10h13v-10H16"), filled: false),
        ],
        .compose: [
            .init(.path("M4.5 19.5h4l10-10-4-4-10 10z"), filled: false),
            .init(.path("M13 7l4 4"), filled: false),
        ],
        .clock: [
            .init(.circle(cx: 12, cy: 12, r: 8), filled: false),
            .init(.path("M12 8v4.5l3 2"), filled: false),
        ],
        .history: [
            .init(.path("M4.5 12a7.5 7.5 0 102.2-5.3"), filled: false),
            .init(.path("M4.5 4.5v4h4M12 8.5V12l2.5 2"), filled: false),
        ],
        .ask: [
            .init(.path("M5 5.5h14v10h-8.5L6 19v-3.5H5z"), filled: false),
        ],
        .library: [
            .init(.path("M4 7.5L12 4l8 3.5-8 3.5z"), filled: false),
            .init(.path("M4 12l8 3.5 8-3.5M4 16.5L12 20l8-3.5"), filled: false),
        ],
        .memory: [
            .init(.path("M7 4h10v16l-5-3.5L7 20z"), filled: false),
        ],
        .plug: [
            .init(.path("M9 3.5v4M15 3.5v4M7 7.5h10v3a5 5 0 01-10 0zM12 15.5v5"), filled: false),
        ],
        .sliders: [
            .init(.path("M4 7h9M17 7h3M4 17h3M11 17h9"), filled: false),
            .init(.circle(cx: 15, cy: 7, r: 2), filled: false),
            .init(.circle(cx: 9, cy: 17, r: 2), filled: false),
        ],
        .more: [
            .init(.circle(cx: 6, cy: 12, r: 1.5), filled: true),
            .init(.circle(cx: 12, cy: 12, r: 1.5), filled: true),
            .init(.circle(cx: 18, cy: 12, r: 1.5), filled: true),
        ],
        .qr: [
            .init(.rect(x: 4, y: 4, width: 6, height: 6, radius: 1), filled: false),
            .init(.rect(x: 14, y: 4, width: 6, height: 6, radius: 1), filled: false),
            .init(.rect(x: 4, y: 14, width: 6, height: 6, radius: 1), filled: false),
            .init(.path("M14 14h2.5v2.5H14zM17.5 17.5H20V20h-2.5zM20 14v.01M14 20v.01"), filled: false),
        ],
        .copy: [
            .init(.rect(x: 8.5, y: 8.5, width: 11, height: 11, radius: 1.5), filled: false),
            .init(.path("M15.5 5.5v-1h-11v11h1"), filled: false),
        ],
        .external: [
            .init(.path("M10 5H5v14h14v-5M13.5 4.5H19.5V10.5M19.5 4.5L11 13"), filled: false),
        ],
        .undo: [
            .init(.path("M9 6.5L5 10.5l4 4"), filled: false),
            .init(.path("M5 10.5h9.5a4.5 4.5 0 010 9H12"), filled: false),
        ],
        .wave: [
            .init(.path("M4 10v4M8 7v10M12 4.5v15M16 8v8M20 10.5v3"), filled: false),
        ],
        .lock: [
            .init(.rect(x: 5.5, y: 10.5, width: 13, height: 9.5, radius: 1.5), filled: false),
            .init(.path("M8.5 10.5V8a3.5 3.5 0 017 0v2.5"), filled: false),
        ],
        .disk: [
            .init(.rect(x: 4, y: 5, width: 16, height: 14, radius: 2), filled: false),
            .init(.path("M4 14h16M7.5 16.5h1"), filled: false),
        ],
        .globe: [
            .init(.circle(cx: 12, cy: 12, r: 8.5), filled: false),
            .init(.path("M3.5 12h17M12 3.5c2.4 2.5 3.5 5.4 3.5 8.5s-1.1 6-3.5 8.5c-2.4-2.5-3.5-5.4-3.5-8.5s1.1-6 3.5-8.5z"), filled: false),
        ],
        .home: [
            .init(.path("M4.5 10.5L12 4.5l7.5 6V19.5h-15z"), filled: false),
            .init(.path("M10 19.5v-5h4v5"), filled: false),
        ],
        .pulse: [
            .init(.path("M3.5 12h4l2.5-6 4 12 2.5-6h4"), filled: false),
        ],
        .quote: [
            .init(.path("M5 17.5V13c0-3 1.5-5 4-6M13 17.5V13c0-3 1.5-5 4-6"), filled: false),
            .init(.path("M5 13h4v4.5H5zM13 13h4v4.5h-4z"), filled: false),
        ],
        .keyboard: [
            .init(.rect(x: 3.5, y: 6, width: 17, height: 12, radius: 1.5), filled: false),
            .init(.path("M7 10h.01M10.5 10h.01M14 10h.01M17 10h.01M8 14h8"), filled: false),
        ],
        .wifi: [
            .init(.path("M4 9.5a12 12 0 0116 0M7 12.8a7.5 7.5 0 0110 0M9.8 16a3.2 3.2 0 014.4 0"), filled: false),
            .init(.path("M12 19.2v.01"), filled: false),
        ],
        .bluetooth: [
            .init(.path("M7.5 7.5l9 9L12 21V3l4.5 4.5-9 9"), filled: false),
        ],
        .moon: [
            .init(.path("M19 14.5A7.5 7.5 0 019.5 5a7.5 7.5 0 109.5 9.5z"), filled: false),
        ],
        .gear: [
            .init(.circle(cx: 12, cy: 12, r: 3), filled: false),
            .init(.path("M12 3.5v2.2M12 18.3v2.2M3.5 12h2.2M18.3 12h2.2M6 6l1.6 1.6M16.4 16.4L18 18M6 18l1.6-1.6M16.4 7.6L18 6"), filled: false),
        ],
    ]
}
