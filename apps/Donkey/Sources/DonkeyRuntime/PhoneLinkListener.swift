import Foundation
import Network

/// The Mac's end of the phone link: an iPhone shooting in the field hands its
/// clips straight to this Mac, with no Wi-Fi network, no router and no internet
/// between them.
///
/// The transport is peer-to-peer Wi-Fi. `includePeerToPeer` puts the Bonjour
/// service on AWDL, the same radio AirDrop uses, so the phone finds this Mac
/// over Bluetooth discovery and then moves the bytes at Wi-Fi speed. Bluetooth
/// alone is three orders of magnitude too slow for a 4K take, and it is only
/// ever the introduction here.
///
/// This listener is a pipe. It terminates the peer connection and forwards to
/// the Cut engine on loopback, which owns pairing and the inbox. The engine
/// stays bound to 127.0.0.1 — the phone never sees the port, and the only thing
/// on the wire is this service.
///
/// The one thing it decides for itself is whether to spend disk on a sender: a
/// clip's bytes come off an open radio, so the token is checked with the engine
/// when the header arrives and before the first byte is written.
public final class PhoneLinkListener: @unchecked Sendable {
    /// The Bonjour service the phone browses for. Peer-to-peer, so it is
    /// advertised on AWDL as well as on any network this Mac happens to be on.
    public static let serviceType = "_donkeycut._tcp"

    /// All mutable state is confined to this queue.
    private let queue = DispatchQueue(label: "donkey.phone-link")
    private var listener: NWListener?
    private var connections: [ObjectIdentifier: PhoneLinkConnection] = [:]
    private var stopped = false
    /// Off console this session has no engine of its own, so it advertises
    /// nothing: a listener running here would hand another macOS user's engine
    /// this session's clips.
    private var suspended = false
    /// How long to wait before listening again after a failure. A denied local
    /// network permission fails every attempt, and retrying it flat out burns a
    /// core for the life of the app.
    private var retryDelay: TimeInterval = 2

    private let enginePort: Int

    public init(enginePort: Int) {
        self.enginePort = enginePort
    }

    public func start() {
        queue.async { self.listenIfNeeded() }
    }

    public func stop() {
        queue.sync {
            stopped = true
            listener?.cancel()
            listener = nil
            for connection in connections.values { connection.cancel() }
            connections.removeAll()
        }
    }

    /// Follows console ownership the way the engine supervisor does.
    public func setSessionActive(_ active: Bool) {
        queue.async {
            guard self.suspended == active else { return }
            self.suspended = !active
            if active {
                self.retryDelay = 2
                self.listenIfNeeded()
            } else {
                self.listener?.cancel()
                self.listener = nil
            }
        }
    }

    private func listenIfNeeded() {
        guard !stopped, !suspended, listener == nil else { return }

        let parameters = NWParameters.tcp
        parameters.includePeerToPeer = true

        guard let listener = try? NWListener(using: parameters) else {
            scheduleRetry()
            return
        }
        // No name of our own: Bonjour advertises under the Mac's sharing name,
        // which is what the phone shows in its picker, so a person with two
        // Macs picks the right one without naming anything here.
        listener.service = NWListener.Service(type: Self.serviceType)
        listener.newConnectionHandler = { [weak self] connection in
            self?.accept(connection)
        }
        listener.stateUpdateHandler = { [weak self] state in
            guard let self else { return }
            switch state {
            case .ready:
                self.queue.async { self.retryDelay = 2 }
            case .failed:
                self.queue.async {
                    self.listener?.cancel()
                    self.listener = nil
                    self.scheduleRetry()
                }
            default:
                break
            }
        }
        listener.start(queue: queue)
        self.listener = listener
    }

    private func scheduleRetry() {
        guard !stopped, !suspended else { return }
        let delay = retryDelay
        retryDelay = min(retryDelay * 2, 300)
        queue.asyncAfter(deadline: .now() + delay) { [weak self] in
            self?.listenIfNeeded()
        }
    }

    private func accept(_ connection: NWConnection) {
        queue.async {
            guard !self.stopped, !self.suspended else {
                connection.cancel()
                return
            }
            let peer = PhoneLinkConnection(
                connection: connection,
                enginePort: self.enginePort,
                queue: self.queue
            ) { [weak self] key in
                guard let self else { return }
                self.queue.async { self.connections.removeValue(forKey: key) }
            }
            self.connections[ObjectIdentifier(peer)] = peer
            peer.start()
        }
    }
}

