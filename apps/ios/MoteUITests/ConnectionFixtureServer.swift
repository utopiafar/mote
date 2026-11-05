import Foundation
import Network

/// A generated, loopback-only Central for the simulator connection journey.
final class ConnectionFixtureServer: @unchecked Sendable {
    private let listener: NWListener
    private let queue = DispatchQueue(label: "dev.mote.ios.test.central")
    private var deviceId = ""
    private var paths: [String] = []
    private let ready = DispatchSemaphore(value: 0)

    init() throws {
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
        listener = try NWListener(using: parameters)
        listener.stateUpdateHandler = { [ready] state in
            if case .ready = state { ready.signal() }
        }
        listener.newConnectionHandler = { [weak self] connection in
            guard let self else { connection.cancel(); return }
            connection.start(queue: self.queue)
            self.receive(connection, data: Data())
        }
        listener.start(queue: queue)
        guard ready.wait(timeout: .now() + 5) == .success, listener.port != nil else {
            listener.cancel()
            throw NSError(domain: "GeneratedCentral", code: 1)
        }
    }

    var origin: String { "http://127.0.0.1:\(listener.port!.rawValue)" }
    var requests: [String] { queue.sync { paths } }
    func stop() { listener.cancel() }

    private func receive(_ connection: NWConnection, data: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] chunk, _, complete, error in
            guard let self else { connection.cancel(); return }
            var data = data
            if let chunk { data.append(chunk) }
            guard let boundary = data.range(of: Data("\r\n\r\n".utf8)) else {
                if complete || error != nil { connection.cancel() } else { self.receive(connection, data: data) }
                return
            }
            let header = String(decoding: data[..<boundary.lowerBound], as: UTF8.self)
            let length = header.components(separatedBy: "\r\n").first { $0.lowercased().hasPrefix("content-length:") }
                .flatMap { Int($0.split(separator: ":", maxSplits: 1)[1].trimmingCharacters(in: .whitespaces)) } ?? 0
            let body = Data(data[boundary.upperBound...])
            guard body.count >= length else {
                if complete || error != nil { connection.cancel() } else { self.receive(connection, data: data) }
                return
            }
            let path = header.components(separatedBy: " ").dropFirst().first ?? ""
            self.paths.append(path)
            let response: [String: Any]
            if path == "/api/connections/redeem",
               let request = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
               let id = request["deviceId"] as? String, request["platform"] as? String == "ios" {
                self.deviceId = id
                response = ["serverUrl": self.origin, "token": "generated-token", "credentialId": "generated-credential", "scope": "owner"]
            } else if path == "/api/connections/self", header.contains("Bearer generated-token"), !self.deviceId.isEmpty {
                response = ["credential": ["id": "generated-credential", "scope": "owner", "label": "Generated",
                                            "serverUrl": self.origin, "deviceId": self.deviceId, "platform": "ios"],
                            "node": ["version": "generated", "profile": "dev", "protocol": ["min": 1, "max": 1]],
                            "capabilities": ["ingest": true, "ingressVersion": 2, "ownSources": true, "archiveRead": true]]
            } else {
                response = ["error": "unexpected_request"]
            }
            let payload = (try? JSONSerialization.data(withJSONObject: response)) ?? Data()
            let headerBytes = Data("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: \(payload.count)\r\nConnection: close\r\n\r\n".utf8)
            connection.send(content: headerBytes + payload, completion: .contentProcessed { _ in connection.cancel() })
        }
    }
}
