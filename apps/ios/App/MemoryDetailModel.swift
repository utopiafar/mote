import Foundation
import MoteCentral
import MoteCore
import MoteStorage
import Observation

/// Reads one Memory, its archived evidence and its explicit replacement
/// history through the existing owner routes. Generated preview states never
/// touch a profile.
@MainActor
@Observable
final class MemoryDetailModel {
    enum Panel: String, Identifiable, CaseIterable {
        case more
        case correct
        case history
        case info
        case delete

        var id: String { rawValue }
    }

    struct CorrectionDraft: Equatable {
        var title: String
        var statement: String
        var uncertainty: String
        var validFrom: Date?
        var validUntil: Date?
    }

    var panel: Panel?

    var correctionInitial: CorrectionDraft {
        previewCorrection ?? CorrectionDraft(
            title: content?.title ?? "",
            statement: content?.statement ?? "",
            uncertainty: content?.uncertainty ?? "",
            validFrom: content?.validFrom,
            validUntil: content?.validUntil
        )
    }

    private(set) var content: MemoryDetailContent?
    private(set) var loading = false
    private(set) var errorMessage: String?
    private(set) var saving = false
    private(set) var saveError: String?
    private(set) var deleting = false
    private(set) var deletionError: String?
    var previewStatementFocused = false

    var onChanged: (() -> Void)?
    var onDeleted: (() -> Void)?

    private var id: String
    private let isPreview: Bool
    private let previewCorrection: CorrectionDraft?
    private var loadContent: ((String) async throws -> MemoryDetailContent)?
    private var saveContent: ((String, MemoryCorrectionRequest) async throws -> MemoryDetailContent)?
    private var deleteContent: ((String) async throws -> MemoryDeleteReceipt)?

    private init(id: String, preview: MemoryDetailContent? = nil, panel: Panel? = nil,
                 previewCorrection: CorrectionDraft? = nil) {
        self.id = id
        self.panel = panel
        self.previewCorrection = previewCorrection
        self.content = preview
        self.isPreview = preview != nil
    }

    static func live(id: String) -> MemoryDetailModel {
        let model = MemoryDetailModel(id: id)
        model.loadContent = { id in
            let client = try Self.client()
            let uuid = try Self.uuid(id)
            let record = try await client.memory(id: uuid)
            let evidence = try? await client.memoryEvidence(id: uuid)
            let history = await Self.history(client: client, from: record)
            return MemoryDetailContent.present(
                record: record,
                history: history,
                evidence: evidence?.items ?? []
            )
        }
        model.saveContent = { id, request in
            let client = try Self.client()
            let record = try await client.correctMemory(id: try Self.uuid(id), request: request)
            let evidence = try? await client.memoryEvidence(id: try Self.uuid(record.id))
            let history = await Self.history(client: client, from: record)
            return MemoryDetailContent.present(
                record: record,
                history: history,
                evidence: evidence?.items ?? []
            )
        }
        model.deleteContent = { id in
            try await Self.client().deleteMemory(id: try Self.uuid(id))
        }
        return model
    }

    static func preview(state: String) -> MemoryDetailModel {
        let content = previewContent()
        let panel: Panel? = switch state {
        case "more": .more
        case "correct": .correct
        case "history": .history
        case "info": .info
        case "delete": .delete
        default: nil
        }
        let model = MemoryDetailModel(
            id: content.id,
            preview: content,
            panel: panel,
            previewCorrection: state == "correct" ? CorrectionDraft(
                title: "租房押金",
                statement: "押金为两个月租金，退租后七天内退还，需要收据和交接单",
                uncertainty: "",
                validFrom: nil,
                validUntil: nil
            ) : nil
        )
        model.previewStatementFocused = state == "correct"
        return model
    }

    func load() async {
        guard !isPreview, let loadContent else { return }
        loading = true
        errorMessage = nil
        do {
            content = try await loadContent(id)
        } catch {
            errorMessage = "记忆暂不可读取"
        }
        loading = false
    }