/// One phone's connection, for as long as it lasts.
///
/// The wire format is a 4-byte big-endian header length, that many bytes of
/// JSON, then the body the header declares — so a clip streams through without
/// either end holding it whole. Replies are the same header frame with no body.
final class PhoneLinkConnection: @unchecked Sendable {
    private let connection: NWConnection
    private let enginePort: Int
    private let queue: DispatchQueue
    private let onFinish: @Sendable (ObjectIdentifier) -> Void

    /// Bytes read off the wire and not yet consumed by a frame.
    private var buffer = Data()
    /// The header of the frame being read, once its length prefix has landed.
    private var header: PhoneLinkHeader?
    /// What the bytes after the current header are for.
    private var body: Body = .none
    /// The upload whose completion has not run yet. The drain loop hands an
    /// upload off before the engine answers, and dropping the last reference
    /// there would leave its staged file on the disk forever.
    private var finishing: [ObjectIdentifier: PhoneLinkUpload] = [:]

    /// A clip's body, from the header to the last byte of it.
    ///
    /// `waiting` is the pause while the engine says whether this phone is
    /// paired. The buffer is not touched during it: the bytes arriving are the
    /// clip's, and whether they are written or thrown away is exactly what the
    /// answer decides.
    private enum Body {
        case none
        case waiting(bytes: Int)
        case writing(PhoneLinkUpload)
        case discarding(Int)
    }

    /// A header is small by construction; anything larger is not our protocol.
    private static let maxHeaderBytes = 64 * 1024
    /// The largest clip this Mac will stage. An hour of 4K is well inside it,
    /// and an unpaired sender on an open radio cannot name a bigger number to
    /// spend the disk on.
    private static let maxClipBytes = 32 * 1024 * 1024 * 1024

    init(
        connection: NWConnection,
        enginePort: Int,
        queue: DispatchQueue,
        onFinish: @escaping @Sendable (ObjectIdentifier) -> Void
    ) {
        self.connection = connection
        self.enginePort = enginePort
        self.queue = queue
        self.onFinish = onFinish
    }

    func start() {
        connection.stateUpdateHandler = { [weak self] state in
            switch state {
            case .failed, .cancelled:
                guard let self else { return }
                self.queue.async { self.finish() }
            default:
                break
            }
        }
        connection.start(queue: queue)
        receive()
    }

    func cancel() {
        connection.cancel()
    }

    private func finish() {
        if case let .writing(upload) = body { upload.abort() }
        body = .none
        onFinish(ObjectIdentifier(self))
    }

