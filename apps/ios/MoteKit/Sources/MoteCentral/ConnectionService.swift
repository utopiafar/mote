import Foundation

public enum ConnectionService {
    /// Redeem only a declared iOS invitation and verify the resulting owner
    /// identity before returning anything that can be saved or used to send.
    public static func establish(invitation: ConnectionInvitation, deviceId: String, deviceName: String,
                                 session: URLSession = .shared) async throws -> SavedConnection {
        let credential = try await CentralClient.redeem(invitation: invitation, deviceId: deviceId,
                                                        deviceName: deviceName, session: session)
        let client = try CentralClient(serverUrl: invitation.serverUrl, token: credential.token, session: session)
        _ = try await client.verify(deviceId: deviceId, credentialId: credential.credentialId)
        return SavedConnection(credential: credential, deviceId: deviceId, deviceName: deviceName)
    }
}
