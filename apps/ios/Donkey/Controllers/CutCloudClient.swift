import AVFoundation
import DonkeyKitModels
import Foundation
import UIKit

/// The phone's HTTP client for the hosted Cut API (/api/cut-cloud/*). The
/// bearer session comes from the keychain, and every request carries the iOS
/// client header — the marker that links this account for the desktop's phone
/// features.
final class CutCloudClient: NSObject {
    private let base = AuthBackend.baseURL

    // MARK: Transport

    /// How many times one GET is asked for before the link is called broken.
    private static let attempts = 3

    /// The API's own session. A phone waits a bounded 20 seconds for an
    /// answer, and a whole call — retries included — is over inside a minute,
    /// so a screen waiting on it either draws or says why.
    private static let session: URLSession = {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 20
        config.timeoutIntervalForResource = 60
        config.waitsForConnectivity = false
        return URLSession(configuration: config)
    }()

    /// The network's verdict, read off the URL error it raised.
    private static func reach(for error: URLError) -> NetworkReach {
        switch error.code {
        case .notConnectedToInternet, .dataNotAllowed, .internationalRoamingOff:
            .offline
        case .timedOut:
            .timedOut
        case .networkConnectionLost, .cannotLoadFromNetwork, .secureConnectionFailed:
            .dropped
        default:
            .unreachable
        }
    }

    // MARK: Requests

    private var token: String? {
        KeychainStore.read(AuthController.tokenKey).flatMap { String(data: $0, encoding: .utf8) }
    }

    private func request(
        _ method: String,
        _ path: String,
        query: [URLQueryItem] = [],
        body: [String: Any]? = nil
    ) throws -> URLRequest {
        guard let token else { throw CloudSyncError.unauthorized }
        let url = base.appending(path: path)
        var request = URLRequest(url: query.isEmpty ? url : url.appending(queryItems: query))
        request.httpMethod = method
        // Reads speak for the account as it is right now — a project edited at
        // the desk a moment ago — so nothing answers them out of the URL cache.
        if method == "GET" { request.cachePolicy = .reloadIgnoringLocalCacheData }
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("ios", forHTTPHeaderField: "x-donkey-cut-client")
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        }
        return request
    }

    fileprivate func libraryMediaPath(_ fileName: String) -> String {
        "/api/cut-cloud/library/media/" + (fileName.addingPercentEncoding(
            withAllowedCharacters: .urlPathAllowed
        ) ?? fileName)
    }

    /// One answer from the API: its bytes and the status they came with.
    ///
    /// A phone's link drops connections on its own — the pooled socket dies
    /// while the app is in the background, the radio hands off between towers,
    /// a request outlives its window. A GET is safe to ask again, so it is
    /// asked again here, spaced out, and only a link that stays broken across
    /// every attempt reaches the caller. A cancelled task cancels: it is the
    /// screen going away, never a failure to report.
    private func perform(
        _ request: URLRequest,
        delegate: (any URLSessionTaskDelegate)? = nil
    ) async throws -> (Data, HTTPURLResponse) {
        let idempotent = request.httpMethod == "GET"
        var attempt = 0
        while true {
            do {
                let (data, response) = try await Self.session.data(for: request, delegate: delegate)
                guard let http = response as? HTTPURLResponse else { throw CloudSyncError.transport }
                return (data, http)
            } catch let error as URLError where error.code == .cancelled {
                throw CancellationError()
            } catch let error as URLError {
                let reach = Self.reach(for: error)
                attempt += 1
                guard idempotent, reach.isWorthAnotherTry, attempt < Self.attempts else {
                    throw CloudSyncError.unreachable(reach, code: error.errorCode)
                }
                try await Task.sleep(for: .milliseconds(300 << (attempt - 1)))
            }
        }
    }

    private func send(_ request: URLRequest) async throws -> Data {
        let (data, http) = try await perform(request)
        switch http.statusCode {
        case 200..<300: return data
        case 401, 403: throw CloudSyncError.unauthorized
        case 413: throw CloudSyncError.storageFull
        default: throw CloudSyncError.transport
        }
    }

    /// A send whose 4xx body is worth reading back to the user: the render cap
    /// and the storage quota both answer with a sentence written for a person.
    /// The body comes off the same answer, so a POST is sent once.
    private func sendReadingRefusal(_ request: URLRequest) async throws -> Data {
        struct Refusal: Decodable { var error: String? }
        let (data, http) = try await perform(request)
        switch http.statusCode {
        case 200..<300: return data
        // A signed-out answer is a session fact before it is a sentence. Every
        // handler writes one of these with an `error` body, so reading the body
        // first would hand the user the server's wording and leave the session
        // marked live, with nothing prompting a sign-in.
        case 401, 403: throw CloudSyncError.unauthorized
        case 400..<500:
            if let message = (try? JSONDecoder().decode(Refusal.self, from: data))?.error,
               !message.isEmpty {
                throw CloudSyncError.refused(message)
            }
            switch http.statusCode {
            case 413: throw CloudSyncError.storageFull
            default: throw CloudSyncError.transport
            }
        default: throw CloudSyncError.transport
        }
    }

    private func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        guard let value = try? JSONDecoder().decode(type, from: data) else {
            throw CloudSyncError.transport
        }
        return value
    }

    /// Follows the API's 302 by hand and hands back the CDN URL it points at,
    /// so AVPlayer streams the CDN directly.
    private func resolveRedirect(_ path: String) async throws -> URL {
        let request = try request("GET", path)
        let (_, http) = try await perform(request, delegate: RedirectCatcher())
        guard (300..<400).contains(http.statusCode),
              let location = http.value(forHTTPHeaderField: "Location"),
              let url = URL(string: location, relativeTo: base) else {
            throw CloudSyncError.transport
        }
        return url.absoluteURL
    }
}

