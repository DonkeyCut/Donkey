#if os(iOS)
import Foundation
import Network
import UIKit

/// The phone's end of the link to a Mac running Donkey: clips shot in the field
/// go straight to the Mac, with no Wi-Fi network, no router and no internet.
///
/// The transport is peer-to-peer Wi-Fi. `includePeerToPeer` browses the Bonjour
/// service over AWDL, the radio AirDrop uses, so the two devices find each other
/// on Bluetooth and then move the bytes at Wi-Fi speed. A minute of 4K is a few
/// hundred megabytes; Bluetooth alone would take the better part of an hour.
///
/// The link is a second way out of the library, beside the cloud queue the
/// SyncEngine drains. They are independent on purpose: a take goes to the Mac
/// the moment one is in range, and to the cloud the moment there is internet,
/// and neither waits for the other.

/// A Mac advertising the service, as the picker shows it.
nonisolated public struct PhoneLinkMac: Identifiable, Equatable, Sendable {
    public var id: String
    public var name: String
}

/// The Mac this phone is paired with. The token is what every later clip
/// carries; the Mac minted it when this phone answered its code.
nonisolated public struct PhoneLinkPairing: Equatable, Sendable, Codable {
    public var macName: String
    public var token: String
}

/// Where the pairing token is kept. The app target backs this with the keychain;
/// the package never reaches for one itself.
public protocol PhoneLinkTokenStoring: AnyObject, Sendable {
    func readPairing() -> PhoneLinkPairing?
    func writePairing(_ pairing: PhoneLinkPairing?)
}

nonisolated public enum PhoneLinkError: Error, Equatable, Sendable {
    case notPaired
    case macUnreachable
    /// The Mac answered, and said no.
    case refused(String)
    case fileUnreadable
}

@Observable
public final class PhoneLinkModel {
    /// The Macs in range right now, newest listing wins.
    public private(set) var macs: [PhoneLinkMac] = []
    /// The Mac this phone is paired with, or nil before anyone has paired.
    public private(set) var pairing: PhoneLinkPairing?
    /// The clip going over the link right now, 0…1, for the Library's badge.
    public private(set) var sending: (recordingId: UUID, progress: Double)?
    /// The last failure, for the pairing sheet to show.
    public private(set) var lastError: String?

    /// Recordings already handed to a Mac. Kept beside the cloud journal rather
    /// than in it: the two destinations are independent, and a clip that went
    /// over the link still owes the cloud a copy.
    @ObservationIgnored private var delivered: Set<UUID>
    /// Takes whose file could not be read this session. They stop being retried
    /// on every pass; a relaunch looks at them again, the way the cloud queue
    /// treats a clip it could not read.
    @ObservationIgnored private var skipped: Set<UUID> = []
    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private let tokens: any PhoneLinkTokenStoring
    @ObservationIgnored private var browser: NWBrowser?
    @ObservationIgnored private var endpoints: [String: NWEndpoint] = [:]
    @ObservationIgnored private var draining = false

    private static let deliveredKey = "phoneLinkDelivered"

    public init(tokens: any PhoneLinkTokenStoring, defaults: UserDefaults = .standard) {
        self.tokens = tokens
        self.defaults = defaults
        self.pairing = tokens.readPairing()
        let stored = defaults.stringArray(forKey: Self.deliveredKey) ?? []
        self.delivered = Set(stored.compactMap(UUID.init(uuidString:)))
    }

    public var isPaired: Bool { pairing != nil }

    /// Whether this clip has already reached a Mac — the Library's badge.
    public func wasDelivered(_ id: UUID) -> Bool { delivered.contains(id) }

    public func unpair() {
        pairing = nil
        tokens.writePairing(nil)
    }

    // MARK: Finding Macs

    /// Browse for Macs. The camera screen and the pairing sheet hold this open
    /// while they are up; nothing browses in the background, where AWDL costs
    /// battery for a screen nobody is looking at.
    public func startBrowsing() {
        guard browser == nil else { return }
        let parameters = NWParameters()
        parameters.includePeerToPeer = true
        let browser = NWBrowser(
            for: .bonjour(type: PhoneLinkWire.serviceType, domain: nil),
            using: parameters
        )
        browser.browseResultsChangedHandler = { [weak self] results, _ in
            Task { @MainActor [weak self] in self?.apply(results) }
        }
        browser.start(queue: .main)
        self.browser = browser
    }

    public func stopBrowsing() {
        browser?.cancel()
        browser = nil
    }

    private func apply(_ results: Set<NWBrowser.Result>) {
        var found: [PhoneLinkMac] = []
        var byId: [String: NWEndpoint] = [:]
        for result in results {
            guard case let .service(name, _, _, _) = result.endpoint else { continue }
            found.append(PhoneLinkMac(id: name, name: name))
            byId[name] = result.endpoint
        }
        endpoints = byId
        macs = found.sorted { $0.name < $1.name }
    }