    func save(_ draft: CorrectionDraft) async {
        guard !saving else { return }
        let title = draft.title.trimmingCharacters(in: .whitespacesAndNewlines)
        let statement = draft.statement.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty, !statement.isEmpty else {
            saveError = "标题和纠正后的内容不能为空"
            return
        }
        saving = true
        saveError = nil
        defer { saving = false }
        if isPreview {
            panel = nil
            return
        }
        guard let saveContent, let content else { return }
        let request = MemoryCorrectionRequest(
            title: title,
            statement: statement,
            uncertainty: draft.uncertainty,
            version: content.version,
            validFrom: draft.validFrom.map { CentralTimestamp.string($0) },
            validUntil: draft.validUntil.map { CentralTimestamp.string($0) }
        )
        do {
            let updated = try await saveContent(id, request)
            self.content = updated
            id = updated.id
            panel = nil
            onChanged?()
            await load()
        } catch {
            saveError = "未能保存纠正"
        }
    }

    func delete() async {
        guard !deleting else { return }
        deleting = true
        deletionError = nil
        defer { deleting = false }
        if isPreview {
            panel = nil
            onDeleted?()
            return
        }
        guard let deleteContent else { return }
        do {
            _ = try await deleteContent(id)
            panel = nil
            onDeleted?()
        } catch {
            deletionError = "未能确认删除完成。刷新后可核对当前状态。"
        }
    }

    private static func history(client: CentralClient, from record: MemoryRecord) async -> [MemoryRecord] {
        var records = [record]
        var seen: Set<String> = [record.id]
        var pending: [String] = []
        if let next = record.supersededBy, !next.isEmpty { pending.append(next) }
        for relation in record.relations ?? [] where relation.kind == "supersedes" {
            pending.append(relation.memoryId)
        }
        while !pending.isEmpty && records.count < 100 {
            let next = pending.removeFirst()
            guard seen.insert(next).inserted, let uuid = UUID(uuidString: next),
                  let version = try? await client.memory(id: uuid) else { continue }
            records.append(version)
            if let newer = version.supersededBy, !newer.isEmpty { pending.append(newer) }
            for relation in version.relations ?? [] where relation.kind == "supersedes" {
                pending.append(relation.memoryId)
            }
        }
        return Array(records.dropFirst())
    }

    private static func uuid(_ value: String) throws -> UUID {
        guard let id = UUID(uuidString: value) else { throw MemoryDetailError.invalidReference }
        return id
    }

    private static func client() throws -> CentralClient {
        guard let connection = try MoteStorage.connectionStore().read() else {
            throw MemoryDetailError.notConnected
        }
        return try CentralClient(serverUrl: connection.serverUrl, token: connection.token)
    }

    private static func previewContent() -> MemoryDetailContent {
        MemoryDetailContent(
            id: "memory.generated-deposit",
            version: 2,
            title: "租房押金",
            statement: "押金为两个月租金，下个月退，需要收据。",
            uncertainty: "",
            validityLabel: "今天起",
            evidence: [
                MemoryDetailEvidenceRow(
                    id: "capture.generated-lease",
                    title: "租房合同 2026.pdf",
                    subtitle: "第 4 页",
                    kind: .file
                ),
                MemoryDetailEvidenceRow(
                    id: "capture.generated-heating",
                    title: "暖气费按实际用量分摊，月底前给账单照片",
                    subtitle: "记录 · 今天 14:20",
                    kind: .note
                ),
            ],
            versions: [
                MemoryDetailVersionRow(
                    id: "memory.generated-deposit",
                    statement: "押金为两个月租金，下个月退，需要收据。",
                    subtitle: "当前版本 · 今天起",
                    isCurrent: true
                ),
                MemoryDetailVersionRow(
                    id: "memory.generated-old-deposit",
                    statement: "押金为一个月租金。",
                    subtitle: "历史版本 · 10月1日 – 今天",
                    isCurrent: false
                ),
            ],
            info: [
                MemoryDetailInfoRow(label: "类型", value: "精选记忆"),
                MemoryDetailInfoRow(label: "来源", value: "模型生成"),
                MemoryDetailInfoRow(label: "生成时间", value: "今天 14:31"),
            ]
        )
    }
}

private enum MemoryDetailError: Error {
    case notConnected
    case invalidReference
}