// MARK: - Media up-sync

extension CutCloudClient: InspirationStreaming {
    /// The account's own copy, behind the API's redirect: an inspiration card
    /// streams the CDN directly and nothing is stored on the phone.
    func libraryMediaURL(fileName: String) async throws -> URL {
        try await resolveRedirect(libraryMediaPath(fileName))
    }
}

extension CutCloudClient: CloudSyncServicing {
    private struct PresignResponse: Decodable {
        var fileName: String
        var key: String
        var url: String?
        var done: Bool?
    }

    private struct AssetResponse: Decodable {
        var id: String
        var fileName: String
    }

    func uploadLibraryMedia(
        _ upload: LibraryUpload,
        progress: @escaping @Sendable (Double) -> Void
    ) async throws -> RemoteAsset {
        let presign = try await presignLibrary(
            fileName: upload.fileName,
            mime: upload.mime,
            bytes: upload.bytes,
            resume: upload.resume
        )
        if presign.done != true {
            guard let url = presign.url.flatMap(URL.init(string:)) else { throw CloudSyncError.transport }
            try await putFile(upload.fileURL, to: url, mime: upload.mime, progress: progress)
        }
        let posterKey: String? = if let poster = upload.poster {
            try? await uploadPoster(poster, besides: presign.fileName)
        } else {
            nil
        }
        // The row carries the footage's length and size: the desktop cuts
        // clips to them and sizes the card from them. A camera-roll import
        // arrives unmeasured, so the file itself answers here.
        let measured = await Self.measure(upload)
        var meta: [String: Any] = [
            "name": upload.name,
            "type": upload.type,
            "duration": measured.duration,
            "origin": upload.origin,
        ]
        if let width = measured.width, let height = measured.height {
            meta["width"] = width
            meta["height"] = height
        }
        var body: [String: Any] = ["key": presign.key, "meta": meta]
        if let posterKey { body["posterKey"] = posterKey }
        let data = try await send(
            try request("POST", "/api/cut-cloud/library/complete", body: body)
        )
        let asset = try decode(AssetResponse.self, from: data)
        progress(1)
        return RemoteAsset(id: asset.id, fileName: asset.fileName)
    }