    // MARK: Pairing

    /// Answer the code the Mac's settings page is showing. On success the Mac
    /// hands back the token this phone keeps.
    public func pair(with macId: String, code: String) async {
        lastError = nil
        guard let endpoint = endpoints[macId] else {
            lastError = "That Mac is out of range."
            return
        }
        let header = PhoneLinkWire.Header(
            kind: .pair,
            code: code.trimmingCharacters(in: .whitespaces),
            deviceName: UIDeviceName.current()
        )
        do {
            let reply = try await PhoneLinkSession(endpoint: endpoint).send(header: header)
            guard reply.ok, let token = reply.token else {
                lastError = reply.error ?? "That Mac would not pair."
                return
            }
            let pairing = PhoneLinkPairing(macName: macId, token: token)
            self.pairing = pairing
            tokens.writePairing(pairing)
        } catch {
            lastError = "That Mac did not answer."
        }
    }

    // MARK: Sending clips

    /// Hand every take the paired Mac has not seen to it, oldest first, while
    /// one is in range. Returns quietly when nothing is paired or nothing is in
    /// range — the clips stay queued for the next time the Mac is there.
    ///
    /// A verdict about one clip is about that clip: a take the Mac would not
    /// have, or one whose file this phone cannot read, is skipped so the ones
    /// behind it still go. Only losing the Mac ends the pass, because from
    /// there nothing else would go either.
    public func drain(_ media: MediaModel) async {
        guard let pairing, !draining else { return }
        guard let endpoint = endpoints[pairing.macName] else { return }
        draining = true
        defer { draining = false }

        for recording in media.recordings.sorted(by: { $0.createdAt < $1.createdAt }) {
            guard !delivered.contains(recording.id), !skipped.contains(recording.id) else { continue }
            do {
                try await send(recording, from: media, to: endpoint, token: pairing.token)
                markDelivered(recording.id)
            } catch PhoneLinkError.refused(let message) {
                // The Mac took a look and said no — sending it again would get
                // the same answer, so it stops being offered.
                lastError = message
                markDelivered(recording.id)
            } catch PhoneLinkError.fileUnreadable {
                skipped.insert(recording.id)
            } catch {
                // Out of range mid-drain: the rest waits for the next pass.
                return
            }
        }
    }

    private func send(
        _ recording: Recording,
        from media: MediaModel,
        to endpoint: NWEndpoint,
        token: String
    ) async throws {
        let url = media.movieURL(for: recording)
        guard let size = (try? FileManager.default.attributesOfItem(atPath: url.path)[.size]) as? Int,
              size > 0 else {
            throw PhoneLinkError.fileUnreadable
        }
        let header = PhoneLinkWire.Header(
            kind: .clip,
            token: token,
            takeId: recording.id.uuidString,
            fileName: recording.fileName,
            bytes: size,
            // Milliseconds: the engine stamps its own clips with Date.now(), and
            // the two have to be comparable when the editor sorts the inbox.
            capturedAt: recording.createdAt.timeIntervalSince1970 * 1000,
            durationSeconds: recording.duration
        )
        sending = (recording.id, 0)
        defer { sending = nil }

        let reply = try await PhoneLinkSession(endpoint: endpoint).send(
            header: header,
            file: url,
            bytes: size
        ) { [weak self] fraction in
            Task { @MainActor [weak self] in
                self?.sending = (recording.id, fraction)
            }
        }
        guard reply.ok else { throw PhoneLinkError.refused(reply.error ?? "That Mac would not take the clip.") }
    }

    private func markDelivered(_ id: UUID) {
        delivered.insert(id)
        defaults.set(delivered.map(\.uuidString), forKey: Self.deliveredKey)
    }
}

/// The name the Mac files this phone under.
enum UIDeviceName {
    static func current() -> String {
        UIDevice.current.name
    }
}

// MARK: - Wire

/// The frame format both ends speak: a 4-byte big-endian header length, that
/// many bytes of JSON, then the body the header declares. One shape for pairing
/// and for clips, so a clip streams through without either end holding it whole.
nonisolated enum PhoneLinkWire {
    static let serviceType = "_donkeycut._tcp"

    enum Kind: String, Encodable, Sendable {
        case pair
        case clip
    }

    struct Header: Encodable, Sendable {
        var kind: Kind
        var code: String?
        var deviceName: String?
        var token: String?
        /// The take this clip is, stable across re-sends. Delivery is
        /// at-least-once — the bytes can land on the Mac and the
        /// acknowledgement be lost on the way back — so the Mac needs a way to
        /// know a second arrival is the copy it already has.
        var takeId: String?
        var fileName: String?
        var bytes: Int?
        var capturedAt: Double?
        var durationSeconds: Double?
        var width: Int?
        var height: Int?
    }

    struct Reply: Decodable, Sendable {
        var ok: Bool
        var error: String?
        var token: String?
        var deviceId: String?
        var clipId: String?
    }

    static func frame(_ header: Header) throws -> Data {
        let json = try JSONEncoder().encode(header)
        var out = Data()
        var length = UInt32(json.count).bigEndian
        withUnsafeBytes(of: &length) { out.append(contentsOf: $0) }
        out.append(json)
        return out
    }
}

