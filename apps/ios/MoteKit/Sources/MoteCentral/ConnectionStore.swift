import Foundation
import Security
#if DEBUG && targetEnvironment(simulator)
import CryptoKit
import Darwin
#endif

/// The verified connection used by this installation.
public struct SavedConnection: Codable, Equatable, Sendable {
    public let credential: DeviceCredential
    public let deviceId: String
    public let deviceName: String

    public init(credential: DeviceCredential, deviceId: String, deviceName: String) {
        self.credential = credential
        self.deviceId = deviceId
        self.deviceName = deviceName
    }
}

public struct ConnectionStore: Sendable {
    private let service: String
    private let account = "current"

    public init(service: String = "dev.mote.ios.connection") {
        self.service = service
    }

    public func read() throws -> SavedConnection? {
        #if DEBUG && targetEnvironment(simulator)
        let url = try developmentProfileURL()
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        return try JSONDecoder().decode(SavedConnection.self, from: Data(contentsOf: url))
        #else
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else { throw ConnectionStoreError.keychain(status) }
        return try JSONDecoder().decode(SavedConnection.self, from: data)
        #endif
    }

    public func save(_ connection: SavedConnection) throws {
        let data = try JSONEncoder().encode(connection)
        #if DEBUG && targetEnvironment(simulator)
        let url = try developmentProfileURL()
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o700])
        let temporary = url.deletingLastPathComponent().appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: temporary) }
        try data.write(to: temporary, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: temporary.path)
        guard rename(temporary.path, url.path) == 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
        #else
        let attributes: [String: Any] = [kSecValueData as String: data,
                                         kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        var status = SecItemUpdate(baseQuery as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            var query = baseQuery
            attributes.forEach { query[$0.key] = $0.value }
            status = SecItemAdd(query as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw ConnectionStoreError.keychain(status) }
        #endif
    }

    #if DEBUG && targetEnvironment(simulator)
    private func developmentProfileURL() throws -> URL {
        let root = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask,
                                               appropriateFor: nil, create: true)
        let name = SHA256.hash(data: Data(service.utf8)).map { String(format: "%02x", $0) }.joined()
        return root.appendingPathComponent("DevProfile", isDirectory: true).appendingPathComponent(name + ".json")
    }
    #else
    private var baseQuery: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service, kSecAttrAccount as String: account]
    }
    #endif
}

public enum ConnectionStoreError: Error {
    case keychain(OSStatus)
}