    private func presignLibrary(
        fileName: String,
        mime: String,
        bytes: Int64,
        resume: Bool
    ) async throws -> PresignResponse {
        let data = try await send(
            try request(
                "POST",
                "/api/cut-cloud/library/presign",
                body: ["fileName": fileName, "mime": mime, "bytes": bytes, "resume": resume]
            )
        )
        return try decode(PresignResponse.self, from: data)
    }

    private struct Measured {
        var duration: TimeInterval
        var width: Int?
        var height: Int?
    }

    /// What the upload already says about its media, with the file filling in
    /// whatever is missing: a video's length and its displayed size (rotation
    /// applied), a photo's pixel size.
    private static func measure(_ upload: LibraryUpload) async -> Measured {
        var out = Measured(duration: upload.duration, width: upload.width, height: upload.height)
        let needsSize = out.width == nil || out.height == nil
        if upload.type == "video" {
            let asset = AVURLAsset(url: upload.fileURL)
            if out.duration <= 0,
               let seconds = try? await asset.load(.duration).seconds,
               seconds.isFinite, seconds > 0 {
                out.duration = seconds
            }
            if needsSize,
               let track = try? await asset.loadTracks(withMediaType: .video).first,
               let (natural, transform) = try? await track.load(.naturalSize, .preferredTransform) {
                let rect = CGRect(origin: .zero, size: natural).applying(transform)
                out.width = Int(abs(rect.width).rounded())
                out.height = Int(abs(rect.height).rounded())
            }
        } else if needsSize, let image = UIImage(contentsOfFile: upload.fileURL.localPath) {
            out.width = Int((image.size.width * image.scale).rounded())
            out.height = Int((image.size.height * image.scale).rounded())
        }
        return out
    }

    /// The recording's thumbnail goes up beside the movie so the desktop card
    /// paints without decoding video. Best-effort: the upload stands without it.
    private func uploadPoster(_ poster: Data, besides fileName: String) async throws -> String {
        let posterName = (fileName as NSString).deletingPathExtension + "-poster.jpg"
        let presign = try await presignLibrary(
            fileName: posterName,
            mime: "image/jpeg",
            bytes: Int64(poster.count),
            resume: true
        )
        if presign.done != true {
            guard let url = presign.url.flatMap(URL.init(string:)) else { throw CloudSyncError.transport }
            try await putData(poster, to: url, mime: "image/jpeg")
        }
        return presign.key
    }