/// Fires once and tells the caller whether it was the one that fired it.
private nonisolated final class PhoneLinkLatch: @unchecked Sendable {
    private let lock = NSLock()
    private var fired = false

    func fire() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        if fired { return false }
        fired = true
        return true
    }
}

/// One conversation with a Mac: connect, send a frame, read the reply, hang up.
///
/// A clip is read off disk and sent a chunk at a time, each chunk waiting on the
/// last to go out, so the phone never holds a gigabyte take in memory and the
/// connection's own backpressure paces the shoot.
actor PhoneLinkSession {
    private let endpoint: NWEndpoint
    private static let chunkBytes = 512 * 1024
    /// The wait starts once the whole clip is across, so it covers the Mac
    /// moving the file into the inbox and nothing else. Long enough for a
    /// gigabyte take to land on a slow disk, short enough that a Mac that
    /// walked away is reported instead of hung on.
    private static let replyTimeout: Duration = .seconds(90)

    init(endpoint: NWEndpoint) {
        self.endpoint = endpoint
    }

    func send(
        header: PhoneLinkWire.Header,
        file: URL? = nil,
        bytes: Int = 0,
        progress: (@Sendable (Double) -> Void)? = nil
    ) async throws -> PhoneLinkWire.Reply {
        let parameters = NWParameters.tcp
        parameters.includePeerToPeer = true
        let connection = NWConnection(to: endpoint, using: parameters)
        defer { connection.cancel() }

        try await withCheckedThrowingContinuation { (done: CheckedContinuation<Void, Error>) in
            // Readiness and failure both arrive on the connection's own queue,
            // and a continuation may be resumed exactly once.
            let latch = PhoneLinkLatch()
            connection.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    if latch.fire() { done.resume() }
                case .failed, .cancelled:
                    if latch.fire() { done.resume(throwing: PhoneLinkError.macUnreachable) }
                default:
                    break
                }
            }
            connection.start(queue: .global(qos: .userInitiated))
        }

        try await write(connection, PhoneLinkWire.frame(header))

        if let file, bytes > 0 {
            let handle = try FileHandle(forReadingFrom: file)
            defer { try? handle.close() }
            var sent = 0
            while sent < bytes {
                let chunk = try handle.read(upToCount: Self.chunkBytes) ?? Data()
                if chunk.isEmpty { break }
                try await write(connection, chunk)
                sent += chunk.count
                progress?(Double(sent) / Double(bytes))
            }
        }

        return try await readReply(connection)
    }

    private func write(_ connection: NWConnection, _ data: Data) async throws {
        try await withCheckedThrowingContinuation { (done: CheckedContinuation<Void, Error>) in
            connection.send(content: data, completion: .contentProcessed { error in
                if error != nil {
                    done.resume(throwing: PhoneLinkError.macUnreachable)
                } else {
                    done.resume()
                }
            })
        }
    }

    /// Read the length prefix, then that many bytes of JSON.
    private func readReply(_ connection: NWConnection) async throws -> PhoneLinkWire.Reply {
        let lengthBytes = try await read(connection, exactly: 4)
        let length = Int(lengthBytes.reduce(UInt32(0)) { ($0 << 8) | UInt32($1) })
        guard length > 0, length <= 64 * 1024 else { throw PhoneLinkError.macUnreachable }
        let json = try await read(connection, exactly: length)
        guard let reply = try? JSONDecoder().decode(PhoneLinkWire.Reply.self, from: json) else {
            throw PhoneLinkError.macUnreachable
        }
        return reply
    }

    private func read(_ connection: NWConnection, exactly count: Int) async throws -> Data {
        try await withThrowingTaskGroup(of: Data.self) { group in
            group.addTask {
                try await withCheckedThrowingContinuation { (done: CheckedContinuation<Data, Error>) in
                    connection.receive(minimumIncompleteLength: count, maximumLength: count) {
                        data, _, _, error in
                        if let data, data.count == count, error == nil {
                            done.resume(returning: data)
                        } else {
                            done.resume(throwing: PhoneLinkError.macUnreachable)
                        }
                    }
                }
            }
            group.addTask {
                try await Task.sleep(for: Self.replyTimeout)
                throw PhoneLinkError.macUnreachable
            }
            guard let first = try await group.next() else { throw PhoneLinkError.macUnreachable }
            group.cancelAll()
            return first
        }
    }
}
#endif