    private func receive() {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 256 * 1024) {
            [weak self] data, _, isComplete, error in
            guard let self else { return }
            if let data, !data.isEmpty {
                self.buffer.append(data)
                self.drain()
            }
            if error != nil || isComplete {
                self.connection.cancel()
                return
            }
            self.receive()
        }
    }

    /// Consume whatever complete frames the buffer now holds.
    private func drain() {
        while true {
            switch body {
            case .waiting:
                // The engine has not said yet whether this phone is paired.
                return

            case let .discarding(left):
                guard !buffer.isEmpty else { return }
                let dropped = min(left, buffer.count)
                buffer.removeFirst(dropped)
                body = left - dropped > 0 ? .discarding(left - dropped) : .none
                continue

            case let .writing(upload):
                guard !buffer.isEmpty else { return }
                let wanted = min(upload.remaining, buffer.count)
                let written = upload.write(buffer.prefix(wanted))
                buffer.removeFirst(wanted)
                if !written {
                    // The disk said no. Nothing about this clip counts as
                    // delivered — the phone has to keep its copy.
                    body = upload.remaining > 0 ? .discarding(upload.remaining) : .none
                    upload.abort()
                    send(PhoneLinkReply(ok: false, error: "This Mac could not write that clip."))
                    continue
                }
                if upload.remaining == 0 {
                    body = .none
                    hold(upload)
                }
                continue

            case .none:
                break
            }

            if header == nil {
                guard buffer.count >= 4 else { return }
                let length = Int(
                    buffer.prefix(4).reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
                )
                guard length > 0, length <= Self.maxHeaderBytes else {
                    connection.cancel()
                    return
                }
                guard buffer.count >= 4 + length else { return }
                buffer.removeFirst(4)
                let json = buffer.prefix(length)
                buffer.removeFirst(length)
                guard let parsed = try? JSONDecoder().decode(PhoneLinkHeader.self, from: json) else {
                    connection.cancel()
                    return
                }
                header = parsed
            }

            guard let header else { return }
            self.header = nil
            handle(header)
        }
    }

    private func handle(_ header: PhoneLinkHeader) {
        switch header.kind {
        case .pair:
            PhoneLinkEngine(port: enginePort).pair(
                code: header.code ?? "",
                deviceName: header.deviceName ?? "iPhone"
            ) { [weak self] reply in
                self?.send(reply)
            }
        case .clip:
            guard let bytes = header.bytes, bytes > 0, bytes <= Self.maxClipBytes else {
                send(PhoneLinkReply(ok: false, error: "That clip is not a size this Mac takes."))
                connection.cancel()
                return
            }
            guard header.takeId?.isEmpty == false else {
                send(PhoneLinkReply(ok: false, error: "That clip did not say which take it is."))
                connection.cancel()
                return
            }
            // The bytes are about to be written to this Mac's disk, so the
            // sender is checked first and the body waits in the buffer for the
            // answer. An unpaired sender on an open radio gets its frame read
            // and thrown away rather than staged.
            body = .waiting(bytes: bytes)
            PhoneLinkEngine(port: enginePort).verify(token: header.token ?? "") { [weak self] paired in
                guard let self else { return }
                self.queue.async {
                    guard case .waiting = self.body else { return }
                    if paired {
                        self.body = .writing(PhoneLinkUpload(
                            header: header,
                            total: bytes,
                            enginePort: self.enginePort
                        ))
                    } else {
                        self.body = .discarding(bytes)
                        self.send(PhoneLinkReply(
                            ok: false,
                            error: "This phone is not paired with this Mac."
                        ))
                    }
                    self.drain()
                }
            }
        }
    }

    /// Keep an upload alive across the engine hop, so its completion — the only
    /// thing that clears the staged file when the engine refuses — still has an
    /// object to run on.
    private func hold(_ upload: PhoneLinkUpload) {
        let key = ObjectIdentifier(upload)
        finishing[key] = upload
        upload.finish { [weak self] reply in
            guard let self else { return }
            self.queue.async { self.finishing.removeValue(forKey: key) }
            self.send(reply)
        }
    }

    private func send(_ reply: PhoneLinkReply) {
        guard let data = try? JSONEncoder().encode(reply) else { return }
        var frame = Data()
        var length = UInt32(data.count).bigEndian
        withUnsafeBytes(of: &length) { frame.append(contentsOf: $0) }
        frame.append(data)
        connection.send(content: frame, completion: .idempotent)
    }
}

/// The header on every frame a phone sends.
struct PhoneLinkHeader: Decodable, Sendable {
    enum Kind: String, Decodable {
        case pair
        case clip
    }

    var kind: Kind
    // pair
    var code: String?
    var deviceName: String?
    // clip
    var token: String?
    /// The take's id on the phone, stable across re-sends, so a clip whose
    /// acknowledgement was lost is recognised rather than stored twice.
    var takeId: String?
    var fileName: String?
    var bytes: Int?
    var capturedAt: Double?
    var durationSeconds: Double?
    var width: Int?
    var height: Int?
}

/// What the Mac answers with. `token` is present only on a successful pair.
struct PhoneLinkReply: Encodable, Sendable {
    var ok: Bool
    var error: String?
    var token: String?
    var deviceId: String?
    var clipId: String?
}

/// One clip in flight: the bytes go to a temp file as they arrive, and once the
/// phone has sent all of them the engine is told where that file is. It moves
/// the file into the inbox rather than taking a second copy through loopback,
/// which for a gigabyte take is the difference between instant and a wait. A
/// dropped connection leaves nothing half-landed in the inbox.
final class PhoneLinkUpload: @unchecked Sendable {
    private let header: PhoneLinkHeader
    private let enginePort: Int
    private let url: URL
    private var handle: FileHandle?
    private(set) var remaining: Int
    /// What the header said the clip weighs, checked against what arrived — a
    /// short write reported as a delivery is a take the phone stops offering.
    private let declared: Int

    init(header: PhoneLinkHeader, total: Int, enginePort: Int) {
        self.header = header
        self.enginePort = enginePort
        self.remaining = total
        self.declared = total
        self.url = FileManager.default.temporaryDirectory
            .appendingPathComponent("donkey-phone-\(UUID().uuidString)")
        FileManager.default.createFile(atPath: url.path, contents: nil)
        self.handle = try? FileHandle(forWritingTo: url)
    }