    private func putFile(
        _ file: URL,
        to url: URL,
        mime: String,
        progress: @escaping @Sendable (Double) -> Void
    ) async throws {
        let response: URLResponse
        do {
            (_, response) = try await URLSession.shared.upload(
                for: putRequest(url, mime: mime),
                fromFile: file,
                delegate: UploadProgressDelegate(progress)
            )
        } catch {
            throw CloudSyncError.transport
        }
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw CloudSyncError.transport
        }
    }

    private func putData(_ data: Data, to url: URL, mime: String) async throws {
        let response: URLResponse
        do {
            (_, response) = try await URLSession.shared.upload(
                for: putRequest(url, mime: mime),
                from: data
            )
        } catch {
            throw CloudSyncError.transport
        }
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw CloudSyncError.transport
        }
    }

    private func putRequest(_ url: URL, mime: String) -> URLRequest {
        var request = URLRequest(url: url)
        request.httpMethod = "PUT"
        // The presigned URL is signed over this content type.
        request.setValue(mime, forHTTPHeaderField: "Content-Type")
        return request
    }

    func deleteLibraryAsset(id: String) async throws {
        _ = try await send(try request("DELETE", "/api/cut-cloud/library/\(id)"))
    }

    func fetchLibrary() async throws -> RemoteLibrary {
        struct LibraryResponse: Decodable {
            struct Asset: Decodable { var id: String }
            var assets: [Asset]
            var deletedAssetIds: [String]?
        }
        // `deleted=1` asks for the tombstoned ids: the phone mirrors the
        // shelf onto the Camera Roll, so a delete made on the desktop has to
        // reach it. No other client wants them.
        let data = try await send(
            try request(
                "GET",
                "/api/cut-cloud/library",
                query: [URLQueryItem(name: "deleted", value: "1")]
            )
        )
        let response = try decode(LibraryResponse.self, from: data)
        return RemoteLibrary(
            assetIds: Set(response.assets.map(\.id)),
            deletedIds: Set(response.deletedAssetIds ?? [])
        )
    }

    func importInspirationLink(_ url: URL) async throws -> String {
        struct QueuedJob: Decodable { var jobId: String }
        let data = try await send(
            try request(
                "POST",
                "/api/cut-cloud/library/import-url",
                body: ["url": url.absoluteString, "origin": "inspiration"]
            )
        )
        return try decode(QueuedJob.self, from: data).jobId
    }

    func importedLink(jobId: String) async throws -> LinkImport {
        struct JobStatus: Decodable {
            struct Result: Decodable {
                struct Asset: Decodable {
                    var id: String
                    var fileName: String
                    var type: String
                    var posterFile: String?
                    // The worker probes the media it fetched; the card takes
                    // its shape from this.
                    var width: Int?
                    var height: Int?
                }
                var assets: [Asset]?
                var text: String?
            }
            var state: String
            var result: Result?
            var error: String?
        }
        let data = try await send(try request("GET", "/api/cut-cloud/jobs/\(jobId)"))
        let status = try decode(JobStatus.self, from: data)
        switch status.state {
        case "queued", "running":
            return .running
        case "done":
            // A source that was only words brings back no media; the card
            // stays the link it was saved as, carrying what the source said.
            guard let asset = status.result?.assets?.first else {
                return .noMedia(text: status.result?.text)
            }
            return .ready(
                ImportedLink(
                    assetId: asset.id,
                    fileName: asset.fileName,
                    isVideo: asset.type == "video",
                    posterFile: asset.posterFile,
                    width: asset.width,
                    height: asset.height,
                    text: status.result?.text
                )
            )
        default:
            return .failed(status.error ?? "The fetch failed.")
        }
    }

    func downloadLibraryMedia(fileName: String, to destination: URL) async throws {
        let url = try await resolveRedirect(libraryMediaPath(fileName))
        let temporary: URL
        do {
            (temporary, _) = try await URLSession.shared.download(from: url)
        } catch {
            throw CloudSyncError.transport
        }
        try? FileManager.default.removeItem(at: destination)
        do {
            try FileManager.default.moveItem(at: temporary, to: destination)
        } catch {
            throw CloudSyncError.transport
        }
    }

    func fetchUsage() async throws -> StorageUsage {
        struct UsageResponse: Decodable {
            var bytes: Int64
            var quotaBytes: Int64?
        }
        let data = try await send(try request("GET", "/api/cut-cloud/usage"))
        let usage = try decode(UsageResponse.self, from: data)
        return StorageUsage(bytes: usage.bytes, quotaBytes: usage.quotaBytes)
    }

    // MARK: Notes

    private struct NoteDTO: Decodable {
        var id: String
        var title: String
        var body: String
        var colorIndex: Int
        var folderId: String?
        // Optional so a site from before labels still decodes.
        var labelIds: [String]?
        var updatedAt: Double
        var deletedAt: Double?
        var createdAt: Double
    }

    private struct NoteFolderDTO: Decodable {
        var id: String
        var name: String
        var parentId: String?
        var updatedAt: Double
        var createdAt: Double
    }

    private func remoteNote(_ dto: NoteDTO, id: UUID) -> RemoteNote {
        RemoteNote(
            id: id,
            title: dto.title,
            body: dto.body,
            colorIndex: dto.colorIndex,
            folderId: dto.folderId.flatMap(UUID.init(uuidString:)),
            labelIds: (dto.labelIds ?? []).compactMap(UUID.init(uuidString:)),
            updatedAt: Date(timeIntervalSince1970: dto.updatedAt / 1000),
            deletedAt: dto.deletedAt.map { Date(timeIntervalSince1970: $0 / 1000) },
            createdAt: Date(timeIntervalSince1970: dto.createdAt / 1000)
        )
    }

    func fetchNotes() async throws -> RemoteNotes {
        struct NotesResponse: Decodable {
            var notes: [NoteDTO]
            var folders: [NoteFolderDTO]?
            var labels: [NoteFolderDTO]?
        }
        let data = try await send(try request("GET", "/api/cut-cloud/notes"))
        let response = try decode(NotesResponse.self, from: data)
        return RemoteNotes(
            notes: response.notes.compactMap { dto in
                guard let id = UUID(uuidString: dto.id) else { return nil }
                return remoteNote(dto, id: id)
            },
            // Folders are keyed by the id whichever client made them chose,
            // and both clients mint UUIDs; anything else is not this phone's.
            // A missing key stays nil so the merge can tell it from "none".
            folders: response.folders?.compactMap { dto in
                guard let id = UUID(uuidString: dto.id) else { return nil }
                return RemoteNoteFolder(
                    id: id,
                    name: dto.name,
                    parentId: dto.parentId.flatMap(UUID.init(uuidString:)),
                    updatedAt: Date(timeIntervalSince1970: dto.updatedAt / 1000),
                    createdAt: Date(timeIntervalSince1970: dto.createdAt / 1000)
                )
            },
            // Labels ride the same wire shape as folders.
            labels: response.labels?.compactMap { dto in
                guard let id = UUID(uuidString: dto.id) else { return nil }
                return RemoteNoteLabel(
                    id: id,
                    name: dto.name,
                    updatedAt: Date(timeIntervalSince1970: dto.updatedAt / 1000),
                    createdAt: Date(timeIntervalSince1970: dto.createdAt / 1000)
                )
            }
        )
    }

    func putNote(_ note: RemoteNote) async throws -> RemoteNote {
        var body: [String: Any] = [
            "title": note.title,
            "body": note.body,
            "colorIndex": note.colorIndex,
            "labelIds": note.labelIds.map { $0.uuidString.lowercased() },
            "updatedAt": Int(note.updatedAt.timeIntervalSince1970 * 1000),
        ]
        body["folderId"] = note.folderId.map { $0.uuidString.lowercased() } ?? NSNull()
        let data = try await send(
            try request("PUT", "/api/cut-cloud/notes/\(note.id.uuidString.lowercased())", body: body)
        )
        return remoteNote(try decode(NoteDTO.self, from: data), id: note.id)
    }

    func deleteNote(id: UUID) async throws {
        _ = try await send(try request("DELETE", "/api/cut-cloud/notes/\(id.uuidString.lowercased())"))
    }

    func putNoteFolder(_ folder: RemoteNoteFolder) async throws {
        var body: [String: Any] = ["name": folder.name]
        body["parentId"] = folder.parentId.map { $0.uuidString.lowercased() } ?? NSNull()
        _ = try await send(
            try request(
                "PUT",
                "/api/cut-cloud/notes/folders/\(folder.id.uuidString.lowercased())",
                body: body
            )
        )
    }

    func deleteNoteFolder(id: UUID) async throws {
        _ = try await send(
            try request("DELETE", "/api/cut-cloud/notes/folders/\(id.uuidString.lowercased())")
        )
    }

    func putNoteLabel(_ label: RemoteNoteLabel) async throws {
        _ = try await send(
            try request(
                "PUT",
                "/api/cut-cloud/notes/labels/\(label.id.uuidString.lowercased())",
                body: ["name": label.name]
            )
        )
    }

    func deleteNoteLabel(id: UUID) async throws {
        _ = try await send(
            try request("DELETE", "/api/cut-cloud/notes/labels/\(id.uuidString.lowercased())")
        )
    }
}

