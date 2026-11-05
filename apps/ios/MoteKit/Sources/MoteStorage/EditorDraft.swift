import Foundation

public enum EditorAttachmentKind: String, Codable, Sendable {
    case photo
    case audio
    case file
}

public struct EditorAttachment: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let kind: EditorAttachmentKind
    public let fileName: String
    public let storedFileName: String
    public let duration: TimeInterval?

    public init(
        id: String,
        kind: EditorAttachmentKind,
        fileName: String,
        storedFileName: String,
        duration: TimeInterval? = nil
    ) {
        self.id = id
        self.kind = kind
        self.fileName = fileName
        self.storedFileName = storedFileName
        self.duration = duration
    }
}

public struct EditorDraft: Codable, Equatable, Sendable {
    public var text: String
    public var sourceDescription: String
    public var attachments: [EditorAttachment]

    public init(
        text: String = "",
        sourceDescription: String = "",
        attachments: [EditorAttachment] = []
    ) {
        self.text = text
        self.sourceDescription = sourceDescription
        self.attachments = attachments
    }

    public var isEmpty: Bool {
        text.isEmpty && sourceDescription.isEmpty && attachments.isEmpty
    }
}

public struct EditorDraftSession: Equatable, Sendable {
    public private(set) var draft: EditorDraft
    private var clearedDraft: EditorDraft?

    public init(draft: EditorDraft = EditorDraft()) {
        self.draft = draft
    }

    public var canUndoClear: Bool {
        clearedDraft != nil
    }

    public mutating func update(_ change: (inout EditorDraft) -> Void) {
        clearedDraft = nil
        change(&draft)
    }

    public mutating func clear() {
        clearedDraft = draft
        draft = EditorDraft()
    }

    public mutating func undoClear() {
        guard let clearedDraft else { return }
        draft = clearedDraft
        self.clearedDraft = nil
    }
}

public final class EditorDraftStore {
    private let attachmentsURL: URL
    private let store: DraftStore
    private let fileManager: FileManager

    public init(directoryURL: URL, fileManager: FileManager = .default) {
        self.attachmentsURL = directoryURL.appendingPathComponent("Attachments", isDirectory: true)
        self.store = DraftStore(directoryURL: directoryURL, fileManager: fileManager)
        self.fileManager = fileManager
    }

    public func load() throws -> EditorDraft {
        try store.read(EditorDraft.self) ?? EditorDraft()
    }

    public func save(_ draft: EditorDraft) throws {
        try store.save(draft)
    }

    public func importData(
        _ data: Data,
        kind: EditorAttachmentKind,
        fileName: String,
        duration: TimeInterval? = nil
    ) throws -> EditorAttachment {
        let id = UUID().uuidString
        let pathExtension = URL(fileURLWithPath: fileName).pathExtension
        let storedFileName = pathExtension.isEmpty ? id : "\(id).\(pathExtension)"
        let destination = attachmentsURL.appendingPathComponent(storedFileName)
        try fileManager.createDirectory(at: attachmentsURL, withIntermediateDirectories: true)
        try data.write(to: destination, options: .atomic)
        return EditorAttachment(
            id: id,
            kind: kind,
            fileName: fileName,
            storedFileName: storedFileName,
            duration: duration
        )
    }

    public func importFile(
        at sourceURL: URL,
        kind: EditorAttachmentKind,
        duration: TimeInterval? = nil
    ) throws -> EditorAttachment {
        try importData(
            Data(contentsOf: sourceURL),
            kind: kind,
            fileName: sourceURL.lastPathComponent,
            duration: duration
        )
    }

    public func fileURL(for attachment: EditorAttachment) -> URL {
        attachmentsURL.appendingPathComponent(attachment.storedFileName)
    }

    public func delete(_ attachment: EditorAttachment) throws {
        let url = fileURL(for: attachment)
        guard fileManager.fileExists(atPath: url.path) else { return }
        try fileManager.removeItem(at: url)
    }
}