    /// False when the bytes did not reach the disk, which fails the clip.
    func write(_ bytes: Data) -> Bool {
        guard let handle else { return false }
        do {
            try handle.write(contentsOf: bytes)
        } catch {
            return false
        }
        remaining -= bytes.count
        return true
    }

    func abort() {
        try? handle?.close()
        handle = nil
        try? FileManager.default.removeItem(at: url)
    }

    func finish(reply: @escaping @Sendable (PhoneLinkReply) -> Void) {
        try? handle?.close()
        handle = nil

        let landed = (try? FileManager.default.attributesOfItem(atPath: url.path)[.size]) as? Int
        guard landed == declared else {
            abort()
            reply(PhoneLinkReply(ok: false, error: "That clip did not arrive whole."))
            return
        }

        PhoneLinkEngine(port: enginePort).sendClip(header: header, file: url) { [weak self] result in
            // The engine consumes the staged file on success; on failure it is
            // still here and this is what clears it.
            if !result.ok { self?.abort() }
            reply(result)
        }
    }
}

/// The loopback hop: this listener's only contact with the engine.
struct PhoneLinkEngine: Sendable {
    let port: Int

    private var base: URL {
        URL(string: "http://127.0.0.1:\(port)")!
    }

    func pair(code: String, deviceName: String, reply: @escaping @Sendable (PhoneLinkReply) -> Void) {
        var request = URLRequest(url: base.appending(path: "/api/cut/phone/pair/claim"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(
            withJSONObject: ["code": code, "deviceName": deviceName]
        )
        URLSession.shared.dataTask(with: request) { data, response, _ in
            guard
                let data,
                (response as? HTTPURLResponse)?.statusCode == 200,
                let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                let token = body["token"] as? String
            else {
                reply(PhoneLinkReply(ok: false, error: "That code is not open on this Mac."))
                return
            }
            let device = body["device"] as? [String: Any]
            reply(PhoneLinkReply(
                ok: true,
                token: token,
                deviceId: device?["id"] as? String
            ))
        }.resume()
    }

    /// Is this phone paired? Asked before a clip's bytes are written, so an
    /// unpaired sender cannot spend this Mac's disk on the way to a refusal.
    func verify(token: String, reply: @escaping @Sendable (Bool) -> Void) {
        var request = URLRequest(url: base.appending(path: "/api/cut/phone/verify"))
        request.httpMethod = "POST"
        request.setValue(token, forHTTPHeaderField: "x-donkey-phone-token")
        URLSession.shared.dataTask(with: request) { _, response, _ in
            reply((response as? HTTPURLResponse)?.statusCode == 200)
        }.resume()
    }

    func sendClip(header: PhoneLinkHeader, file: URL, reply: @escaping @Sendable (PhoneLinkReply) -> Void) {
        var items = [
            URLQueryItem(name: "fileName", value: header.fileName ?? "clip.mov"),
            URLQueryItem(name: "takeId", value: header.takeId ?? ""),
        ]
        if let captured = header.capturedAt {
            items.append(URLQueryItem(name: "capturedAt", value: String(Int(captured))))
        }
        if let duration = header.durationSeconds {
            items.append(URLQueryItem(name: "durationSeconds", value: String(duration)))
        }
        if let width = header.width { items.append(URLQueryItem(name: "width", value: String(width))) }
        if let height = header.height { items.append(URLQueryItem(name: "height", value: String(height))) }

        var request = URLRequest(url: base.appending(path: "/api/cut/phone/clips").appending(queryItems: items))
        request.httpMethod = "POST"
        request.setValue(header.token ?? "", forHTTPHeaderField: "x-donkey-phone-token")
        // The clip is already on this Mac's disk, staged as it came off the
        // radio. The engine is told where, and moves it; nothing streams twice.
        request.setValue(file.path, forHTTPHeaderField: "x-donkey-phone-file")
        URLSession.shared.dataTask(with: request) { data, response, _ in
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            guard status == 200, let data else {
                reply(PhoneLinkReply(
                    ok: false,
                    error: status == 401
                        ? "This phone is no longer paired with this Mac."
                        : "This Mac could not take that clip."
                ))
                return
            }
            let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            reply(PhoneLinkReply(ok: true, clipId: body?["id"] as? String))
        }.resume()
    }
}