// MARK: - Projects down-sync

extension CutCloudClient: CloudProjectsServicing {
    private struct ProjectDTO: Decodable {
        var id: String
        var name: String
        var duration: Double
        var updatedAt: Double
        var hasPreview: Bool?
        var previewFile: String?
        var previewIsImage: Bool?
        var previewStart: Double?
    }

    func fetchProjects() async throws -> [RemoteProject] {
        let data = try await send(try request("GET", "/api/cut-cloud/projects"))
        return try decode([ProjectDTO].self, from: data).map { dto in
            RemoteProject(
                id: dto.id,
                name: dto.name,
                duration: dto.duration,
                updatedAt: Date(timeIntervalSince1970: dto.updatedAt / 1000),
                hasPreview: dto.hasPreview ?? false,
                previewFile: dto.previewFile,
                previewIsImage: dto.previewIsImage ?? false,
                previewStart: dto.previewStart ?? 0
            )
        }
    }

    func fetchExports(projectId: String) async throws -> [RemoteExport] {
        struct ExportDTO: Decodable {
            var file: String
            var mtime: Double
        }
        let data = try await send(try request("GET", "/api/cut-cloud/projects/\(projectId)/exports"))
        return try decode([ExportDTO].self, from: data).map {
            RemoteExport(file: $0.file, modifiedAt: Date(timeIntervalSince1970: $0.mtime / 1000))
        }
    }

