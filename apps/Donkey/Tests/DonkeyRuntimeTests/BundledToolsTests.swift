import DonkeyRuntime
import Foundation
import Testing

/// The bundled CLI tools ship inside the app, so resolution is a path question, not an install question:
/// an explicit `DONKEY_TOOLS_DIR` (how a test process points at the repo's vendor copy) wins, otherwise
/// the app's own `Resources/donkey-tools`. These lock that order and the "are the tools really here" check.
@Suite
struct BundledToolsTests {
    @Test
    func overrideWinsAndMustExist() {
        let real = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
            .appendingPathComponent("donkey-tools-test-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: real, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: real) }

        setenv("DONKEY_TOOLS_DIR", real.path, 1)
        #expect(BundledTools.resolvedDirectory()?.path == real.path)

        // A path that doesn't exist is not a usable override: resolution falls through to the app copy
        // (nil in a test runner, whose Bundle.main is the test binary) rather than handing back a
        // directory nothing can run from.
        setenv("DONKEY_TOOLS_DIR", real.path + "-gone", 1)
        #expect(BundledTools.resolvedDirectory()?.path != real.path + "-gone")

        // An empty override reads as unset.
        setenv("DONKEY_TOOLS_DIR", "", 1)
        #expect(BundledTools.resolvedDirectory()?.path != "")
        unsetenv("DONKEY_TOOLS_DIR")
    }

    @Test
    func toolsPresenceIsDecidedByFfmpeg() {
        let dir = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
            .appendingPathComponent("donkey-tools-test-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }

        #expect(!BundledTools.hasTools(at: dir))
        let ffmpeg = dir.appendingPathComponent("ffmpeg")
        FileManager.default.createFile(atPath: ffmpeg.path, contents: Data("#!/bin/sh\n".utf8))
        try? FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: ffmpeg.path)
        #expect(BundledTools.hasTools(at: dir))
    }

    @Test
    func everySelfExtractingToolIsAlsoABundledTool() {
        // The library-validation exception list names tools the bundle actually ships; a name that drifted
        // out of `executableNames` would be signed for nothing.
        #expect(BundledTools.selfExtractingExecutableNames.isSubset(of: BundledTools.executableNames))
    }

    @Test
    func theMediaToolsExportsDependOnAreDeclared() {
        // Cut's export and probe paths run these by bare name off the PATH built from the tools directory.
        #expect(BundledTools.executableNames.contains("ffmpeg"))
        #expect(BundledTools.executableNames.contains("ffprobe"))
    }

    @Test
    func theSwiftListMatchesWhatTheBuildStages() throws {
        // Two lists name the shipped tools: this one, and REQUIRED_TOOLS in
        // scripts/ensure-bundled-tools.sh (which packaging validates the baked app against). They
        // have to agree — a tool in only one of them either ships unannounced or is declared and
        // never staged. Read the script's own `--list` output rather than re-typing the names.
        let repoRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()  // DonkeyRuntimeTests
            .deletingLastPathComponent()  // Tests
            .deletingLastPathComponent()  // Donkey
            .deletingLastPathComponent()  // apps
            .deletingLastPathComponent()  // <repo root>
        let script = repoRoot.appendingPathComponent("scripts/ensure-bundled-tools.sh")
        try #require(FileManager.default.isReadableFile(atPath: script.path))

        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/bash")
        process.arguments = [script.path, "--list"]
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        try process.run()
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()

        let staged = Set(
            (String(data: data, encoding: .utf8) ?? "")
                .split(whereSeparator: \.isNewline)
                .map { $0.trimmingCharacters(in: .whitespaces) }
                .filter { !$0.isEmpty }
        )
        #expect(staged == BundledTools.executableNames)
    }
}
