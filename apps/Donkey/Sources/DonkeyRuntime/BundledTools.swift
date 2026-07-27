import Foundation

/// The prebuilt CLI tools (ffmpeg, ffprobe, yt-dlp) the Cut engine runs by bare name.
///
/// They ship inside the app: `Donkey.app/Contents/Resources/donkey-tools`, staged at packaging time by
/// scripts/package-donkey-app.sh. Being part of the app means they are there the moment it is — no
/// first-run download to race, nothing to retry on a bad network, and no dependence on what the user
/// happens to have installed. A dev build symlinks that same path at the repo's `vendor/donkey-tools`,
/// so a source checkout and a shipped app resolve identically.
public enum BundledTools {
    /// Bare executable names of the tools shipped in the bundle. Donkey resolves these from
    /// `resolvedDirectory()`, which `childEnvironment()` puts on PATH, so they run by bare name. This is
    /// the single Swift home for the list; keep it in step with the fetch/ensure scripts when the bundle
    /// gains or drops a tool.
    ///
    /// ffmpeg and ffprobe sit behind every export, probe, and frame extract; yt-dlp behind URL import.
    public static let executableNames: Set<String> = [
        "ffmpeg", "ffprobe", "yt-dlp"
    ]

    /// Tools that unpack a private interpreter/runtime to a temp dir at launch and `dlopen()` it — a
    /// PyInstaller onefile binary like `yt-dlp`. Under the hardened runtime, library validation rejects
    /// that load when the extracted framework's Team ID differs from the binary's ("different Team IDs"),
    /// so a copy signed with the runtime flag but no exception cannot start at all. These need the
    /// `com.apple.security.cs.disable-library-validation` entitlement; `scripts/sign-bundled-tools.sh`
    /// signs exactly these with it, both when the bundle is built and when packaging bakes it into the
    /// app. Keep this list in step with that script.
    public static let selfExtractingExecutableNames: Set<String> = ["yt-dlp"]

    /// The app's own tools directory — the baked copy in a packaged build, a symlink to the repo's
    /// vendor directory in a dev build. Nil only where there is no app bundle to read (a unit-test
    /// runner, where `Bundle.main` is the test binary).
    public static var appDirectory: URL? {
        Bundle.main.resourceURL?.appendingPathComponent("donkey-tools", isDirectory: true)
    }

    /// The tools directory this process should use, or nil when it has none.
    ///
    /// `DONKEY_TOOLS_DIR` comes first, and is what lets a test or eval process — where `Bundle.main` is
    /// the test runner, so the app path never resolves — point at the repo's `vendor/donkey-tools` and
    /// run the same bundled binaries as production. It mirrors the
    /// build-time `DONKEY_TOOLS_DIR` convention in `ensure-bundled-tools.sh`.
    public static func resolvedDirectory() -> URL? {
        // Read live via getenv: `ProcessInfo.processInfo.environment` is a process-start snapshot, so a
        // test or eval that `setenv`s this after launch would otherwise not be seen.
        if let raw = getenv("DONKEY_TOOLS_DIR") {
            let override = String(cString: raw)
            if !override.isEmpty {
                let dir = URL(fileURLWithPath: (override as NSString).expandingTildeInPath, isDirectory: true)
                if FileManager.default.fileExists(atPath: dir.path) {
                    return dir
                }
            }
        }
        guard let app = appDirectory, FileManager.default.fileExists(atPath: app.path) else { return nil }
        return app
    }

    /// Whether a directory really holds the tools. ffmpeg is in every bundle, so its presence is the
    /// cheapest "are the tools really here" check.
    public static func hasTools(at directory: URL) -> Bool {
        FileManager.default.isExecutableFile(atPath: directory.appendingPathComponent("ffmpeg").path)
    }

    /// The environment for a child process that runs the bundled tools — today, the Cut engine.
    ///
    /// PATH is `<bundled tools dir> : <login-shell PATH>`. The bundled dir is PREPENDED so the app's
    /// curated, signed copy always wins over whatever the user happens to have installed: an export
    /// behaves identically on every machine instead of silently deferring to a stripped or incompatible
    /// build. A GUI-launched app inherits only launchd's bare PATH, so the login-shell PATH follows to
    /// keep the user's own tools resolvable.
    public static func childEnvironment() -> [String: String] {
        var environment = ProcessInfo.processInfo.environment
        var segments: [String] = []
        if let toolsDirectory = resolvedDirectory() {
            segments.append(toolsDirectory.path)
        }
        segments.append(loginShellPath)
        environment["PATH"] = segments.joined(separator: ":")
        return environment
    }

    /// The PATH the user's interactive shell would have, resolved once. Asking the login shell
    /// (`$SHELL -lc …`) runs their `.zprofile`/`.zshrc`, so the result includes `/opt/homebrew/bin`,
    /// `~/.local/bin`, language version managers, and anything else they rely on. Cached: it is stable
    /// for the process lifetime and spawning a login shell is not free.
    private static let loginShellPath: String = resolveLoginShellPath()

    /// Covers both Homebrew prefixes, used when the login shell can't be queried so the child still gets
    /// a useful PATH rather than launchd's bare minimum.
    private static let fallbackShellPath =
        "/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

    private static func resolveLoginShellPath() -> String {
        let shell = ProcessInfo.processInfo.environment["SHELL"] ?? "/bin/zsh"
        // Markers fence the value so output printed by the user's rc files (version-manager banners,
        // etc.) can't contaminate the PATH we extract.
        let start = "__DONKEY_PATH_START__"
        let end = "__DONKEY_PATH_END__"
        let process = Process()
        process.executableURL = URL(fileURLWithPath: shell)
        process.arguments = ["-lc", "printf '%s%s%s' '\(start)' \"$PATH\" '\(end)'"]
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice

        let finished = DispatchSemaphore(value: 0)
        process.terminationHandler = { _ in finished.signal() }
        do {
            try process.run()
        } catch {
            return fallbackShellPath
        }
        // Bound it: a login shell normally exits in well under a second, but a pathological profile
        // must not hang app launch forever.
        if finished.wait(timeout: .now() + 5.0) == .timedOut {
            process.terminate()
            return fallbackShellPath
        }

        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        guard
            let output = String(data: data, encoding: .utf8),
            let lower = output.range(of: start),
            let upper = output.range(of: end)
        else {
            return fallbackShellPath
        }
        let resolved = String(output[lower.upperBound..<upper.lowerBound])
        return resolved.isEmpty ? fallbackShellPath : resolved
    }
}