    func startExport(projectId: String, preset: String) async throws -> String {
        struct QueuedExport: Decodable { var id: String }
        let data = try await sendReadingRefusal(
            try request("POST", "/api/cut-cloud/projects/\(projectId)/export", body: ["preset": preset])
        )
        return try decode(QueuedExport.self, from: data).id
    }

    func exportProgress(jobId: String) async throws -> RenderProgress {
        struct ExportStatus: Decodable {
            var status: String
            var progress: Double?
            var error: String?
        }
        let data = try await send(try request("GET", "/api/cut-cloud/export/\(jobId)"))
        let status = try decode(ExportStatus.self, from: data)
        switch status.status {
        case "queued": return .queued
        case "running": return .running(min(1, max(0, status.progress ?? 0)))
        case "done": return .done
        default: return .failed(status.error ?? "The render didn't finish.")
        }
    }

    func exportFile(jobId: String) async throws -> URL {
        try await resolveRedirect("/api/cut-cloud/export/\(jobId)/file")
    }

    func streamURL(project: RemoteProject, export: RemoteExport?) async throws -> URL {
        if let export {
            return try await resolveRedirect("/api/cut-cloud/projects/\(project.id)/exports/\(export.file)")
        }
        guard project.hasPreview else { throw CloudSyncError.transport }
        return try await resolveRedirect("/api/cut-cloud/projects/\(project.id)/preview")
    }

    func thumbnailFile(for project: RemoteProject) async -> URL? {
        let directory = FileManager.default
            .urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appending(path: "ProjectThumbs")
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let stamp = Int(project.updatedAt.timeIntervalSince1970 * 1000)
        let file = directory.appending(path: "\(project.id)-\(stamp).jpg")
        if FileManager.default.fileExists(atPath: file.localPath) { return file }
        guard let image = await thumbnailImage(for: project),
              let data = image.jpegData(compressionQuality: 0.8) else { return nil }
        try? data.write(to: file, options: .atomic)
        // Versions of this project from before the edit leave once the new
        // poster is on disk, so a card never points at a file that is gone.
        let stale = (try? FileManager.default.contentsOfDirectory(atPath: directory.localPath))?
            .filter { $0.hasPrefix("\(project.id)-") && $0 != file.lastPathComponent } ?? []
        for name in stale {
            try? FileManager.default.removeItem(at: directory.appending(path: name))
        }
        return file
    }

