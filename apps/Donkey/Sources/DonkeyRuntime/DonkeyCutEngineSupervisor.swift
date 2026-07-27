import Foundation

/// Runs the Donkey Cut engine — the local server behind donkeycut.com — for the app's lifetime.
///
/// Cut's page is static html/js served from the hosted site; everything real (project files, ffmpeg,
/// on-device speech, the user's own claude/codex logins) happens in this engine on 127.0.0.1. The app
/// spawns it at launch, restarts it with backoff if it dies, and terminates it on quit. The engine is
/// version-locked to the app: updates ride app releases, and the stamped version feeds the site's
/// update nudge.
///
/// The engine's lifetime is strictly tied to this app process. The engine watches the app's pid and
/// exits when it dies (crash, force-kill, update relaunch), and at launch the supervisor replaces any
/// engine on the port stamped with a different version — an engine from before either mechanism
/// existed, or one whose parent-watch has not fired yet. A version-matched engine (another instance
/// of this same build) and a developer-run "dev" engine are left alone.
///
/// Cut is free and standalone, so the engine runs regardless of Donkey sign-in state.
public final class DonkeyCutEngineSupervisor: @unchecked Sendable {
    /// The loopback port this build's engine binds, probes, and evicts stale engines on. The dev
    /// app sets DonkeyCutEnginePort in its Info.plist (scripts/run-donkey-dev.sh) so its engine
    /// and a release engine coexist instead of killing each other; the release build omits the
    /// key and takes the default, which matches the hosted client's target (DEFAULT_ENGINE_PORT
    /// in site/src/cut/lib/ports.ts).
    private static let port: Int = {
        let raw = Bundle.main.object(forInfoDictionaryKey: "DonkeyCutEnginePort")
        if let n = raw as? Int { return n }
        if let s = raw as? String, let n = Int(s) { return n }
        return 41417
    }()

    /// All mutable state is confined to this queue.
    private let queue = DispatchQueue(label: "donkey.cut-engine-supervisor")
    private var process: Process?
    private var stopped = false
    private var restartDelay: TimeInterval = 2
    private var spawnedAt: Date?

    public init() {}

    public func start() {
        queue.async { self.spawnIfNeeded() }
    }

    public func stop() {
        queue.sync {
            stopped = true
            process?.terminate()
            process = nil
        }
    }

    /// The engine binary: a dev/test override first, then the copy shipped in the app bundle.
    /// `nil` (e.g. a dev build made without the site checkout) just means Donkey runs without Cut.
    private static func engineBinary() -> URL? {
        let fileManager = FileManager.default
        if let raw = getenv("DONKEY_CUT_ENGINE_BIN") {
            let override = String(cString: raw)
            if !override.isEmpty {
                let url = URL(fileURLWithPath: (override as NSString).expandingTildeInPath)
                if fileManager.isExecutableFile(atPath: url.path) { return url }
            }
        }
        guard let baked = Bundle.main.resourceURL?
            .appendingPathComponent("cut-engine", isDirectory: true)
            .appendingPathComponent("donkey-cut-engine")
        else { return nil }
        return fileManager.isExecutableFile(atPath: baked.path) ? baked : nil
    }

    /// This app's release version, as stamped into the engine it spawns.
    private static let appVersion =
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "dev"

    /// Thread-crossing result box for the synchronous health probe.
    private final class ProbeResult: @unchecked Sendable {
        var version: String?
    }

    /// The version a Cut engine already on the port reports, or nil when no Cut engine answers.
    /// An engine that answers without a version field maps to "" so it reads as a mismatch.
    private func servedEngineVersion() -> String? {
        guard let url = URL(string: "http://127.0.0.1:\(Self.port)/api/cut/engine/health") else { return nil }
        var request = URLRequest(url: url)
        request.timeoutInterval = 1.0
        let semaphore = DispatchSemaphore(value: 0)
        let probe = ProbeResult()
        URLSession.shared.dataTask(with: request) { data, _, _ in
            defer { semaphore.signal() }
            guard let data,
                  let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  payload["engine"] as? String == "donkey-cut"
            else { return }
            probe.version = payload["version"] as? String ?? ""
        }.resume()
        semaphore.wait()
        return probe.version
    }

