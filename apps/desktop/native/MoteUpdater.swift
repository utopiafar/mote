import AppKit
import Foundation
import Darwin
import CryptoKit

struct UpdateJob: Codable {
    let schemaVersion: Int
    let nonce: String
    let parentPID: Int32
    let profile: String
    let targetPath: String
    let candidatePath: String
    let oldVersion: String
    let newVersion: String
    let arch: String
    let teamId: String?
    let candidateDigest: String
    let targetDigest: String
    let startupTimeoutSeconds: Int?
}
struct UpdateFailure: Error { let code: String }
let files = FileManager.default
func writeJSON(_ object: [String: Any], to path: String) throws {
    let data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    try data.write(to: URL(fileURLWithPath: path), options: [.atomic])
    try files.setAttributes([.posixPermissions: 0o600], ofItemAtPath: path)
}
func emit(_ object: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) { FileHandle.standardOutput.write(data); FileHandle.standardOutput.write(Data("\n".utf8)) }
}
func canonical(_ path: String) -> String {
    guard let pointer = realpath(path, nil) else { return URL(fileURLWithPath: path).standardizedFileURL.path }
    defer { free(pointer) }; return String(cString: pointer)
}
func run(_ executable: String, _ arguments: [String], timeout: TimeInterval = 30) throws -> String {
    let process = Process(); process.executableURL = URL(fileURLWithPath: executable); process.arguments = arguments
    let pipe = Pipe(); process.standardOutput = pipe; process.standardError = pipe
    try process.run()
    var output = Data(); let group = DispatchGroup(); group.enter()
    DispatchQueue.global().async { output = pipe.fileHandleForReading.readDataToEndOfFile(); group.leave() }
    let deadline = Date().addingTimeInterval(timeout)
    while process.isRunning && Date() < deadline { Thread.sleep(forTimeInterval: 0.05) }
    if process.isRunning { process.terminate(); throw UpdateFailure(code: "TOOL_TIMEOUT") }
    process.waitUntilExit(); _ = group.wait(timeout: .now() + 1)
    guard process.terminationStatus == 0 else { throw UpdateFailure(code: "BUNDLE_TOOL_" + URL(fileURLWithPath: executable).lastPathComponent.uppercased()) }
    return String(data: output.prefix(32768), encoding: .utf8) ?? ""
}
func info(_ path: String) throws -> [String: Any] {
    guard path.hasSuffix(".app"), canonical(path) == path,
          let value = NSDictionary(contentsOfFile: path + "/Contents/Info.plist") as? [String: Any],
          value["CFBundleIdentifier"] as? String == "dev.mote.collector",
          let executable = value["CFBundleExecutable"] as? String,
          !executable.isEmpty, !executable.contains("/"), !executable.contains("..") else { throw UpdateFailure(code: "BUNDLE_INFO_INVALID") }
    return value
}
func validateBundle(_ path: String, version: String, arch: String, teamId: String? = nil) throws {
    let value = try info(path)
    guard value["CFBundleShortVersionString"] as? String == version else { throw UpdateFailure(code: "VERSION_MISMATCH") }
    _ = try run("/usr/bin/codesign", ["--verify", "--deep", "--strict", path])
    _ = try run("/usr/bin/lipo", [path + "/Contents/MacOS/" + (value["CFBundleExecutable"] as! String), "-verify_arch", arch == "x64" ? "x86_64" : "arm64"])
    if let teamId = teamId {
        let signature = try run("/usr/bin/codesign", ["-dv", "--verbose=4", path])
        guard signature.split(separator: "\n").contains(Substring("TeamIdentifier=" + teamId)) else { throw UpdateFailure(code: "SIGNER_MISMATCH") }
    }
}
func bundleDigest(_ path: String) throws -> String {
    var entries: [String] = []
    func walk(_ relative: String) throws {
        for name in try files.contentsOfDirectory(atPath: path + (relative.isEmpty ? "" : "/" + relative)) {
            let item = relative.isEmpty ? name : relative + "/" + name
            let attributes = try files.attributesOfItem(atPath: path + "/" + item)
            entries.append(item)
            if attributes[.type] as? FileAttributeType == .typeDirectory { try walk(item) }
        }
    }
    try walk(""); entries.sort { $0.utf8.lexicographicallyPrecedes($1.utf8) }
    var digest = SHA256()
    for relative in entries {
        let full = path + "/" + relative, attributes = try files.attributesOfItem(atPath: full)
        let mode = (attributes[.posixPermissions] as? NSNumber)?.intValue ?? 0
        let type = attributes[.type] as? FileAttributeType
        let kind = type == .typeDirectory ? "D" : type == .typeSymbolicLink ? "L" : type == .typeRegular ? "F" : "?"
        guard kind != "?" else { throw UpdateFailure(code: "BUNDLE_INVALID") }
        digest.update(data: Data("\(kind) \(mode & 0o777) \(relative.utf8.count):\(relative)\0".utf8))
        if kind == "L" {
            let target = try files.destinationOfSymbolicLink(atPath: full)
            guard canonical(full).hasPrefix(path + "/"), !target.hasPrefix("/") else { throw UpdateFailure(code: "UNSAFE_SYMLINK") }
            digest.update(data: Data(target.utf8))
        } else if kind == "F" {
            var fileDigest = SHA256(); let handle = try FileHandle(forReadingFrom: URL(fileURLWithPath: full)); defer { try? handle.close() }
            while let bytes = try handle.read(upToCount: 1048576), !bytes.isEmpty { fileDigest.update(data: bytes) }
            digest.update(data: Data(fileDigest.finalize().map { String(format: "%02x", $0) }.joined().utf8))
        }
        digest.update(data: Data("\n".utf8))
    }
    return digest.finalize().map { String(format: "%02x", $0) }.joined()
}
func instances(_ path: String, excluding pid: Int32? = nil) -> [NSRunningApplication] {
    NSWorkspace.shared.runningApplications.filter { application in
        application.processIdentifier != pid && application.bundleURL.map { canonical($0.path) == path } == true
    }
}
func waitUntil(_ timeout: TimeInterval, _ predicate: () -> Bool) -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline { if predicate() { return true }; RunLoop.current.run(until: Date().addingTimeInterval(0.1)) }
    return predicate()
}
func swapBundles(_ target: String, _ candidate: String) throws {
    // macOS atomic exchange keeps the installation path valid even if this helper is killed between steps.
    let result = target.withCString { targetPointer in candidate.withCString { candidatePointer in renameatx_np(AT_FDCWD, targetPointer, AT_FDCWD, candidatePointer, UInt32(RENAME_SWAP)) } }
    guard result == 0 else { throw UpdateFailure(code: "REPLACE_FAILED") }
}
func launch(_ path: String, profile: String, transaction: String?) throws -> NSRunningApplication {
    let configuration = NSWorkspace.OpenConfiguration(); configuration.createsNewApplicationInstance = true
    configuration.arguments = ["--profile=" + profile] + (transaction.map { ["--mote-update-transaction=" + $0] } ?? [])
    configuration.environment = ProcessInfo.processInfo.environment.filter { !$0.key.hasPrefix("MOTE_") && !$0.key.hasPrefix("ELECTRON_") && !$0.key.hasPrefix("DYLD_") }
    var result: NSRunningApplication?; var completed = false
    NSWorkspace.shared.openApplication(at: URL(fileURLWithPath: path), configuration: configuration) { application, _ in result = application; completed = true }
    guard waitUntil(30, { completed }), let application = result else { throw UpdateFailure(code: "RELAUNCH_FAILED") }
    return application
}
func apply(_ jobPath: String) throws {
    let folder = URL(fileURLWithPath: jobPath).deletingLastPathComponent().path
    let attributes = try files.attributesOfItem(atPath: jobPath)
    guard canonical(jobPath) == jobPath, (attributes[.ownerAccountID] as? NSNumber)?.uint32Value == getuid(),
          let size = attributes[.size] as? NSNumber, size.intValue < 16384 else { throw UpdateFailure(code: "JOB_INVALID") }
    let job = try JSONDecoder().decode(UpdateJob.self, from: Data(contentsOf: URL(fileURLWithPath: jobPath)))
    guard job.schemaVersion == 1, job.nonce.range(of: "^[a-f0-9]{32}$", options: .regularExpression) != nil,
          job.profile.range(of: "^[a-z0-9][a-z0-9_-]{0,31}$", options: .regularExpression) != nil,
          ["arm64", "x64"].contains(job.arch), job.parentPID > 1, job.oldVersion != job.newVersion, job.candidateDigest.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil, job.targetDigest.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else { throw UpdateFailure(code: "JOB_INVALID") }
    let parent = URL(fileURLWithPath: job.targetPath).deletingLastPathComponent().path
    let candidate = parent + "/.mote-stage-" + job.nonce + ".app"
    let lock = parent + "/.mote-update-lock"
    guard candidate == job.candidatePath, canonical(parent) == parent,
          let marker = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: lock + "/owner.json"))) as? [String: Any], marker["nonce"] as? String == job.nonce else { throw UpdateFailure(code: "JOB_INVALID") }
    let readyPath = folder + "/ready.json", resultPath = folder + "/result.json"
    var swapped = false; var launched: NSRunningApplication?
    do {
        try validateBundle(job.targetPath, version: job.oldVersion, arch: job.arch)
        try validateBundle(candidate, version: job.newVersion, arch: job.arch, teamId: job.teamId)
        guard try bundleDigest(candidate) == job.candidateDigest, try bundleDigest(job.targetPath) == job.targetDigest else { throw UpdateFailure(code: "STAGE_CHANGED") }
        guard instances(job.targetPath, excluding: job.parentPID).isEmpty else { throw UpdateFailure(code: "OTHER_PROFILES_RUNNING") }
        try writeJSON(["nonce": job.nonce, "pid": Int(getpid())], to: lock + "/owner.json")
        emit(["ready": true, "nonce": job.nonce])
        guard waitUntil(120, { kill(job.parentPID, 0) != 0 && errno == ESRCH }) else { throw UpdateFailure(code: "PARENT_DID_NOT_EXIT") }
        guard instances(job.targetPath).isEmpty else { throw UpdateFailure(code: "OTHER_PROFILES_RUNNING") }
        // Revalidate after waiting; the app never trusts a candidate that changed while quitting.
        try validateBundle(candidate, version: job.newVersion, arch: job.arch, teamId: job.teamId)
        guard try bundleDigest(candidate) == job.candidateDigest, try bundleDigest(job.targetPath) == job.targetDigest else { throw UpdateFailure(code: "STAGE_CHANGED") }
        try swapBundles(job.targetPath, candidate); swapped = true
        try writeJSON(["state": "starting", "version": job.newVersion], to: resultPath)
        launched = try launch(job.targetPath, profile: job.profile, transaction: folder)
        let acknowledged = waitUntil(TimeInterval(max(5, min(75, job.startupTimeoutSeconds ?? 75)))) {
            guard let data = try? Data(contentsOf: URL(fileURLWithPath: readyPath)),
                  let ack = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return false }
            return ack["nonce"] as? String == job.nonce && ack["version"] as? String == job.newVersion
        }
        guard acknowledged else { throw UpdateFailure(code: "STARTUP_NOT_CONFIRMED") }
        try writeJSON(["state": "installed", "version": job.newVersion], to: resultPath)
        try? files.removeItem(atPath: candidate)
        try? files.removeItem(atPath: lock)
    } catch {
        let code = (error as? UpdateFailure)?.code ?? "INSTALL_FAILED"
        if swapped {
            if let application = launched, !application.isTerminated {
                _ = application.terminate()
                guard waitUntil(15, { application.isTerminated }) else {
                    try? writeJSON(["state": "failed", "code": "NEW_APP_STILL_RUNNING", "backupRetained": true], to: resultPath)
                    return // Never swap files beneath a still-running unconfirmed app or erase the old bundle.
                }
            }
            guard instances(job.targetPath).isEmpty else {
                try? writeJSON(["state": "failed", "code": "OTHER_PROFILES_RUNNING", "backupRetained": true], to: resultPath); return
            }
            do { try swapBundles(job.targetPath, candidate); swapped = false }
            catch { try? writeJSON(["state": "failed", "code": "ROLLBACK_FAILED", "backupRetained": true], to: resultPath); return }
            try? writeJSON(["state": "rolled_back", "code": code, "version": job.oldVersion], to: resultPath)
            _ = try? launch(job.targetPath, profile: job.profile, transaction: nil)
        } else {
            try? writeJSON(["state": "failed", "code": code], to: resultPath)
            if kill(job.parentPID, 0) != 0 && errno == ESRCH && instances(job.targetPath).isEmpty { _ = try? launch(job.targetPath, profile: job.profile, transaction: nil) }
        }
        try? files.removeItem(atPath: lock)
        // Failed candidate remains available for diagnosis; user data is never read, moved, or deleted.
    }
}

do {
    let command = CommandLine.arguments.dropFirst().first ?? ""
    if command == "apply", CommandLine.arguments.count == 3 { try apply(CommandLine.arguments[2]) }
    else if command == "inspect", CommandLine.arguments.count == 6 {
        let path = CommandLine.arguments[2], version = CommandLine.arguments[3], arch = CommandLine.arguments[4]
        try validateBundle(path, version: version, arch: arch)
        emit(["valid": true, "otherInstances": instances(path, excluding: Int32(CommandLine.arguments[5])).count, "digest": try bundleDigest(path)])
    } else { throw UpdateFailure(code: "COMMAND_INVALID") }
} catch { emit(["error": (error as? UpdateFailure)?.code ?? "UPDATER_FAILED"]); exit(1) }