    /// Only a poster rides the network: a still poster file as its own bytes,
    /// or one decoded frame of the composited preview / poster video.
    private func thumbnailImage(for project: RemoteProject) async -> UIImage? {
        if project.previewIsImage, let file = project.previewFile {
            guard let url = try? await resolveRedirect("/api/cut-cloud/projects/\(project.id)/media/\(file)"),
                  let (data, _) = try? await URLSession.shared.data(from: url) else { return nil }
            return UIImage(data: data)
        }
        let source: (path: String, at: TimeInterval)? = if project.hasPreview {
            ("/api/cut-cloud/projects/\(project.id)/preview", 0)
        } else if let file = project.previewFile {
            ("/api/cut-cloud/projects/\(project.id)/media/\(file)", project.previewStart)
        } else {
            nil
        }
        guard let source, let url = try? await resolveRedirect(source.path) else { return nil }
        let generator = AVAssetImageGenerator(asset: AVURLAsset(url: url))
        generator.appliesPreferredTrackTransform = true
        generator.maximumSize = CGSize(width: 720, height: 720)
        generator.requestedTimeToleranceAfter = CMTime(seconds: 1, preferredTimescale: 600)
        let time = CMTime(seconds: source.at, preferredTimescale: 600)
        guard let frame = try? await generator.image(at: time).image else { return nil }
        return UIImage(cgImage: frame)
    }
}

// MARK: - Analytics

extension CutCloudClient: AnalyticsServicing {
    /// The nightly analytics rollup. The API serves it to super users only,
    /// so a regular account reads as unauthorized here.
    func fetchAnalyticsRollup() async throws -> AnalyticsRollup {
        let (data, http) = try await perform(try request("GET", "/api/analytics/rollup"))
        switch http.statusCode {
        case 200..<300: break
        case 404: throw AnalyticsError.noRollup
        case 401, 403: throw CloudSyncError.unauthorized
        default: throw CloudSyncError.refused("The server answered \(http.statusCode).")
        }
        guard let rollup = try? JSONDecoder().decode(AnalyticsRollup.self, from: data) else {
            throw AnalyticsError.unreadable
        }
        return rollup
    }
}

// MARK: - Recording payloads

extension CutCloudClient {
    /// Everything an upload needs, read off the finished recording: bytes on
    /// disk, probed dimensions, and the stored thumbnail as the poster.
    static func uploadPayload(for recording: Recording, media: MediaModel) async -> LibraryUpload? {
        let fileURL = media.movieURL(for: recording)
        guard let size = fileURL.fileByteCount else { return nil }
        var width: Int?
        var height: Int?
        let asset = AVURLAsset(url: fileURL)
        if let track = try? await asset.loadTracks(withMediaType: .video).first,
           let (naturalSize, transform) = try? await track.load(.naturalSize, .preferredTransform) {
            let rect = CGRect(origin: .zero, size: naturalSize).applying(transform)
            width = Int(abs(rect.width).rounded())
            height = Int(abs(rect.height).rounded())
        }
        let poster = media.thumbnailURL(for: recording).flatMap { try? Data(contentsOf: $0) }
        return LibraryUpload(
            fileURL: fileURL,
            fileName: recording.fileName,
            mime: "video/quicktime",
            bytes: size,
            name: "Recording \(recording.createdAt.formatted(date: .abbreviated, time: .shortened))",
            type: "video",
            duration: recording.duration,
            width: width,
            height: height,
            origin: "camera",
            poster: poster
        )
    }
}

// MARK: - Session delegates

/// Reports PUT progress off the session's queue back to the caller.
private nonisolated final class UploadProgressDelegate: NSObject, URLSessionTaskDelegate {
    private let onProgress: @Sendable (Double) -> Void

    init(_ onProgress: @escaping @Sendable (Double) -> Void) {
        self.onProgress = onProgress
    }

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        didSendBodyData bytesSent: Int64,
        totalBytesSent: Int64,
        totalBytesExpectedToSend: Int64
    ) {
        guard totalBytesExpectedToSend > 0 else { return }
        onProgress(Double(totalBytesSent) / Double(totalBytesExpectedToSend))
    }
}

/// Stops the API's 302 so the Location header can be read.
private nonisolated final class RedirectCatcher: NSObject, URLSessionTaskDelegate {
    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        completionHandler(nil)
    }
}
