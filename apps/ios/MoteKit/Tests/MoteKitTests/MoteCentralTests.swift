import XCTest
import MoteCentral

final class MoteCentralTests: XCTestCase {
    private let code = String(repeating: "a", count: 43)
    private let now = Date(timeIntervalSince1970: 1_790_848_800)

    private func invitationJSON(server: String = "http://127.0.0.1:3030", expiresAt: String = "2026-10-01T11:00:00.000Z") -> String {
        #"{"format":"mote.connection","version":1,"serverUrl":""# + server + #"","code":""# + code + #"","expiresAt":""# + expiresAt + #""}"#
    }

    func testInvitationParsesJSONAndCanonicalDeepLink() throws {
        let json = invitationJSON()
        let invitation = try ConnectionInvitation.parse(json, now: now)
        XCTAssertEqual(invitation.serverUrl, "http://127.0.0.1:3030")
        XCTAssertEqual(invitation.code, code)
        let encoded = Data(json.utf8).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        XCTAssertEqual(try ConnectionInvitation.parse("mote://connect?data=" + encoded, now: now), invitation)
    }

    func testInvitationRejectsExpiredRemoteHTTPAndUnexpectedFields() throws {
        XCTAssertThrowsError(try ConnectionInvitation.parse(invitationJSON(expiresAt: "2026-10-01T00:00:00Z"), now: now)) {
            XCTAssertEqual($0 as? CentralError, .invitationExpired)
        }
        XCTAssertThrowsError(try ConnectionInvitation.parse(invitationJSON(server: "http://example.com"), now: now)) {
            XCTAssertEqual($0 as? CentralError, .invalidEndpoint)
        }
        let extra = invitationJSON().replacingOccurrences(of: #"{"format""#, with: #"{"extra":true,"format""#)
        XCTAssertThrowsError(try ConnectionInvitation.parse(extra, now: now)) {
            XCTAssertEqual($0 as? CentralError, .invalidInvitation)
        }
    }

    func testNotificationUsesOnlyPostedShortcutsAndContentDigest() throws {
        let content = IOSNotificationContent(appId: "generated.app", appName: "Generated app", title: "Generated title", text: "Generated body")
        let first = try IOSNotificationCapture.make(content: content, deviceId: "generated-iphone", deviceName: "Generated iPhone", postedAt: "2026-10-01T00:00:00Z")
        let later = try IOSNotificationCapture.make(content: content, deviceId: "generated-iphone", deviceName: "Generated iPhone", postedAt: "2026-10-01T00:01:00Z")
        let changed = try IOSNotificationCapture.make(content: IOSNotificationContent(appId: content.appId, appName: content.appName, title: content.title, text: "Changed body"), deviceId: "generated-iphone", deviceName: "Generated iPhone", postedAt: "2026-10-01T00:01:00Z")
        let notification = try XCTUnwrap(first.metadata?.notification)
        XCTAssertEqual(notification.action, .posted)
        XCTAssertEqual(notification.notificationKey.count, 64)
        XCTAssertEqual(notification.notificationKey, later.metadata?.notification?.notificationKey)
        XCTAssertNotEqual(notification.notificationKey, changed.metadata?.notification?.notificationKey)
        XCTAssertEqual(first.metadata?.collector?.method, "shortcuts")
        XCTAssertEqual(first.platform, .ios)
        let encoded = try JSONEncoder().encode(first)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        let metadata = try XCTUnwrap(object["metadata"] as? [String: Any])
        let payload = try XCTUnwrap(metadata["notification"] as? [String: Any])
        XCTAssertEqual(payload["action"] as? String, "posted")
        XCTAssertNil(payload["updatedAt"])
        XCTAssertNil(object["ocrText"])
    }

    func testHeartbeatEncodingKeepsExistingWireShape() throws {
        let heartbeat = Heartbeat(deviceId: "generated-iphone", deviceName: "Generated iPhone", status: .capturing, queueDepth: 2,
                                  lastCaptureAt: "2026-10-01T00:00:00Z",
                                  sync: HeartbeatSync(mode: .interval, state: .idle, intervalMinutes: 15, batchSize: 50,
                                                      pendingRecords: 2, blockedRecords: 0, awaitingOcrRecords: 0, retainedRecords: 0))
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(heartbeat)) as? [String: Any])
        XCTAssertEqual(object["platform"] as? String, "ios")
        XCTAssertEqual(object["status"] as? String, "capturing")
        XCTAssertEqual(object["queueDepth"] as? Int, 2)
        let sync = try XCTUnwrap(object["sync"] as? [String: Any])
        XCTAssertEqual(sync["mode"] as? String, "interval")
        XCTAssertEqual(sync["pendingRecords"] as? Int, 2)
        XCTAssertNil(object["lastSeenAt"])
    }

    func testRealCentralResponsesDecodeThroughProductionClient() async throws {
        let environment = ProcessInfo.processInfo.environment
        guard let invitationJSON = environment["MOTE_SWIFT_CONTRACT_INVITATION"],
              let deviceId = environment["MOTE_SWIFT_CONTRACT_DEVICE_ID"],
              let conversationId = environment["MOTE_SWIFT_CONTRACT_CONVERSATION"],
              let memoryId = environment["MOTE_SWIFT_CONTRACT_MEMORY"] else {
            throw XCTSkip("Use apps/ios/test-fixtures/central-swift-contract.ts")
        }
        let invitation = try ConnectionInvitation.parse(invitationJSON)
        let credential = try await CentralClient.redeem(invitation: invitation, deviceId: deviceId, deviceName: "Generated iPhone")
        XCTAssertEqual(credential.scope, "owner")
        let client = try CentralClient(serverUrl: credential.serverUrl, token: credential.token)
        let identity = try await client.verify(deviceId: deviceId, credentialId: credential.credentialId)
        XCTAssertEqual(identity.credential.platform, .ios)
        XCTAssertTrue(identity.node.protocol.supportsMote())

        let heartbeat = Heartbeat(deviceId: deviceId, deviceName: "Generated iPhone", status: .capturing, queueDepth: 0,
                                  sync: HeartbeatSync(mode: .interval, state: .idle, intervalMinutes: 15, batchSize: 50, pendingRecords: 0))
        let heartbeatAcknowledgement = try await client.sendHeartbeat(heartbeat)
        XCTAssertTrue(heartbeatAcknowledgement.ok)

        let note = CaptureUpload(deviceId: deviceId, deviceName: "Generated iPhone", capturedAt: "2026-10-01T00:00:00Z",
                                 source: .note, appId: "dev.mote.ios", appName: "Mote", ocrText: "Generated iOS original",
                                 privacy: CapturePrivacy(collection: .content),
                                 metadata: RecordMetadata(version: 1, observedAt: "2026-10-01T00:00:00Z", collector: CollectorMetadata(method: "shortcuts")))
        let receipt = try await client.upload(note)
        XCTAssertEqual(receipt.id, note.id)
        XCTAssertFalse(receipt.duplicate)
        let originals = try await client.originals(after: "2026-09-30T00:00:00Z", before: "2026-10-02T00:00:00Z", source: .note)
        XCTAssertTrue(originals.items.contains { $0.id == note.id && $0.textPreview == "Generated iOS original" })
        let original = try await client.original(id: try XCTUnwrap(UUID(uuidString: note.id)))
        XCTAssertEqual(original.ocrText, "Generated iOS original")
        XCTAssertEqual(original.metadata?.collector?.method, "shortcuts")

        let notificationContent = IOSNotificationContent(appId: "generated.messages", appName: "Generated Messages",
                                                         title: "Generated delivery", text: "Generated package arrived")
        let notification = try IOSNotificationCapture.make(content: notificationContent, deviceId: deviceId,
                                                          deviceName: "Generated iPhone", postedAt: "2026-10-01T00:00:00Z")
        let notificationReceipt = try await client.upload(notification)
        XCTAssertEqual(notificationReceipt.id, notification.id)
        XCTAssertFalse(notificationReceipt.duplicate)
        let notificationReplay = try IOSNotificationCapture.make(content: notificationContent, deviceId: deviceId,
                                                                deviceName: "Generated iPhone", postedAt: "2026-10-01T00:01:00Z")
        XCTAssertNotEqual(notificationReplay.id, notification.id)
        let replayReceipt = try await client.upload(notificationReplay)
        XCTAssertTrue(replayReceipt.duplicate)
        XCTAssertEqual(replayReceipt.id, notification.id)
        let notifications = try await client.originals(after: "2026-09-30T00:00:00Z", before: "2026-10-02T00:00:00Z",
                                                       source: .notification)
        XCTAssertEqual(notifications.items.count, 1)
        XCTAssertEqual(notifications.items.first?.id, notification.id)
        XCTAssertTrue(notifications.items.first?.textPreview.contains("Generated delivery") == true)
        XCTAssertTrue(notifications.items.first?.textPreview.contains("Generated package arrived") == true)
        let notificationOriginal = try await client.original(id: try XCTUnwrap(UUID(uuidString: notification.id)))
        XCTAssertEqual(notificationOriginal.platform, .ios)
        XCTAssertEqual(notificationOriginal.metadata?.notification?.action, .posted)
        XCTAssertEqual(notificationOriginal.metadata?.notification?.notificationKey,
                       notification.metadata?.notification?.notificationKey)
        XCTAssertEqual(notificationOriginal.metadata?.collector?.method, "shortcuts")

        let conversations = try await client.conversations()
        XCTAssertTrue(conversations.items.contains { $0.id == conversationId })
        let conversation = try await client.conversation(id: try XCTUnwrap(UUID(uuidString: conversationId)))
        XCTAssertEqual(conversation.turns.first?.result?.answer, "Generated saved answer")
        XCTAssertEqual(conversation.turns.first?.result?.citations.first?.appName, "Generated source")

        let memories = try await client.memories()
        XCTAssertTrue(memories.items.contains { $0.id == memoryId && $0.disclosure != nil })
        let memory = try await client.memory(id: try XCTUnwrap(UUID(uuidString: memoryId)))
        XCTAssertEqual(memory.title, "Generated Swift memory")
        XCTAssertEqual(memory.evidenceIds.count, 1)
        let evidence = try await client.memoryEvidence(id: try XCTUnwrap(UUID(uuidString: memoryId)))
        XCTAssertEqual(evidence.items.first?.ocrText, "Generated saved source body")

        let trees = try await client.contextTrees()
        XCTAssertTrue(trees.items.contains { tree in
            tree.id == "knowledge" && tree.nodes.contains { $0.id == "episodic" }
        })
        let allMemories = try await client.memoryRecords()
        XCTAssertTrue(allMemories.items.contains { $0.id == memoryId && !$0.statement.isEmpty })
        let events = try await client.memoryContextPage(treeID: "knowledge", nodeID: "episodic")
        XCTAssertTrue(events.items.contains { $0.id == memoryId })

        let library = try await client.library()
        XCTAssertTrue(library.items.contains { entry in
            entry.entryType == "capture" && entry.capture?.id == note.id
        })
    }

    func testLibraryBrowseDecodesMaterialAndCaptureEntries() throws {
        let json = #"""
        {"items":[
          {"entryType":"material","ref":"material:generated","contentAt":"2026-10-01T02:00:00Z","material":{"title":"租房合同 2026.pdf","kind":"mote.file","origin":{"sourceId":"generated-source","lastAt":"2026-10-01T02:00:00Z"}}},
          {"entryType":"capture","ref":"capture:generated","contentAt":"2026-10-01T01:00:00Z","capture":{"id":"00000000-0000-4000-8000-000000000001","capturedAt":"2026-10-01T01:00:00Z","deviceId":"generated-iphone","deviceName":"Generated iPhone","platform":"ios","source":"note","appId":"dev.mote.ios","appName":"Mote","windowTitle":"","durationMs":0,"hasImage":false,"ocr":{"status":"completed"},"textPreview":"Generated note","sizeBytes":14}}
        ],"nextCursor":"generated-cursor"}
        """#
        let page = try JSONDecoder().decode(LibraryBrowsePage.self, from: Data(json.utf8))
        XCTAssertEqual(page.nextCursor, "generated-cursor")
        XCTAssertEqual(page.items.map(\.entryType), ["material", "capture"])
        XCTAssertEqual(page.items.first?.material?.title, "租房合同 2026.pdf")
        XCTAssertEqual(page.items.last?.capture?.source, .note)
    }
}