    /// SIGTERM (then SIGKILL) whatever is listening on the engine port. Used only after the health
    /// probe confirmed the listener is a Cut engine from another app build.
    private static func terminateListeners() {
        let lsof = Process()
        lsof.executableURL = URL(fileURLWithPath: "/usr/sbin/lsof")
        lsof.arguments = ["-nP", "-t", "-iTCP:\(port)", "-sTCP:LISTEN"]
        let pipe = Pipe()
        lsof.standardOutput = pipe
        lsof.standardError = FileHandle.nullDevice
        guard (try? lsof.run()) != nil else { return }
        lsof.waitUntilExit()
        let own = ProcessInfo.processInfo.processIdentifier
        let pids = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
            .split(whereSeparator: \.isNewline)
            .compactMap { Int32($0.trimmingCharacters(in: .whitespaces)) }
            .filter { $0 != own } ?? []
        for pid in pids { kill(pid, SIGTERM) }
        for _ in 0..<20 {
            if pids.allSatisfy({ kill($0, 0) != 0 }) { return }
            usleep(100_000)
        }
        for pid in pids { kill(pid, SIGKILL) }
    }

    private func spawnIfNeeded() {
        guard !stopped, process == nil else { return }
        guard let binary = Self.engineBinary() else { return }
        switch servedEngineVersion() {
        case Self.appVersion?, "dev"?:
            // Another instance of this same build, or a developer-run engine: leave it, check later.
            scheduleRespawn(after: 60)
            return
        case .some:
            // An engine from another app build. Replace it so engine fixes ship with the update.
            Self.terminateListeners()
        case nil:
            break
        }

        var environment = BundledTools.childEnvironment()
        environment["DONKEY_CUT_ENGINE"] = "1"
        environment["DONKEY_CUT_VERSION"] = Self.appVersion
        environment["DONKEY_CUT_PORT"] = String(Self.port)
        environment["DONKEY_CUT_PARENT_PID"] = String(ProcessInfo.processInfo.processIdentifier)
        if let tools = BundledTools.resolvedDirectory() {
            environment["DONKEY_CUT_TOOLS_DIR"] = tools.path
        }

        let child = Process()
        child.executableURL = binary
        child.environment = environment
        child.currentDirectoryURL = FileManager.default.homeDirectoryForCurrentUser
        let log = Self.openLog()
        child.standardOutput = log ?? FileHandle.nullDevice
        child.standardError = log ?? FileHandle.nullDevice
        child.terminationHandler = { [weak self] _ in
            guard let self else { return }
            self.queue.async {
                self.process = nil
                guard !self.stopped else { return }
                // A crash after a healthy stretch restarts promptly; rapid crash loops back off.
                let uptime = self.spawnedAt.map { Date().timeIntervalSince($0) } ?? 0
                if uptime > 300 { self.restartDelay = 2 }
                let delay = self.restartDelay
                self.restartDelay = min(self.restartDelay * 2, 60)
                self.scheduleRespawn(after: delay)
            }
        }

        do {
            try child.run()
            process = child
            spawnedAt = Date()
        } catch {
            scheduleRespawn(after: 60)
        }
    }

    private func scheduleRespawn(after delay: TimeInterval) {
        queue.asyncAfter(deadline: .now() + delay) { [weak self] in
            self?.spawnIfNeeded()
        }
    }

    /// Engine stdout/stderr land in ~/Library/Logs/Donkey/cut-engine.log; truncated when it grows
    /// past a few MB so it never balloons.
    private static func openLog() -> FileHandle? {
        let fileManager = FileManager.default
        let dir = fileManager.urls(for: .libraryDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Logs", isDirectory: true)
            .appendingPathComponent("Donkey", isDirectory: true)
        let file = dir.appendingPathComponent("cut-engine.log")
        try? fileManager.createDirectory(at: dir, withIntermediateDirectories: true)
        let size = (try? fileManager.attributesOfItem(atPath: file.path))?[.size] as? Int ?? 0
        if size > 5_000_000 { try? fileManager.removeItem(at: file) }
        if !fileManager.fileExists(atPath: file.path) {
            fileManager.createFile(atPath: file.path, contents: nil)
        }
        guard let handle = try? FileHandle(forWritingTo: file) else { return nil }
        handle.seekToEndOfFile()
        return handle
    }
}
